import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { buildNewAgent, ValidationError } from "../src/agents.ts";
import { ComputerLeases } from "../src/computerLeases.ts";
import { knownComputerIds } from "../src/computerManagementHelpers.ts";
import { ComputerService } from "../src/computerService.ts";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { ensureDirs, removeMcpConfig } from "../src/paths.ts";
import { Runner } from "../src/runner.ts";
import { RunJobs } from "../src/runJobs.ts";
import { RunTokens, type ComputerRunBinding, type RunContext } from "../src/runTokens.ts";
import { removeVirtualCwd } from "../src/virtualClaude.ts";
import { fakeDocker, ok, removeTempDirs, tempDir } from "./fixtures.ts";

const NOW = "2026-10-24T12:00:00.000Z";
const READY = async () => ({ ready: true, detail: "ready", profiles: ["terminal" as const] });

function hubWith(store: Store, docker: ReturnType<typeof fakeDocker>): Hub {
  return new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService({ docker: () => docker.runner }), { runtimeReady: READY });
}

after(() => removeTempDirs());

describe("pause and board status follow the assigned computer", () => {
  it("pause stops the shared computer an agent is attached to, and the board reports that computer", async () => {
    const store = new Store(":memory:");
    const ana = buildNewAgent({ name: "Ana", computer: "virtual" }, []);
    store.insertAgent(ana, NOW);
    const docker = fakeDocker();
    const hub = hubWith(store, docker);
    try {
      const shared = await hub.computerManagement.create("Shared", "docker", "terminal");
      await hub.computerManagement.attach(ana.id, shared.id);
      await hub.computers.ensureRunning(ana.id);
      const entry = hub.state().computers.find((computer) => computer.agentId === ana.id);
      assert.equal(entry?.computerId, shared.id);
      assert.equal(entry?.state, "running");
      await hub.control.pause();
      assert.ok(docker.calls.some((call) => call.args.join(" ") === `stop -t 3 hive-${shared.id}`));
      assert.equal(hub.state().computers.find((computer) => computer.agentId === ana.id)?.state, "stopped");
    } finally {
      await hub.shutdown();
      store.close();
    }
  });
});

describe("legacy computer backfill on every open", () => {
  it("gives an agent an older build moved to virtual its private computer, and none to an agent on a shared one", () => {
    const path = join(tempDir("hive-backfill-"), "hive.db");
    const first = new Store(path);
    const ana = buildNewAgent({ name: "Ana" }, []);
    const cleo = buildNewAgent({ name: "Cleo", computer: "virtual" }, ["Ana"]);
    first.insertAgent(ana, NOW);
    first.insertAgent(cleo, NOW);
    const shared = first.computers.createManaged("Shared", "docker", "terminal", NOW);
    assert.ok(first.computers.assign(cleo.id, shared.id, NOW));
    assert.ok(first.computers.deletePrivateIfUnused(cleo.id));
    first.close();
    const olderBuild = new DatabaseSync(path);
    olderBuild.prepare("UPDATE agents SET computer = 'virtual', computer_id = NULL WHERE id = ?").run(ana.id);
    olderBuild.close();
    const reopened = new Store(path);
    try {
      assert.equal(reopened.getAgent(ana.id)?.computer, "virtual");
      assert.equal(reopened.getAgent(ana.id)?.computerId, ana.id);
      assert.equal(reopened.computers.get(ana.id)?.managed, false);
      assert.equal(reopened.getAgent(cleo.id)?.computerId, shared.id);
      assert.equal(reopened.computers.get(cleo.id), null);
    } finally {
      reopened.close();
    }
  });
});

describe("startup reconcile keeps homes of known agents", () => {
  it("keeps the labelled volume of an agent now on the Mac and removes a truly unknown one", async () => {
    const store = new Store(":memory:");
    const max = buildNewAgent({ name: "Max" }, []);
    store.insertAgent(max, NOW);
    const unknown = randomUUID();
    const docker = fakeDocker((args) => (args[0] === "volume" && args[1] === "ls" ? ok(`hive-home-${max.id}\t${max.id}\nhive-home-${unknown}\t${unknown}\n`) : null));
    const hub = hubWith(store, docker);
    try {
      const known = knownComputerIds(store);
      assert.ok(known.has(max.id));
      await hub.computers.reconcile(known);
      const flat = docker.calls.map((call) => call.args.join(" "));
      assert.ok(!flat.includes(`volume rm -f hive-home-${max.id}`), flat.join("\n"));
      assert.ok(flat.includes(`volume rm -f hive-home-${unknown}`), flat.join("\n"));
    } finally {
      await hub.shutdown();
      store.close();
    }
  });
});

