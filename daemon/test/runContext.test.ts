import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Store } from "../src/db.ts";
import { runtimeDir } from "../src/paths.ts";
import { RunJobs, type RunEntry } from "../src/runJobs.ts";
import { Runner } from "../src/runner.ts";
import { RunTokens, type ComputerRunBinding, type RunContext } from "../src/runTokens.ts";
import { removeVirtualCwd } from "../src/virtualClaude.ts";
import { field, removeTempDirs } from "./fixtures.ts";
import { addAgent, fakeEngine, until } from "./taskFixtures.ts";

after(removeTempDirs);

function tokenOf(agentId: string): string | null {
  const path = join(runtimeDir, `${agentId}.mcp.json`);
  if (!existsSync(path)) return null;
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  const token = field(field(field(field(config, "mcpServers"), "hive"), "env"), "HIVE_TOKEN");
  return typeof token === "string" ? token : null;
}

function binding(agentId: string): ComputerRunBinding {
  return { computerId: agentId, computerRevision: 1, computerRuntime: "docker", computerProfile: "desktop", computerLeaseId: `test-${agentId}` };
}

function harness(prepareComputer: (agentId: string) => Promise<ComputerRunBinding> = async (agentId) => binding(agentId)) {
  const engine = fakeEngine();
  const store = new Store(":memory:");
  const tokens = new RunTokens();
  const jobs = new RunJobs(store, { message: () => undefined, task: () => undefined });
  const runner = new Runner(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, tokens, {
    changed: () => undefined, delta: () => undefined, prepareComputer, releaseComputer: () => undefined,
    blockedReason: () => null, refused: () => undefined, failed: () => undefined,
  }, jobs, () => engine.binary);
  const live = async (agentId: string, entry: RunEntry): Promise<RunContext | null> => {
    runner.enqueue(agentId, entry);
    await until(() => runner.activeRun(agentId) !== null && tokenOf(agentId) !== null, "the run to start");
    return tokens.context(tokenOf(agentId));
  };
  const runs = () => readdirSync(engine.dir).filter((name) => name.startsWith("start-")).length;
  return { engine, store, tokens, runner, live, runs };
}

describe("run context on the run token", () => {
  it("keeps the trigger's hop, origin and taint even when the prompt itself is clean", async () => {
    const h = harness();
    const ana = addAgent(h.store, { name: "Ana" });
    h.engine.script({ Ana: [[{ sleepMs: 300 }]] });
    const context = await h.live(ana.id, { kind: "chat", text: "plain words", from: null, context: { hop: 3, origin: "someone", tainted: true } });
    assert.deepEqual({ ...context, nonce: undefined }, {
      agentId: ana.id, taskId: null, hop: 3, origin: "someone", tainted: true, nonce: undefined, launchedVirtual: false, launchedConnectors: [],
      computerId: null, computerRevision: null, computerRuntime: null, computerProfile: null, computerLeaseId: null,
    });
    assert.match(context?.nonce ?? "", /^[0-9a-f]{32}$/);
    h.runner.stopAll();
  });

  it("starts a user's chat run untainted, and a virtual agent's run tainted", async () => {
    const h = harness();
    const ana = addAgent(h.store, { name: "Ana" });
    const vera = addAgent(h.store, { name: "Vera", computer: "virtual" });
    h.engine.script({ Ana: [[{ sleepMs: 300 }]], Vera: [[{ sleepMs: 300 }]] });
    const user = { hop: 0, origin: "user", tainted: false };
    const anaContext = await h.live(ana.id, { kind: "chat", text: "hi", from: null, context: user });
    const veraContext = await h.live(vera.id, { kind: "chat", text: "hi", from: null, context: user });
    assert.deepEqual([anaContext?.tainted, anaContext?.launchedVirtual], [false, false]);
    assert.deepEqual([veraContext?.tainted, veraContext?.launchedVirtual], [true, true]);
    h.runner.stopAll();
    removeVirtualCwd(vera.id);
  });

  it("records the agent's connectors at launch, unchanged by a later edit", async () => {
    const h = harness();
    const mo = addAgent(h.store, { name: "Mo", connectors: ["mail"] });
    h.engine.script({ Mo: [[{ sleepMs: 300 }]] });
    const context = await h.live(mo.id, { kind: "chat", text: "hi", from: null, context: { hop: 0, origin: "user", tainted: false } });
    h.store.updateAgent(mo.id, { connectors: ["mail", "github"] }, new Date().toISOString());
    assert.deepEqual(context?.launchedConnectors, ["mail"]);
    h.runner.stopAll();
  });

  it("gives a Codex run no run token and no MCP config", async () => {
    const h = harness();
    const cody = addAgent(h.store, { name: "Cody", engine: "codex" });
    h.engine.script({ Cody: [[{ sleepMs: 300 }]] });
    h.runner.enqueue(cody.id, { kind: "chat", text: "hi", from: null, context: { hop: 0, origin: "user", tainted: false } });
    await until(() => h.runner.activeRun(cody.id) !== null, "the run to start");
    assert.equal(existsSync(join(runtimeDir, `${cody.id}.mcp.json`)), false);
    await until(() => h.runner.activeRun(cody.id) === null, "the run to end");
  });
});

describe("dropping queued runs", () => {
  it("drops an agent-triggered entry while its virtual computer is still starting, and moves on to the next one", async () => {
    let ready = (): void => undefined;
    const h = harness((agentId) => new Promise<ComputerRunBinding>((resolve) => (ready = () => resolve(binding(agentId)))));
    const vera = addAgent(h.store, { name: "Vera", computer: "virtual" });
    h.runner.enqueue(vera.id, { kind: "chat", text: "from another agent", from: null, context: { hop: 1, origin: "someone", tainted: true } });
    h.runner.enqueue(vera.id, { kind: "chat", text: "from the user", from: null, context: { hop: 0, origin: "user", tainted: false } });
    const dropped = h.runner.dropQueued(vera.id, (entry) => entry.context.origin !== "user");
    assert.deepEqual(dropped.map((entry) => entry.kind === "chat" && entry.text), ["from another agent"]);
    ready();
    await until(() => h.runs() === 1, "the user's run");
    await until(() => h.runner.activeRun(vera.id) === null, "the run to end");
    assert.equal(h.runs(), 1);
    removeVirtualCwd(vera.id);
  });

  it("skips a queued task run once the agent is no longer the task's assignee", async () => {
    const h = harness();
    const ana = addAgent(h.store, { name: "Ana" });
    h.engine.script({ Ana: [[{ sleepMs: 300 }]] });
    const now = "2026-10-21T12:00:00.000Z";
    h.store.tasks.insertTask({
      id: "task-1", title: "t", description: "", status: "todo", assigneeId: ana.id, createdBy: "user",
      titleUntrusted: false, descriptionUntrusted: false, titleMacOnly: false, descriptionMacOnly: false, createdAt: now, updatedAt: now,
    });
    h.runner.enqueue(ana.id, { kind: "chat", text: "busy", from: null, context: { hop: 0, origin: "user", tainted: false } });
    h.runner.enqueue(ana.id, { kind: "task", taskId: "task-1", context: { hop: 0, origin: "user", tainted: false } });
    h.store.tasks.updateTask("task-1", { assigneeId: null }, now);
    await until(() => h.runs() === 1 && h.runner.activeRun(ana.id) === null, "the chat run to end");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(h.runs(), 1);
    assert.equal(h.runner.queued(ana.id), 0);
  });
});
