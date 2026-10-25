import { accessSync, chmodSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { CommandOutput } from "./commandRunner.ts";
import { checkedConnectorTool, type ConnectorContext, type ConnectorTool } from "./connectorTools.ts";
import { classifyGh, ghCommandLine, GhRefused, GH_MAX_ARG_LENGTH, GH_MAX_ARGS, type GhCall } from "./githubPolicy.ts";
import { HttpError } from "./httpError.ts";
import { checkedDisplay, ghDisplay } from "./outwardDisplay.ts";
import { parseOr400 } from "./taskCore.ts";
import { UnsafeContentError, wrapUntrusted } from "./trust.ts";

export const GH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] as const;
export const GH_SOURCE = "From GitHub (external)";
export const GH_TIMEOUT_MS = 60_000;
export const GH_OUTPUT_BYTES = 30 * 1024;

const PASSED_ENV: ReadonlySet<string> = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR"]);
const LOCALE = /^LC_[A-Z_]+$/;
const FIXED_ENV = {
  GH_HOST: "github.com",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
} as const;

const input = z.object({ args: z.array(z.string().max(GH_MAX_ARG_LENGTH)).min(1).max(GH_MAX_ARGS) }).strict();

export interface GithubToolDeps {
  findGh?: () => string | null;
  env?: NodeJS.ProcessEnv;
  tmpRoot?: () => string;
}

export function findGh(): string | null {
  for (const dir of GH_DIRS) {
    const candidate = join(dir, "gh");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function ghEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept = Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && (PASSED_ENV.has(entry[0]) || LOCALE.test(entry[0])));
  return { ...Object.fromEntries(kept), ...FIXED_ENV };
}

function capped(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= GH_OUTPUT_BYTES ? text : bytes.subarray(0, GH_OUTPUT_BYTES).toString("utf8");
}

function statusLine(output: CommandOutput): string {
  if (output.timedOut) return `gh timed out after ${GH_TIMEOUT_MS / 1000} s.`;
  if (output.overflowed) return `gh's output passed ${GH_OUTPUT_BYTES / 1024} kB, so Hive cut it there.`;
  return `gh exited with code ${output.code}.`;
}

export function ghReport(output: CommandOutput, nonce: string): string {
  const parts = [statusLine(output)];
  try {
    if (output.stdout) parts.push(wrapUntrusted(capped(output.stdout), nonce, { source: GH_SOURCE }));
    if (output.stderr) parts.push("stderr:", wrapUntrusted(capped(output.stderr), nonce, { source: GH_SOURCE }));
  } catch (error) {
    if (!(error instanceof UnsafeContentError)) throw error;
    return `${parts[0] ?? ""} Hive withheld gh's output: it holds this run's untrusted-content marker.`;
  }
  return parts.join("\n");
}

async function runGh(argv: readonly string[], ctx: ConnectorContext, deps: GithubToolDeps): Promise<string> {
  try {
    const gh = (deps.findGh ?? findGh)();
    if (gh === null) throw new HttpError(503, `gh isn't installed in ${GH_DIRS.join(", ")}`);
    const cwd = mkdtempSync(join((deps.tmpRoot ?? tmpdir)(), "hive-gh-"));
    try {
      chmodSync(cwd, 0o700);
      const output = await ctx.commands(gh, argv, { cwd, env: ghEnvironment(deps.env), timeoutMs: GH_TIMEOUT_MS, maxOutputBytes: GH_OUTPUT_BYTES });
      return ghReport(output, ctx.nonce);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  } finally {
    ctx.markTainted();
  }
}

function classified(args: readonly string[]): GhCall {
  try {
    return classifyGh(args);
  } catch (error) {
    if (error instanceof GhRefused) throw new HttpError(400, `Hive refused this gh call: ${error.message}`);
    throw error;
  }
}

export function githubTool(deps: GithubToolDeps = {}): ConnectorTool {
  return checkedConnectorTool({
    tool: "github",
    connector: "github",
    prepare: (raw) => {
      const call = classified(parseOr400(input, raw).args);
      return {
        kind: call.kind === "read" ? "read" : "outward",
        payload: Object.freeze({ args: call.argv }),
        summary: ghCommandLine(call.argv),
        display: checkedDisplay(ghDisplay(call)),
        execute: (ctx) => runGh(call.argv, ctx, deps),
      };
    },
  });
}