describe("switching back to virtual never rejoins a shared computer", () => {
  it("refuses PATCH computer virtual when the agent's old computer was promoted and shared", async () => {
    const store = new Store(":memory:");
    const ana = buildNewAgent({ name: "Ana", computer: "virtual" }, []);
    const bob = buildNewAgent({ name: "Bob", computer: "virtual" }, ["Ana"]);
    store.insertAgent(ana, NOW);
    store.insertAgent(bob, NOW);
    const hub = hubWith(store, fakeDocker());
    try {
      await hub.computerManagement.update(ana.id, { managed: true });
      await hub.computerManagement.attach(bob.id, ana.id);
      await hub.computerManagement.detach(ana.id);
      const revision = store.computers.get(ana.id)?.revision ?? 0;
      const lease = await hub.computerManagement.leases.acquire(bob.id, ana.id, revision);
      assert.throws(() => hub.updateAgent(ana.id, { computer: "virtual" }), ValidationError);
      assert.equal(store.getAgent(ana.id)?.computer, "mac");
      assert.equal(store.getAgent(ana.id)?.computerId, null);
      assert.equal(store.computers.get(ana.id)?.revision, revision);
      assert.deepEqual(store.computers.resource(ana.id)?.members.map((member) => member.agentId), [bob.id]);
      assert.ok(hub.computerManagement.leases.isCurrent(bob.id, ana.id, revision, lease.id));
      hub.computerManagement.leases.release(lease.id);
    } finally {
      await hub.shutdown();
      store.close();
    }
  });
});

describe("a launch that throws releases what it holds", () => {
  const cleanup: string[] = [];
  after(() => {
    for (const id of cleanup) {
      removeVirtualCwd(id);
      removeMcpConfig(id);
    }
  });

  async function throwingLaunch(breakIt: (store: Store) => void, binary: string) {
    ensureDirs();
    const store = new Store(":memory:");
    const agent = buildNewAgent({ name: "Vera", computer: "virtual" }, []);
    store.insertAgent(agent, NOW);
    cleanup.push(agent.id);
    breakIt(store);
    const leases = new ComputerLeases();
    const tokens = new RunTokens();
    const issued: string[] = [];
    const issue = tokens.issue.bind(tokens);
    tokens.issue = (agentId: string, context?: RunContext) => {
      const token = issue(agentId, context);
      issued.push(token);
      return token;
    };
    const failed = Promise.withResolvers<void>();
    const jobs = new RunJobs(store, { message: () => undefined, task: () => undefined });
    const runner = new Runner(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, tokens, {
      changed: () => undefined, delta: () => undefined,
      prepareComputer: async (agentId): Promise<ComputerRunBinding> => {
        const lease = await leases.acquire(agentId, agent.id, 1);
        return { computerId: agent.id, computerRevision: 1, computerRuntime: "docker", computerProfile: "terminal", computerLeaseId: lease.id };
      },
      releaseComputer: (binding) => leases.release(binding.computerLeaseId),
      blockedReason: () => null, refused: () => undefined, failed: () => failed.resolve(),
    }, jobs, () => binary);
    runner.send(agent.id, "hello");
    await failed.promise;
    assert.equal(leases.isLeased(agent.id), false);
    const second = await leases.acquire(randomUUID(), agent.id, 1);
    leases.release(second.id);
    assert.equal(issued.length, 1);
    assert.equal(tokens.resolve(issued[0] ?? null), null);
    assert.equal(runner.activeRun(agent.id), null);
    assert.match(runner.lastError(agent.id) ?? "", /Hive couldn't start this run/);
    return { store, agent };
  }

  it("when recording the run throws", { timeout: 5000 }, async () => {
    const { store } = await throwingLaunch((broken) => {
      broken.insertRun = () => {
        throw new Error("disk full");
      };
    }, "/bin/sh");
    store.close();
  });

  it("when spawning the engine throws, and marks the recorded run failed", { timeout: 5000 }, async () => {
    const { store, agent } = await throwingLaunch(() => undefined, "/bin/sh\0broken");
    const runs = store.runsSince("2000-01-01T00:00:00.000Z").filter((run) => run.agentId === agent.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "failed");
    store.close();
  });
});
