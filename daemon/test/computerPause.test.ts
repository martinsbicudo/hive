import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { buildNewAgent } from "../src/agents.ts";
import { ComputerService } from "../src/computerService.ts";
import { Store } from "../src/db.ts";
import type { CommandResult } from "../src/docker.ts";
import { Hub } from "../src/hub.ts";
import type { ComputerRunBinding } from "../src/runTokens.ts";
import { fakeDocker, ok, removeTempDirs } from "./fixtures.ts";

const NOW = "2026-10-24T12:00:00.000Z";
const READY = async () => ({ ready: true, detail: "ready", profiles: ["terminal" as const] });

after(() => removeTempDirs());

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function leaseOf(binding: ComputerRunBinding) {
  return { computerId: binding.computerId, computerRevision: binding.computerRevision, computerLeaseId: binding.computerLeaseId };
}

// A container that is up only between a `docker run` of its agent container and the next `docker stop`.
function trackedDocker(onInspect: () => Promise<void> | null = () => null) {
  let computerId = "";
  let running = false;
  const docker = fakeDocker((args) => {
    if (args[0] === "run" && args.includes(`hive-${computerId}`)) running = true;
    if (args[0] === "stop") running = false;
    return null;
  });
  const runner = async (args: readonly string[], options?: Parameters<typeof docker.runner>[1]): Promise<CommandResult> => {
    if (args[0] === "inspect" && args.includes("{{.State.Running}}")) {
      await onInspect();
      docker.calls.push({ args });
      return ok(running ? "true" : "false");
    }
    return docker.runner(args, options);
  };
  const runsSince = (from: number) => docker.calls.slice(from).filter((call) => call.args[0] === "run").length;
  return { calls: docker.calls, runner, runsSince, watch: (id: string) => (computerId = id), running: () => running };
}

async function sharedHub(docker: ReturnType<typeof trackedDocker>) {
  const store = new Store(":memory:");
  const ana = buildNewAgent({ name: "Ana" }, []);
  const bob = buildNewAgent({ name: "Bob" }, ["Ana"]);
  store.insertAgent(ana, NOW);
  store.insertAgent(bob, NOW);
  const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService({ docker: () => docker.runner }), {
    runtimeReady: READY, findEngine: () => null,
  });
  const shared = await hub.computerManagement.create("Shared", "docker", "terminal");
  docker.watch(shared.id);
  await hub.computerManagement.attach(ana.id, shared.id);
  await hub.computerManagement.attach(bob.id, shared.id);
  return { store, hub, ana, bob, shared };
}

describe("pause holds until resume", () => {
  it("refuses a member queued on the shared computer's lease, so the released lease doesn't restart the computer", async () => {
    const docker = trackedDocker();
    const { store, hub, ana, bob } = await sharedHub(docker);
    try {
      const anaRun = await hub.computerManagement.prepare(ana.id);
      assert.equal(docker.running(), true);
      const bobRun = hub.computerManagement.prepare(bob.id);
      await hub.control.pause();
      const pausedAt = docker.calls.length;
      assert.equal(docker.running(), false);
      await assert.rejects(bobRun, /configuration changed/);
      hub.computerManagement.release(anaRun);
      await flush();
      await assert.rejects(hub.computerManagement.prepare(bob.id), /Hive is paused/);
      assert.equal(docker.runsSince(pausedAt), 0);
      assert.equal(docker.running(), false);
      assert.throws(() => hub.startComputer(bob.id), /Hive is paused/);
      hub.control.resume();
      const resumed = await hub.computerManagement.prepare(bob.id);
      assert.equal(docker.running(), true);
      hub.computerManagement.release(resumed);
    } finally {
      await hub.shutdown();
      store.close();
    }
  });

  it("doesn't start the computer for a run that was still preparing when Hive paused", async () => {
    const docker = trackedDocker();
    const { store, hub, ana, bob } = await sharedHub(docker);
    try {
      const anaRun = await hub.computerManagement.prepare(ana.id);
      hub.send(bob.id, "hi");
      await flush();
      assert.equal(hub.agent(bob.id).status, "working");
      await hub.control.pause();
      const pausedAt = docker.calls.length;
      hub.computerManagement.release(anaRun);
      await flush();
      assert.equal(docker.runsSince(pausedAt), 0);
      assert.equal(docker.running(), false);
      assert.equal(hub.computerManagement.leases.isLeased(anaRun.computerId), false);
    } finally {
      await hub.shutdown();
      store.close();
    }
  });

  it("refuses a guest call made after pause, and one already past its lease check, without starting the computer", async () => {
    let hold: Promise<void> | null = null;
    const reached = Promise.withResolvers<void>();
    const docker = trackedDocker(() => {
      if (hold) reached.resolve();
      return hold;
    });
    const { store, hub, ana } = await sharedHub(docker);
    try {
      const anaRun = await hub.computerManagement.prepare(ana.id);
      const gate = Promise.withResolvers<void>();
      hold = gate.promise;
      const inFlight = hub.computers.guest.run(ana.id, leaseOf(anaRun), "id", 5);
      await reached.promise;
      hold = null;
      await hub.control.pause();
      const pausedAt = docker.calls.length;
      gate.resolve();
      await assert.rejects(inFlight, /no longer has access|Hive is paused/);
      await assert.rejects(hub.computers.guest.run(ana.id, leaseOf(anaRun), "id", 5), /no longer has access/);
      const execs = docker.calls.slice(pausedAt).filter((call) => call.args[0] === "exec" && call.args.includes("-lc"));
      assert.deepEqual(execs, []);
      assert.equal(docker.runsSince(pausedAt), 0);
      assert.equal(docker.running(), false);
      hub.computerManagement.release(anaRun);
    } finally {
      await hub.shutdown();
      store.close();
    }
  });
});
