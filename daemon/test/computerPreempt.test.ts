import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildNewAgent } from "../src/agents.ts";
import { computerAssignmentApi, computerResourceApi } from "../src/computerRoutes.ts";
import { ComputerService } from "../src/computerService.ts";
import { Store } from "../src/db.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import { Hub } from "../src/hub.ts";
import { removeMcpConfig, runtimeDir } from "../src/paths.ts";
import type { RunContext } from "../src/runTokens.ts";
import { removeVirtualCwd } from "../src/virtualClaude.ts";
import { fakeDocker, field, removeTempDirs } from "./fixtures.ts";
import { fakeEngine, until } from "./taskFixtures.ts";

const NOW = "2026-10-24T12:00:00.000Z";
const READY = async () => ({ ready: true, detail: "ready", profiles: ["terminal" as const, "browser" as const] });
const KILLED: CommandResult = { code: 137, stdout: Buffer.alloc(0), stderr: "" };
const cleanup: string[] = [];

after(() => {
  for (const id of cleanup) {
    removeVirtualCwd(id);
    removeMcpConfig(id);
  }
  removeTempDirs();
});

// Holds the first guest command open, and records what `seen` reports at the moment its lease's kill is issued.
function blockingDocker(seen: () => unknown) {
  const base = fakeDocker();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<CommandResult>();
  const kills: unknown[] = [];
  const runner: DockerRunner = async (args, options) => {
    if (args[0] === "exec" && args.includes("-lc")) {
      base.calls.push({ args });
      started.resolve();
      return finish.promise;
    }
    if (args.includes("hive-lease-kill")) kills.push(seen());
    return base.runner(args, options);
  };
  return { runner, started, finish, kills };
}

function tokenOf(agentId: string): string | null {
  const path = join(runtimeDir, `${agentId}.mcp.json`);
  if (!existsSync(path)) return null;
  const token = field(field(field(field(JSON.parse(readFileSync(path, "utf8")), "mcpServers"), "hive"), "env"), "HIVE_TOKEN");
  return typeof token === "string" ? token : null;
}

async function busyMember() {
  const engine = fakeEngine();
  engine.script({ Ana: [[{ sleepMs: 60_000 }]] });
  const store = new Store(":memory:");
  const ana = buildNewAgent({ name: "Ana" }, []);
  store.insertAgent(ana, NOW);
  cleanup.push(ana.id);
  const state: { seen: () => unknown } = { seen: () => null };
  const docker = blockingDocker(() => state.seen());
  const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService({ docker: () => docker.runner }), {
    runtimeReady: READY, findEngine: () => engine.binary,
  });
  const first = await hub.computerManagement.create("First", "docker", "terminal");
  const second = await hub.computerManagement.create("Second", "docker", "terminal");
  await hub.computerManagement.attach(ana.id, first.id);
  hub.send(ana.id, "work");
  const started = () => readdirSync(engine.dir).some((name) => name.startsWith("start-"));
  await until(() => started() && tokenOf(ana.id) !== null, "Ana's run to start");
  const context: RunContext | null = hub.runTokens.context(tokenOf(ana.id));
  if (!context?.computerId || context.computerRevision === null || !context.computerLeaseId) throw new Error("the run holds no computer lease");
  const lease = { computerId: context.computerId, computerRevision: context.computerRevision, computerLeaseId: context.computerLeaseId };
  const command = hub.computers.guest.run(ana.id, lease, "make all", 600);
  await docker.started.promise;
  const runStatus = () => store.runsSince("2000-01-01T00:00:00.000Z").find((run) => run.agentId === ana.id)?.status;
  const close = async () => {
    await hub.shutdown();
    store.close();
  };
  return { store, hub, ana, first, second, docker, state, lease, command, runStatus, close };
}

