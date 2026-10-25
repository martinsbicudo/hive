import { fileURLToPath } from "node:url";
import type { z } from "zod";
import type { CommandOutput } from "./commandRunner.ts";
import type { ConnectorContext } from "./connectorTools.ts";
import { UnsafeContentError, wrapUntrusted } from "./trust.ts";

export const OSASCRIPT = "/usr/bin/osascript";
export const JXA_TIMEOUT_MS = 60_000;
export const JXA_OUTPUT_BYTES = 512 * 1024;
export const JXA_SCRIPTS = ["mail-unread", "mail-read", "mail-send", "calendar-events", "calendar-create", "messages-send"] as const;
export type JxaScript = (typeof JXA_SCRIPTS)[number];

const STDERR_LIMIT = 2000;
const NOT_AUTHORIZED = /-1743|not authori[sz]ed/i;

export class JxaFailed extends Error {}

export function jxaScriptPath(script: JxaScript): string {
  return fileURLToPath(new URL(`../connectors/${script}.js`, import.meta.url));
}

export function jxaArgv(script: JxaScript): string[] {
  return ["-l", "JavaScript", jxaScriptPath(script)];
}

function failure(app: string, output: CommandOutput, nonce: string, source: string): string {
  if (output.timedOut) return `${app} didn't answer within ${JXA_TIMEOUT_MS / 1000} s.`;
  if (output.overflowed) return `${app}'s answer passed ${JXA_OUTPUT_BYTES / 1024} kB, so Hive dropped it.`;
  const head = `osascript exited with code ${output.code}.`;
  const hint = NOT_AUTHORIZED.test(output.stderr)
    ? ` macOS hasn't let Hive control ${app}. Allow it in System Settings > Privacy & Security > Automation > Hive.`
    : "";
  const detail = output.stderr.trim().slice(0, STDERR_LIMIT);
  if (!detail) return head + hint;
  try {
    return `${head}${hint}\n${wrapUntrusted(detail, nonce, { source })}`;
  } catch (error) {
    if (!(error instanceof UnsafeContentError)) throw error;
    return `${head}${hint} Hive withheld the error text: it holds this run's untrusted-content marker.`;
  }
}

export interface JxaCall<T> {
  script: JxaScript;
  app: string;
  source: string;
  input: Readonly<Record<string, unknown>>;
  output: z.ZodType<T>;
}

export async function runJxa<T>(call: JxaCall<T>, ctx: ConnectorContext): Promise<T> {
  const output = await ctx.commands(OSASCRIPT, jxaArgv(call.script), {
    input: JSON.stringify(call.input),
    timeoutMs: JXA_TIMEOUT_MS,
    maxOutputBytes: JXA_OUTPUT_BYTES,
  });
  if (output.code !== 0 || output.timedOut || output.overflowed) throw new JxaFailed(failure(call.app, output, ctx.nonce, call.source));
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    throw new JxaFailed(`${call.app} answered with something Hive couldn't read.`);
  }
  const checked = call.output.safeParse(parsed);
  if (!checked.success) throw new JxaFailed(`${call.app} answered in a shape Hive didn't expect.`);
  return checked.data;
}
