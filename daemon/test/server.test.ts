import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { buildNewAgent } from "../src/agents.ts";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { startServer } from "../src/server.ts";
import { call, field, freePort } from "./fixtures.ts";

const NOW = "2026-10-21T12:00:00.000Z";
const UI_SECRET = "u".repeat(64);

function upgrade(port: number, token: string, host = `127.0.0.1:${port}`): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1", port, path: `/ws?token=${token}`,
      headers: { host, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    outgoing.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    outgoing.on("response", (response) => resolve(response.statusCode ?? 0));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("server auth", () => {
  const store = new Store(":memory:");
  const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" });
  const agentA = buildNewAgent({ name: "Ana" }, []);
  const agentB = buildNewAgent({ name: "Bob" }, ["Ana"]);
  let server: Server;
  let port = 0;
  let tokenA = "";

  before(async () => {
    store.insertAgent(agentA, NOW);
    store.insertAgent(agentB, NOW);
    tokenA = hub.runTokens.issue(agentA.id);
    port = await freePort();
    server = startServer({ hub, uiSecret: UI_SECRET, port, webDir: "/nonexistent" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  });

  after(() => {
    server.closeAllConnections();
    server.close();
    hub.shutdown();
  });

  it("accepts only the UI secret on /api", async () => {
    assert.equal((await call(port, "GET", "/api/state", { token: UI_SECRET })).status, 200);
    assert.equal((await call(port, "GET", "/api/state", { token: tokenA })).status, 401);
    assert.equal((await call(port, "GET", "/api/state")).status, 401);
    assert.equal((await call(port, "GET", `/api/state?token=${UI_SECRET}`)).status, 401);
  });

  it("accepts only live run tokens on /internal", async () => {
    const body = { toolName: "Bash", input: { command: "ls" } };
    assert.equal((await call(port, "POST", "/internal/approvals", { token: UI_SECRET, body })).status, 401);
    assert.equal((await call(port, "GET", "/internal/state", { token: tokenA })).status, 404);
    assert.equal((await call(port, "POST", `/internal/approvals?token=${tokenA}`, { body })).status, 401);
    const revoked = hub.runTokens.issue(agentA.id);
    hub.runTokens.revoke(revoked);
    assert.equal((await call(port, "POST", "/internal/approvals", { token: revoked, body })).status, 401);
  });

  it("files approvals under the token's agent, whatever the body says", async () => {
    const created = await call(port, "POST", "/internal/approvals", {
      token: tokenA, body: { agentId: agentB.id, toolName: "Bash", input: { command: "rm -rf /tmp/x" } },
    });
    assert.equal(created.status, 200);
    const id = field(created.body, "id");
    assert.ok(typeof id === "string" && id.length > 0);
    assert.equal(store.getApproval(id)?.agentId, agentA.id);
    assert.equal((await call(port, "POST", `/api/approvals/${id}`, { token: UI_SECRET, body: { allow: true } })).status, 200);
    const waited = await call(port, "GET", `/internal/approvals/${id}/wait`, { token: tokenA });
    assert.deepEqual(waited, { status: 200, body: { status: "allowed" } });
  });

  it("hides other agents' approvals from a run token", async () => {
    const other = hub.requestApproval(agentB.id, "Write", { file_path: "/x" });
    assert.equal((await call(port, "GET", `/internal/approvals/${other.id}/wait`, { token: tokenA })).status, 404);
    hub.approvals.decide(other.id, false);
  });

  it("rejects requests for any other Host, including /health", async () => {
    assert.equal((await call(port, "GET", "/health", { host: `localhost:${port}` })).status, 200);
    assert.equal((await call(port, "GET", "/health", { host: "evil.example" })).status, 403);
    assert.equal((await call(port, "GET", "/api/state", { token: UI_SECRET, host: `evil.example:${port}` })).status, 403);
    assert.equal((await call(port, "GET", "/", { host: `127.0.0.1:${port + 1}` })).status, 403);
  });

  it("upgrades /ws with the UI secret in the query only for the right Host", async () => {
    assert.equal(await upgrade(port, UI_SECRET), 101);
    assert.equal(await upgrade(port, tokenA), 401);
    assert.equal(await upgrade(port, UI_SECRET, "evil.example"), 403);
  });
});
