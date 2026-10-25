import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { buildNewAgent } from "../src/agents.ts";
import type { EngineHost } from "../src/computerEngines.ts";
import { ComputerService } from "../src/computerService.ts";
import { Store } from "../src/db.ts";
import type { Engine } from "../src/engineAttest.ts";
import { Hub } from "../src/hub.ts";
import { startServer } from "../src/server.ts";
import { call, fakeDocker, field, freePort, removeTempDirs } from "./fixtures.ts";

const UI_SECRET = "u".repeat(64);
const NOW = "2026-10-24T12:00:00.000Z";
const ORB: Engine = { provider: "orbstack", name: "OrbStack", endpoint: "unix:///h/.orbstack/run/docker.sock", version: "2.2.5" };

describe("moving a computer to the engine in use", () => {
  const oldEngine = fakeDocker();
  const newEngine = fakeDocker();
  const host: EngineHost = {
    active: async () => ({ status: "ready", engine: ORB }),
    attest: async (provider) => provider === "orbstack" ? { status: "ready", engine: ORB } : { status: "stopped", provider: "Docker Desktop", detail: "Docker Desktop isn't running.", version: null },
    runner: (engine) => engine.provider === "orbstack" ? newEngine.runner : oldEngine.runner,
  };
  const store = new Store(":memory:");
  const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService({ engines: host }), {
    runtimeReady: async () => ({ ready: true, detail: "ready", profiles: ["terminal" as const] }),
  });
  const agent = buildNewAgent({ name: "Ana" }, []);
  let server: Server;
  let port = 0;
  let runToken = "";
  let computerId = "";
  const path = () => `/api/computers/${computerId}/move-engine`;

  before(async () => {
    store.insertAgent(agent, NOW);
    runToken = hub.runTokens.issue(agent.id);
    computerId = (await hub.computerManagement.create("Shared", "docker", "terminal")).id;
    store.computers.setEngine(computerId, "docker-desktop", NOW);
    port = await freePort();
    server = startServer({ hub, uiSecret: UI_SECRET, port, webDir: "/nonexistent" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  });

  after(async () => {
    server.closeAllConnections();
    server.close();
    await hub.shutdown();
    removeTempDirs();
  });

  it("is refused without the UI secret and with a run token", async () => {
    assert.equal((await call(port, "POST", path(), { body: {} })).status, 401);
    assert.equal((await call(port, "POST", path(), { token: runToken, body: {} })).status, 401);
    assert.equal(store.computers.get(computerId)?.engine, "docker-desktop");
  });

  it("takes an empty body only", async () => {
    assert.equal((await call(port, "POST", path(), { token: UI_SECRET, body: { engine: "orbstack" } })).status, 400);
  });

  it("rebinds to the active engine without a single call to the old one", async () => {
    const reply = await call(port, "POST", path(), { token: UI_SECRET, body: {} });
    assert.equal(reply.status, 200);
    assert.equal(field(reply.body, "engine"), "orbstack");
    assert.equal(store.computers.get(computerId)?.engine, "orbstack");
    assert.deepEqual(oldEngine.calls, []);
    const again = await call(port, "POST", path(), { token: UI_SECRET, body: {} });
    assert.equal(again.status, 422);
    assert.match(String(field(again.body, "error")), /already uses OrbStack/);
  });

  it("answers 404 for an unknown computer", async () => {
    assert.equal((await call(port, "POST", "/api/computers/00000000-0000-4000-8000-00000000dead/move-engine", { token: UI_SECRET, body: {} })).status, 404);
  });
});
