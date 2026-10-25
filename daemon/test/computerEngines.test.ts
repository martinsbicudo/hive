import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { EngineHost } from "../src/computerEngines.ts";
import { ComputerService, type ComputerConfig } from "../src/computerService.ts";
import type { CommandResult } from "../src/docker.ts";
import type { Engine, EngineVerdict } from "../src/engineAttest.ts";
import { PROVIDERS, type ProviderId } from "../src/engineSocket.ts";
import { fakeDocker, removeTempDirs, type Call } from "./fixtures.ts";

after(removeTempDirs);

const INSTANCE = "0b6f3c1e-8d2a-4c55-9a7e-3f1d2b4c5a6e";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const failed = (): CommandResult => ({ code: 1, stdout: Buffer.from(""), stderr: "No such volume" });

const ENGINES: Record<ProviderId, Engine> = {
  "docker-desktop": { provider: "docker-desktop", name: "Docker Desktop", endpoint: "unix:///h/.docker/run/docker.sock", version: "4.91.0" },
  orbstack: { provider: "orbstack", name: "OrbStack", endpoint: "unix:///h/.orbstack/run/docker.sock", version: "2.2.5" },
};

// One fake Docker per engine; each knows only the home volumes and containers that live in it.
function fakeEngine(homes: string[] = [], listed: string[] = []) {
  const volumes = new Set(homes.map((id) => `hive-home-${id}`));
  return fakeDocker((args) => {
    if (args[0] === "volume" && args[1] === "inspect") return volumes.has(args.at(-1) ?? "") ? null : failed();
    if (args[0] === "volume" && args[1] === "create") volumes.add(args.at(-1) ?? "");
    if (args[0] === "ps" && args[1] === "-a") return { code: 0, stdout: Buffer.from(listed.map((id) => `c-${id}\t${id}\tcomputer`).join("\n")), stderr: "" };
    return null;
  }, INSTANCE);
}

function world(active: ProviderId | null, homes: Partial<Record<ProviderId, string[]>> = {}, listed: Partial<Record<ProviderId, string[]>> = {}) {
  const docker = { "docker-desktop": fakeEngine(homes["docker-desktop"], listed["docker-desktop"]), orbstack: fakeEngine(homes.orbstack, listed.orbstack) };
  const state = { active, present: new Set<ProviderId>(["docker-desktop", "orbstack"]), checking: Promise.resolve() };
  const down = (provider: ProviderId): EngineVerdict => ({ status: "stopped", provider: PROVIDERS[provider].name, detail: `${PROVIDERS[provider].name} isn't running.`, version: null });
  const host: EngineHost = {
    active: async () => {
      await state.checking;
      return state.active ? { status: "ready", engine: ENGINES[state.active] } : { status: "missing", provider: "Docker-compatible engine", detail: "Docker Desktop or OrbStack isn't installed.", version: null };
    },
    attest: async (provider) => state.present.has(provider) ? { status: "ready", engine: ENGINES[provider] } : down(provider),
    runner: (engine) => docker[engine.provider].runner,
  };
  const configs = new Map<string, ComputerConfig>();
  for (const id of [A, B]) configs.set(id, { id, name: id, runtime: "docker", profile: "terminal", engine: null, revision: 1, memberAgentIds: [id] });
  const bound: [string, ProviderId][] = [];
  const service = new ComputerService({
    instanceId: INSTANCE, engines: host,
    computerResources: () => [...configs.values()],
    computerForAgent: (id) => configs.get(id) ?? null,
    bindEngine: (id, provider) => {
      bound.push([id, provider]);
      const config = configs.get(id);
      if (config) configs.set(id, { ...config, engine: provider });
    },
  });
  const use = (provider: ProviderId | null) => {
    state.active = provider;
    service.engines().refresh();
  };
  return { docker, state, service, configs, bound, use };
}

const did = (calls: Call[], ...prefix: string[]) => calls.some((call) => prefix.every((part, index) => call.args[index] === part));

