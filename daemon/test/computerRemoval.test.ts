import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { buildNewAgent } from "../src/agents.ts";
import { ComputerService } from "../src/computerService.ts";
import { Store } from "../src/db.ts";
import type { DockerRunner } from "../src/docker.ts";
import { Hub } from "../src/hub.ts";
import { fakeDocker, removeTempDirs } from "./fixtures.ts";
import { fakeEngine, until } from "./taskFixtures.ts";

const NOW = "2026-10-24T12:00:00.000Z";
const READY = async () => ({ ready: true, detail: "ready", profiles: ["terminal" as const] });

after(() => removeTempDirs());

// Holds every computer start at its image check until `open` runs, like a slow image build.
function slowStartDocker() {
  const base = fakeDocker();
  const gate = Promise.withResolvers<void>();
  let starts = 0;
  const runner: DockerRunner = async (args, options) => {
    if (args[0] === "image" && args[1] === "inspect") {
      starts += 1;
      await gate.promise;
    }
    return base.runner(args, options);
  };
  return { runner, open: () => gate.resolve(), starts: () => starts };
}

async function sharedPair(script: Record<string, unknown[][]>) {
  const engine = fakeEngine();
  engine.script(script);
  const store = new Store(":memory:");
  const ana = buildNewAgent({ name: "Ana" }, []);
  const bob = buildNewAgent({ name: "Bob" }, ["Ana"]);
  store.insertAgent(ana, NOW);
  store.insertAgent(bob, NOW);
  const docker = slowStartDocker();
  const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService({ docker: () => docker.runner }), {
    runtimeReady: READY, findEngine: () => engine.binary,
  });
  const shared = await hub.computerManagement.create("Shared", "docker", "terminal");
  await hub.computerManagement.attach(ana.id, shared.id);
  await hub.computerManagement.attach(bob.id, shared.id);
  const close = async () => {
    docker.open();
    await hub.shutdown();
    store.close();
  };
  return { store, hub, ana, bob, shared, docker, close };
}

describe("deleting an agent while a shared computer is still starting", () => {
  it("finishes when another member gets a new message during the delete", { timeout: 10_000 }, async () => {
    const h = await sharedPair({ Bob: [[{ say: "first" }], [{ say: "second" }]] });
    try {
      h.hub.send(h.bob.id, "first");
      await until(() => h.docker.starts() > 0, "Bob's computer start to begin");
      const deleting = h.hub.deleteAgent(h.ana.id);
      h.hub.send(h.bob.id, "second");
      h.docker.open();
      await deleting;
      assert.equal(h.store.getAgent(h.ana.id), null);
      await until(() => h.store.listMessages(h.bob.id, 50).some((message) => message.role === "assistant"), "Bob's next run to reply");
    } finally {
      await h.close();
    }
  });

  it("finishes when the agent being deleted gets another message during the delete", { timeout: 10_000 }, async () => {
    const h = await sharedPair({});
    try {
      h.hub.send(h.ana.id, "first");
      await until(() => h.docker.starts() > 0, "Ana's computer start to begin");
      const deleting = h.hub.deleteAgent(h.ana.id);
      h.hub.send(h.ana.id, "second");
      h.docker.open();
      await deleting;
      assert.equal(h.store.getAgent(h.ana.id), null);
      await h.hub.computerManagement.leases.waitForMutation(h.shared.id);
      h.hub.computerManagement.release(await h.hub.computerManagement.prepare(h.bob.id));
    } finally {
      await h.close();
    }
  });
});
