import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildNewAgent } from "../src/agents.ts";
import { Store } from "../src/db.ts";
import { ensureDirs, removeMcpConfig, runtimeDir } from "../src/paths.ts";
import { Runner } from "../src/runner.ts";
import { RunJobs } from "../src/runJobs.ts";
import { RunTokens } from "../src/runTokens.ts";
import { removeVirtualCwd } from "../src/virtualClaude.ts";
import { field, removeTempDirs, tempDir } from "./fixtures.ts";

const NOW = "2026-10-21T12:00:00.000Z";
const BAD_INIT = JSON.stringify({ type: "system", subtype: "init", session_id: "s1", tools: ["WebSearch", "Bash"] });
const POLL_MS = 25;
const DEADLINE_MS = 10_000;

function fakeClaude(): string {
  const path = join(tempDir("hive-engine-"), "claude");
  writeFileSync(path, [
    "#!/bin/sh",
    `echo '${BAD_INIT}'`,
    `trap 'kill "$child" 2>/dev/null; sleep 1; exit 143' TERM`,
    "sleep 30 </dev/null >/dev/null 2>&1 &",
    "child=$!",
    "wait",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  return path;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function runToken(agentId: string): string | null {
  try {
    const config: unknown = JSON.parse(readFileSync(join(runtimeDir, `${agentId}.mcp.json`), "utf8"));
    const token = field(field(field(field(config, "mcpServers"), "hive"), "env"), "HIVE_TOKEN");
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

describe("init-event guard on a real process", () => {
  const store = new Store(":memory:");
  const agent = buildNewAgent({ name: "Vera", computer: "virtual" }, []);

  after(() => {
    removeVirtualCwd(agent.id);
    removeMcpConfig(agent.id);
    removeTempDirs();
    store.close();
  });

  it("kills a run whose init event offers a forbidden tool, revokes its token at once and posts an error", async () => {
    ensureDirs();
    store.insertAgent(agent, NOW);
    const tokens = new RunTokens();
    const binary = fakeClaude();
    const jobs = new RunJobs(store, { message: () => undefined, task: () => undefined });
    const runner = new Runner(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, tokens, {
      changed: () => undefined, delta: () => undefined,
      prepareComputer: async () => ({ computerId: agent.id, computerRevision: 1, computerRuntime: "docker", computerProfile: "desktop", computerLeaseId: `test-${agent.id}` }),
      releaseComputer: () => undefined, blockedReason: () => null, refused: () => undefined, failed: () => undefined,
    }, jobs, () => binary);
    const started = Date.now();
    runner.send(agent.id, "hello");
    await until(() => runToken(agent.id) !== null, "the run to start");
    const token = runToken(agent.id) ?? "";
    await until(() => tokens.resolve(token) === null, "the token to be revoked");
    assert.notEqual(runner.activeRun(agent.id), null, "the token is revoked before the process exits");
    await until(() => runner.activeRun(agent.id) === null, "the run to end");
    assert.ok(Date.now() - started < 10_000);
    const errors = store.listMessages(agent.id, 10).filter((message) => message.role === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.text ?? "", /Hive stopped this run: Claude Code offered tools a virtual agent must not have \(Bash\)/);
    assert.match(runner.lastError(agent.id) ?? "", /Bash/);
  });
});