describe("computers bound to their engine", () => {
  it("binds a computer with no home anywhere to the active engine and starts it there", async () => {
    const w = world("orbstack");
    await w.service.ensureRunning(A);
    assert.deepEqual(w.bound, [[A, "orbstack"]]);
    assert.ok(did(w.docker.orbstack.calls, "volume", "create"));
    assert.ok(!did(w.docker["docker-desktop"].calls, "volume", "create"));
  });

  it("binds a computer whose home is in Docker Desktop there, and refuses to start it on OrbStack instead of making a new home", async () => {
    const w = world("orbstack", { "docker-desktop": [A] });
    await assert.rejects(w.service.ensureRunning(A), /files are in Docker Desktop, but the active engine is OrbStack/);
    assert.deepEqual(w.bound, [[A, "docker-desktop"]]);
    for (const engine of Object.values(w.docker)) assert.ok(!did(engine.calls, "volume", "create") && !did(engine.calls, "run"));
    assert.equal(w.service.statusOf(A).state, "error");
  });

  it("refuses to start a computer bound to an engine that isn't the active one, naming both", async () => {
    const w = world("docker-desktop");
    w.configs.set(A, { ...w.configs.get(A) ?? assert.fail("A"), engine: "orbstack" });
    await assert.rejects(w.service.ensureRunning(A), /files are in OrbStack, but the active engine is Docker Desktop/);
    assert.ok(!did(w.docker["docker-desktop"].calls, "run") && !did(w.docker.orbstack.calls, "run"));
  });

  it("starts once an engine appears, without a daemon restart", async () => {
    const w = world(null);
    await assert.rejects(w.service.ensureRunning(A), /isn't installed/);
    w.use("orbstack");
    await w.service.ensureRunning(A);
    assert.equal(w.service.statusOf(A).state, "running");
  });

  it("stops every running computer through its own engine on Pause, idle and shutdown", async () => {
    const w = world("docker-desktop");
    await w.service.ensureRunning(A);
    w.use("orbstack");
    await w.service.ensureRunning(B);
    assert.equal(w.service.anyActive(), true);
    await w.service.stopAll();
    assert.ok(did(w.docker["docker-desktop"].calls, "stop", "-t", "3", `hive-${A}`));
    assert.ok(did(w.docker.orbstack.calls, "stop", "-t", "3", `hive-${B}`));
    assert.ok(!w.docker.orbstack.calls.some((call) => call.args.includes(`hive-${A}`)));
    assert.equal(w.service.anyActive(), false);
  });

  it("stops a computer that Pause catches while its engine is still being checked, before it runs anything", async () => {
    const w = world("orbstack");
    let release: () => void = () => undefined;
    w.state.checking = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    w.service.setStartGuard(() => paused ? "Hive is paused." : null);
    const starting = w.service.ensureRunning(A);
    paused = true;
    const stopping = w.service.stopAll();
    release();
    await assert.rejects(starting, /paused/);
    await stopping;
    assert.ok(!did(w.docker.orbstack.calls, "run"));
    assert.equal(w.service.statusOf(A).state, "stopped");
  });

  it("waits for a start that shutdown catches during the engine check, then stops that computer", async () => {
    const w = world("orbstack");
    let release: () => void = () => undefined;
    w.state.checking = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starting = w.service.ensureRunning(A);
    const stopping = w.service.shutdown();
    release();
    await starting;
    await stopping;
    assert.ok(did(w.docker.orbstack.calls, "stop", "-t", "3", `hive-${A}`));
    assert.equal(w.service.statusOf(A).state, "stopped");
  });

  it("reconciles each answering engine through its own socket only", async () => {
    const stray = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const w = world("orbstack", {}, { "docker-desktop": [stray] });
    await w.service.reconcile(new Set([A, B]));
    assert.ok(did(w.docker["docker-desktop"].calls, "rm", "-f", `c-${stray}`));
    assert.ok(!w.docker.orbstack.calls.some((call) => call.args[0] === "rm"));
    w.state.present.delete("docker-desktop");
    const before = w.docker["docker-desktop"].calls.length;
    await w.service.reconcile(new Set([A, B]));
    assert.equal(w.docker["docker-desktop"].calls.length, before);
  });

  it("moves a stopped computer to the active engine without touching the old engine, and starts it with a new home", async () => {
    const w = world("orbstack", { "docker-desktop": [A] });
    await assert.rejects(w.service.ensureRunning(A), /files are in Docker Desktop/);
    const oldCalls = w.docker["docker-desktop"].calls.length;
    assert.equal(await w.service.moveEngine(A), "orbstack");
    assert.equal(w.docker["docker-desktop"].calls.length, oldCalls);
    assert.equal(w.configs.get(A)?.engine, "orbstack");
    await w.service.ensureRunning(A);
    assert.ok(did(w.docker.orbstack.calls, "volume", "create"));
    assert.ok(!did(w.docker["docker-desktop"].calls, "volume", "rm"));
    assert.equal(w.docker["docker-desktop"].calls.length, oldCalls);
  });

  it("refuses to move a running computer, or one already on the active engine", async () => {
    const w = world("orbstack");
    await w.service.ensureRunning(A);
    await assert.rejects(w.service.moveEngine(A), /stop this computer before moving it/);
    await w.service.stop(A);
    await assert.rejects(w.service.moveEngine(A), /already uses OrbStack/);
  });

  it("removes a deleted computer from its bound engine only", async () => {
    const w = world("orbstack", { "docker-desktop": [A], orbstack: [A] });
    w.configs.set(A, { ...w.configs.get(A) ?? assert.fail("A"), engine: "docker-desktop" });
    await w.service.removeComputer(A);
    assert.ok(did(w.docker["docker-desktop"].calls, "volume", "rm"));
    assert.ok(!did(w.docker.orbstack.calls, "volume", "rm"));
  });
});
