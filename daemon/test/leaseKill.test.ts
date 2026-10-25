import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { buildNewAgent } from "../src/agents.ts";
import { GuestLeases, leaseCommand, leaseKillCommand } from "../src/computerLeaseExec.ts";
import { BROWSER_SCRIPT } from "../src/computerServiceHelpers.ts";
import { ComputerService } from "../src/computerService.ts";
import { Store } from "../src/db.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import { Hub } from "../src/hub.ts";
import type { ComputerRunBinding } from "../src/runTokens.ts";
import { fakeDocker, removeTempDirs } from "./fixtures.ts";

const NOW = "2026-10-24T12:00:00.000Z";
const READY = async () => ({ ready: true, detail: "ready", profiles: ["terminal" as const] });
const KILLED: CommandResult = { code: 137, stdout: Buffer.alloc(0), stderr: "" };

after(() => removeTempDirs());

function blockingDocker(killResult: () => CommandResult | null = () => null) {
  const base = fakeDocker((args) => (args.includes("hive-lease-kill") ? killResult() : null));
  const started = Promise.withResolvers<void>();
  const killed = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<CommandResult>();
  const runner: DockerRunner = async (args, options) => {
    if (args[0] === "exec" && args.includes("-lc")) {
      base.calls.push({ args });
      started.resolve();
      return finish.promise;
    }
    if (args.includes("hive-lease-kill")) killed.resolve();
    return base.runner(args, options);
  };
  return { calls: base.calls, runner, started, killed, finish };
}

async function sharedPair(docker: ReturnType<typeof blockingDocker>) {
  const store = new Store(":memory:");
  const ana = buildNewAgent({ name: "Ana" }, []);
  const bob = buildNewAgent({ name: "Bob" }, ["Ana"]);
  store.insertAgent(ana, NOW);
  store.insertAgent(bob, NOW);
  const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService({ docker: () => docker.runner }), { runtimeReady: READY });
  const shared = await hub.computerManagement.create("Shared", "docker", "terminal");
  await hub.computerManagement.attach(ana.id, shared.id);
  await hub.computerManagement.attach(bob.id, shared.id);
  return { store, hub, ana, bob, shared };
}

