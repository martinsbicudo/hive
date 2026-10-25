import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ComputerService } from "../src/computerService.ts";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { ensureDirs } from "../src/paths.ts";
import { startServer } from "../src/server.ts";
import type { ArchitectRun } from "./fakeArchitect.ts";
import { call, fakeDocker, field, freePort, tempDir } from "./fixtures.ts";
import { UI_SECRET } from "./taskFixtures.ts";

export interface ArchitectStart {
  index: number;
  args: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

function isStart(value: unknown): value is ArchitectStart {
  return typeof field(value, "index") === "number" && Array.isArray(field(value, "args")) && typeof field(value, "stdin") === "string";
}

export const user = (text: string) => ({ role: "user", text });
export const assistant = (text: string) => ({ role: "assistant", text });
export const json = (value: unknown) => `Here is the agent.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

export function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Nina", role: "Daily Briefing", engine: "claude-code", model: "sonnet", instructions: "Summarize the news.", computer: "virtual",
    permissionMode: "ask", folders: [], schedules: [{ kind: "daily", at: "09:00", prompt: "Write today's news summary." }], ...overrides,
  };
}

export interface ArchitectHarnessOptions {
  claude?: boolean;
  deadlineMs?: number;
  nonce?: string;
}

export async function architectHarness(options: ArchitectHarnessOptions = {}) {
  ensureDirs();
  const dir = tempDir("hive-fake-architect-");
  const root = tempDir("hive-architect-root-");
  const binary = join(dir, "claude");
  const engine = fileURLToPath(new URL("./fakeArchitect.ts", import.meta.url));
  writeFileSync(binary, `#!/bin/sh\nHIVE_FAKE_DIR='${dir}' exec '${process.execPath}' '${engine}' "$@"\n`);
  chmodSync(binary, 0o755);
  const findEngine = (name: string): string | null => (name === "codex" ? "/usr/bin/true" : options.claude === false ? null : binary);
  const port = await freePort();
  const store = new Store(":memory:");
  const nonce = options.nonce;
  const hub = new Hub(store, { command: "node", args: [], url: `http://127.0.0.1:${port}` }, new ComputerService({ docker: () => fakeDocker().runner }), {
    findEngine, architect: { root, deadlineMs: options.deadlineMs, nonce: nonce === undefined ? undefined : () => nonce },
  });
  const server: Server = startServer({ hub, uiSecret: UI_SECRET, port, webDir: "/nonexistent" });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const files = (prefix: string) => readdirSync(dir).filter((name) => name.startsWith(prefix));
  const api = (method: string, path: string, body?: unknown) => call(port, method, path, { token: UI_SECRET, body });
  return {
    hub, store, port, dir, root, api,
    cwd: join(root, "hive-architect", "cwd"),
    script: (runs: ArchitectRun[]) => writeFileSync(join(dir, "script.json"), JSON.stringify(runs)),
    starts: (): ArchitectStart[] =>
      files("start-")
        .map((name): unknown => JSON.parse(readFileSync(join(dir, name), "utf8")))
        .filter(isStart)
        .sort((a, b) => a.index - b.index),
    finished: () => files("done-").length,
    armed: () => files("armed-").length,
    turn: (messages: unknown[]) => api("POST", "/api/architect", { messages }),
    close: () => {
      server.closeAllConnections();
      server.close();
      hub.shutdown();
    },
  };
}