describe("the owner's computer changes preempt an active run", () => {
  it("detaches a member mid-run: the run stops, its commands are killed first, then the membership changes", { timeout: 10_000 }, async () => {
    const h = await busyMember();
    try {
      h.state.seen = () => h.store.getAgent(h.ana.id)?.computerId;
      const reply = computerAssignmentApi(h.hub, h.ana.id, "DELETE", {});
      await until(() => h.runStatus() === "stopped", "the run to be interrupted");
      assert.equal(h.store.getAgent(h.ana.id)?.computerId, h.first.id, "the membership changed before the lease was drained");
      h.docker.finish.resolve(KILLED);
      assert.equal((await h.command).exitCode, 137);
      assert.deepEqual(await reply, { status: 200, body: { ok: true } });
      assert.ok(h.docker.kills.length > 0);
      assert.equal(h.docker.kills[0], h.first.id);
      assert.equal(h.store.getAgent(h.ana.id)?.computerId, null);
      await assert.rejects(h.hub.computers.guest.run(h.ana.id, h.lease, "id", 5), /no longer has access/);
    } finally {
      await h.close();
    }
  });

  it("moves a member to another computer mid-run the same way", { timeout: 10_000 }, async () => {
    const h = await busyMember();
    try {
      h.state.seen = () => h.store.getAgent(h.ana.id)?.computerId;
      const reply = computerAssignmentApi(h.hub, h.ana.id, "PUT", { computerId: h.second.id });
      await until(() => h.runStatus() === "stopped", "the run to be interrupted");
      h.docker.finish.resolve(KILLED);
      await h.command;
      assert.equal((await reply).status, 200);
      assert.equal(h.docker.kills[0], h.first.id);
      assert.equal(h.store.getAgent(h.ana.id)?.computerId, h.second.id);
      await assert.rejects(h.hub.computers.guest.run(h.ana.id, h.lease, "id", 5), /no longer has access/);
    } finally {
      await h.close();
    }
  });

  it("renames a computer a member is using mid-run without interrupting the run", { timeout: 10_000 }, async () => {
    const h = await busyMember();
    try {
      const revision = h.store.computers.get(h.first.id)?.revision;
      const reply = await computerResourceApi(h.hub, h.first.id, "PATCH", { name: "Renamed" });
      assert.equal(reply.status, 200);
      assert.equal(h.store.computers.get(h.first.id)?.name, "Renamed");
      assert.equal(h.store.computers.get(h.first.id)?.revision, revision);
      assert.equal(h.runStatus(), "running");
      assert.equal(h.docker.kills.length, 0);
      h.docker.finish.resolve({ code: 0, stdout: Buffer.from("built"), stderr: "" });
      assert.equal((await h.command).exitCode, 0);
    } finally {
      await h.close();
    }
  });

  it("changes the profile of a computer a member is using mid-run", { timeout: 10_000 }, async () => {
    const h = await busyMember();
    try {
      const revision = h.store.computers.get(h.first.id)?.revision;
      h.state.seen = () => h.store.computers.get(h.first.id)?.revision;
      const reply = computerResourceApi(h.hub, h.first.id, "PATCH", { profile: "browser" });
      await until(() => h.runStatus() === "stopped", "the run to be interrupted");
      h.docker.finish.resolve(KILLED);
      await h.command;
      assert.equal((await reply).status, 200);
      assert.equal(h.docker.kills[0], revision);
      assert.equal(h.store.computers.get(h.first.id)?.profile, "browser");
      assert.notEqual(h.store.computers.get(h.first.id)?.revision, revision);
      await assert.rejects(h.hub.computers.guest.run(h.ana.id, h.lease, "id", 5), /no longer has access/);
    } finally {
      await h.close();
    }
  });
});

describe("a member's computer switch that fails to save", () => {
  it("hands the computer's reservation back, so the next run can lease it", { timeout: 5000 }, async () => {
    const store = new Store(":memory:");
    const ana = buildNewAgent({ name: "Ana", computer: "virtual" }, []);
    store.insertAgent(ana, NOW);
    const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService({ docker: () => fakeDocker().runner }), {
      runtimeReady: READY,
    });
    try {
      const save = store.updateAgent.bind(store);
      store.updateAgent = () => {
        throw new Error("disk full");
      };
      assert.throws(() => hub.updateAgent(ana.id, { computer: "mac" }), /disk full/);
      store.updateAgent = save;
      assert.equal(store.getAgent(ana.id)?.computerId, ana.id);
      await hub.computerManagement.leases.waitForMutation(ana.id);
      hub.computerManagement.release(await hub.computerManagement.prepare(ana.id));
    } finally {
      await hub.shutdown();
      store.close();
    }
  });
});