function leaseOf(binding: ComputerRunBinding) {
  return { computerId: binding.computerId, computerRevision: binding.computerRevision, computerLeaseId: binding.computerLeaseId };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function killIndex(calls: readonly { args: readonly string[] }[], leaseId: string): number {
  return calls.findIndex((call) => call.args.includes("hive-lease-kill") && call.args.at(-1) === leaseId);
}

describe("guest commands end with their lease", () => {
  it("kills a released lease's commands, and the next member's prepare waits for that", { timeout: 5000 }, async () => {
    const docker = blockingDocker();
    const { store, hub, ana, bob } = await sharedPair(docker);
    try {
      const anaRun = await hub.computerManagement.prepare(ana.id);
      const running = hub.computers.guest.run(ana.id, leaseOf(anaRun), "sleep 1000", 600);
      await docker.started.promise;
      const command = docker.calls.find((call) => call.args.includes("-lc"))?.args ?? [];
      assert.equal(command[command.indexOf("-u") + 1], "agent");
      assert.equal(command[command.indexOf("hive-lease") + 1], anaRun.computerLeaseId);
      assert.deepEqual(command.slice(-3), ["bash", "-lc", "sleep 1000"]);
      let bobGranted = false;
      const bobRun = hub.computerManagement.prepare(bob.id).then((binding) => {
        bobGranted = true;
        return binding;
      });
      hub.computerManagement.release(anaRun);
      await docker.killed.promise;
      await flush();
      assert.equal(bobGranted, false, "bob got the computer while ana's command still ran");
      const killedAt = killIndex(docker.calls, anaRun.computerLeaseId);
      assert.equal(docker.calls[killedAt]?.args[docker.calls[killedAt]?.args.indexOf("-u") + 1], "agent");
      docker.finish.resolve(KILLED);
      assert.equal((await running).exitCode, 137);
      const granted = await bobRun;
      assert.ok(docker.calls.filter((call) => call.args.at(-1) === anaRun.computerLeaseId && call.args.includes("hive-lease-kill")).length >= 2);
      await assert.rejects(hub.computers.guest.run(ana.id, leaseOf(anaRun), "id", 5), /no longer has access/);
      hub.computerManagement.release(granted);
    } finally {
      await hub.shutdown();
      store.close();
    }
  });

  it("kills the commands as soon as a computer change invalidates the lease, before the run has even ended", { timeout: 5000 }, async () => {
    const docker = blockingDocker();
    const { store, hub, ana } = await sharedPair(docker);
    try {
      const anaRun = await hub.computerManagement.prepare(ana.id);
      const running = hub.computers.guest.run(ana.id, leaseOf(anaRun), "make all", 600);
      await docker.started.promise;
      hub.updateAgent(ana.id, { computer: "mac" });
      await docker.killed.promise;
      assert.ok(killIndex(docker.calls, anaRun.computerLeaseId) >= 0);
      docker.finish.resolve(KILLED);
      await running;
      hub.computerManagement.release(anaRun);
    } finally {
      await hub.shutdown();
      store.close();
    }
  });

  it("stops the computer before the next lease when the kill itself fails", { timeout: 5000 }, async () => {
    const failed: CommandResult = { code: 1, stdout: Buffer.alloc(0), stderr: "exec failed" };
    const docker = blockingDocker(() => failed);
    const { store, hub, ana, bob, shared } = await sharedPair(docker);
    try {
      const anaRun = await hub.computerManagement.prepare(ana.id);
      const running = hub.computers.guest.run(ana.id, leaseOf(anaRun), "sleep 1000", 600);
      await docker.started.promise;
      docker.finish.resolve(KILLED);
      await running;
      const bobRun = hub.computerManagement.prepare(bob.id);
      hub.computerManagement.release(anaRun);
      const granted = await bobRun;
      const stop = docker.calls.findIndex((call) => call.args.join(" ") === `stop -t 3 hive-${shared.id}`);
      const kill = killIndex(docker.calls, anaRun.computerLeaseId);
      assert.ok(kill >= 0 && stop > kill, "the computer was stopped after the failed kill");
      hub.computerManagement.release(granted);
    } finally {
      await hub.shutdown();
      store.close();
    }
  });

  it("releases at once, with no kill, when a lease never ran a guest command", async () => {
    const docker = blockingDocker();
    const { store, hub, ana, bob } = await sharedPair(docker);
    try {
      const anaRun = await hub.computerManagement.prepare(ana.id);
      hub.computerManagement.release(anaRun);
      assert.equal(hub.computerManagement.leases.isLeased(anaRun.computerId), false);
      hub.computerManagement.release(await hub.computerManagement.prepare(bob.id));
      assert.equal(docker.calls.filter((call) => call.args.includes("hive-lease-kill")).length, 0);
    } finally {
      await hub.shutdown();
      store.close();
    }
  });
});

describe("lease drain bounds", () => {
  it("stops the computer when an ended lease's calls don't settle, then lets the lease go", async () => {
    const stops: string[] = [];
    const leases = new GuestLeases({ kill: async () => true, stop: async (computerId) => void stops.push(computerId) }, 0);
    leases.begin("5f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c");
    await leases.drain({ id: "5f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c", computerId: "computer-1" });
    assert.deepEqual(stops, ["computer-1"]);
  });

  it("passes the lease id and command as separate arguments and refuses a lease id that isn't a UUID", () => {
    const lease = "5f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
    const wrapped = leaseCommand(lease, ["bash", "-lc", "echo $HOME; rm -rf /"]);
    assert.deepEqual(wrapped.slice(3), ["hive-lease", lease, "bash", "-lc", "echo $HOME; rm -rf /"]);
    assert.ok(!(wrapped[2] ?? "").includes(lease));
    assert.deepEqual(leaseKillCommand(lease).slice(3), ["hive-lease-kill", lease]);
    assert.throws(() => leaseCommand("x; reboot", ["id"]), /not a lease id/);
    assert.throws(() => leaseKillCommand("../x"), /not a lease id/);
  });
});

describe("browser session", () => {
  it("starts Chromium on a blank page after the D-Bus address is written, with the flags Hive's open uses", () => {
    const session = readFileSync(new URL("../../sandbox/computer/hive-session-browser", import.meta.url), "utf8");
    const flags = /exec chromium (.*) -- "\$1"/.exec(BROWSER_SCRIPT)?.[1];
    assert.ok(flags);
    const start = session.indexOf(`chromium ${flags} --start-maximized -- about:blank`);
    assert.ok(start > session.indexOf("dbus-address; chmod 600"), "Chromium starts after the D-Bus address file is written");
    assert.ok(!session.includes("HIVE_LEASE") && !session.includes("setsid"));
    assert.match(session, /SingletonLock/);
  });
});
