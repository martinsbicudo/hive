import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { buildNewAgent } from "../src/agents.ts";
import { ComputerService } from "../src/computerService.ts";
import { Hub } from "../src/hub.ts";
import { Store } from "../src/db.ts";
import type { RuntimeReadiness } from "../src/computerManagement.ts";
import { fakeDocker } from "./fixtures.ts";

describe("computer resource mutations", () => {
  it("holds a profile mutation gate while provider readiness is pending", async () => {
    const store = new Store(":memory:");
    const agent = buildNewAgent({ name: "Ana", computer: "virtual" }, []);
    store.insertAgent(agent, new Date().toISOString());
    const docker = fakeDocker();
    const readiness: { complete?: (readiness: RuntimeReadiness) => void } = {};
    const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService({ docker: () => docker.runner }), {
      runtimeReady: () => new Promise((resolve) => { readiness.complete = resolve; }),
    });
    try {
      const resource = store.computers.forAgent(agent.id);
      assert.ok(resource);
      const updating = hub.computerManagement.update(resource.id, { profile: "terminal" });
      let prepared = false;
      const preparing = hub.computerManagement.prepare(agent.id).then((binding) => {
        prepared = true;
        return binding;
      });
      preparing.catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(prepared, false);
      assert.equal(docker.calls.length, 0);
      assert.ok(readiness.complete);
      readiness.complete({ ready: true, detail: "ready", profiles: ["terminal"] });
      await updating;
      await assert.rejects(preparing, /configuration changed/);
      assert.equal(prepared, false);
      assert.equal(store.computers.forAgent(agent.id)?.profile, "terminal");
      assert.equal(docker.calls.length, 0);
    } finally {
      await hub.shutdown();
      store.close();
    }
  });

  it("does not queue a state broadcast while shutdown stops computers", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const store = new Store(":memory:");
    const agent = buildNewAgent({ name: "Ana", computer: "virtual" }, []);
    store.insertAgent(agent, new Date().toISOString());
    const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService({ docker: () => fakeDocker().runner }), {
      runtimeReady: async () => ({ ready: true, detail: "ready", profiles: ["terminal"] }),
    });
    let closed = false;
    try {
      const resource = store.computers.forAgent(agent.id);
      assert.ok(resource);
      await hub.computerManagement.update(resource.id, { profile: "terminal" });
      const binding = await hub.computerManagement.prepare(agent.id);
      hub.computerManagement.release(binding);
      await hub.shutdown();
      store.close();
      closed = true;
      assert.doesNotThrow(() => mock.timers.tick(50));
    } finally {
      if (!closed) {
        await hub.shutdown();
        store.close();
      }
      mock.timers.reset();
    }
  });

  it("deleting an agent attached to a shared computer also removes its own private computer and home", async () => {
    const store = new Store(":memory:");
    const agent = buildNewAgent({ name: "Ana", computer: "virtual" }, []);
    store.insertAgent(agent, new Date().toISOString());
    const docker = fakeDocker();
    const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService({ docker: () => docker.runner }), {
      runtimeReady: async () => ({ ready: true, detail: "ready", profiles: ["terminal"] }),
    });
    try {
      const shared = await hub.computerManagement.create("Shared", "docker", "terminal");
      await hub.computerManagement.attach(agent.id, shared.id);
      assert.equal(store.computers.get(agent.id)?.managed, false);
      await hub.deleteAgent(agent.id);
      assert.equal(store.computers.get(agent.id), null);
      assert.ok(docker.calls.some((call) => call.args.join(" ") === `volume rm -f hive-home-${agent.id}`));
      assert.equal(store.computers.get(shared.id)?.managed, true);
      assert.ok(!docker.calls.some((call) => call.args.join(" ") === `volume rm -f hive-home-${shared.id}`));
    } finally {
      await hub.shutdown();
      store.close();
    }
  });
});
