import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { buildNewAgent } from "../src/agents.ts";
import { ComputerService } from "../src/computerService.ts";
import { Store } from "../src/db.ts";
import { setupStatusSchema } from "../src/engineSetupStatus.ts";
import { Hub } from "../src/hub.ts";
import { startServer } from "../src/server.ts";
import { fakeTimers, until, World } from "./engineSetupFixtures.ts";
import { call, fakeDocker, field, freePort, removeTempDirs } from "./fixtures.ts";

const UI_SECRET = "u".repeat(64);
const PATH = "/api/computers/setup";

describe("engine setup routes", () => {
  const world = new World();
  world.block = (entry) => entry.file === "/usr/bin/sw_vers";
  const store = new Store(":memory:");
  const service = new ComputerService({ docker: () => fakeDocker().runner });
  const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, service, { setupEffects: world.effects(fakeTimers(), { paused: () => store.settings.paused() }) });
  const agent = buildNewAgent({ name: "Ana" }, []);
  let server: Server;
  let port = 0;
  let runToken = "";

  before(async () => {
    store.insertAgent(agent, "2026-10-24T12:00:00.000Z");
    runToken = hub.runTokens.issue(agent.id);
    port = await freePort();
    server = startServer({ hub, uiSecret: UI_SECRET, port, webDir: "/nonexistent" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  });

  after(async () => {
    world.releaseAll();
    server.closeAllConnections();
    server.close();
    await hub.shutdown();
    removeTempDirs();
  });

  it("answers only with the UI secret; a run token can't reach it on /api or /internal", async () => {
    assert.equal((await call(port, "GET", PATH)).status, 401);
    assert.equal((await call(port, "POST", PATH, { token: runToken, body: { provider: "orbstack" } })).status, 401);
    assert.equal((await call(port, "DELETE", PATH, { token: runToken })).status, 401);
    assert.equal((await call(port, "POST", "/internal/computers/setup", { token: runToken, body: { provider: "orbstack" } })).status, 404);
    assert.ok((await call(port, "POST", "/internal/computer/setup", { token: runToken, body: { provider: "orbstack" } })).status >= 400);
    assert.deepEqual(world.calls, []);
  });

  it("serves the status at computers/setup instead of treating setup as a computer id", async () => {
    const reply = await call(port, "GET", PATH, { token: UI_SECRET });
    assert.equal(reply.status, 200);
    const status = setupStatusSchema.parse(reply.body);
    assert.equal(status.state, "idle");
    assert.deepEqual(status.providers.map((entry) => [entry.id, entry.recommended]), [["orbstack", true], ["docker-desktop", false]]);
    assert.equal((await call(port, "PATCH", PATH, { token: UI_SECRET, body: { name: "x" } })).status, 404);
    assert.equal((await call(port, "GET", `${PATH}/extra`, { token: UI_SECRET })).status, 404);
  });

  it("takes exactly { provider }", async () => {
    for (const body of [{}, { provider: "podman" }, { provider: "orbstack", url: "https://evil.example/x.dmg" }]) {
      assert.equal((await call(port, "POST", PATH, { token: UI_SECRET, body })).status, 400);
    }
    assert.deepEqual(world.calls, []);
  });

  it("starts with 202, refuses a second one with 409, and cancels with DELETE", async () => {
    const started = await call(port, "POST", PATH, { token: UI_SECRET, body: { provider: "orbstack" } });
    assert.equal(started.status, 202);
    assert.equal(field(started.body, "state"), "running");
    assert.equal(field(started.body, "action"), "install");
    const second = await call(port, "POST", PATH, { token: UI_SECRET, body: { provider: "docker-desktop" } });
    assert.equal(second.status, 409);
    assert.match(String(field(second.body, "error")), /already running/);
    await until(() => world.blocked.length > 0, "the check");
    const cancelled = await call(port, "DELETE", PATH, { token: UI_SECRET });
    assert.equal(cancelled.status, 200);
    assert.equal(field(cancelled.body, "state"), "cancelled");
    assert.deepEqual(world.leftovers(), []);
  });

  it("Pause cancels a running setup, and a paused Hive refuses a new one", async () => {
    world.blocked.length = 0;
    assert.equal((await call(port, "POST", PATH, { token: UI_SECRET, body: { provider: "orbstack" } })).status, 202);
    await until(() => world.blocked.length > 0, "the check");
    assert.equal((await call(port, "POST", "/api/pause", { token: UI_SECRET })).status, 200);
    await hub.engineSetup.settled();
    assert.equal((await hub.engineSetup.status()).state, "cancelled");
    const refused = await call(port, "POST", PATH, { token: UI_SECRET, body: { provider: "orbstack" } });
    assert.equal(refused.status, 409);
    assert.match(String(field(refused.body, "error")), /paused/);
    assert.deepEqual(world.leftovers(), []);
  });
});
