import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildNewAgent } from "../src/agents.ts";
import { ComputerService } from "../src/computerService.ts";
import { BROWSER_READY_SCRIPT, DESKTOP_READY_SCRIPT } from "../src/computerServiceHelpers.ts";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { startServer } from "../src/server.ts";
import { call, fakeDocker, field, freePort, removeTempDirs, tar, tempDir } from "./fixtures.ts";

const NOW = "2026-10-21T12:00:00.000Z";
const UI_SECRET = "s".repeat(64);
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

describe("virtual computer routes", () => {
  const docker = fakeDocker((args) => {
    if (args.includes("/bin/tar")) return { code: 0, stdout: tar([{ name: "report.txt", data: "quarterly" }]), stderr: "" };
    if (args.includes("hive-shot")) return { code: 0, stdout: PNG, stderr: "" };
    return null;
  });
  const downloads = join(tempDir("hive-downloads-"), "Hive");
  const store = new Store(":memory:");
  const service = new ComputerService({ docker: () => docker.runner, downloadsRoot: downloads, stageRoot: join(tempDir("hive-stage-"), "private") });
  const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, service, {
    runtimeReady: async () => ({ ready: true, detail: "fake runtime ready", profiles: ["terminal", "browser", "desktop"] }),
  });
  const ana = buildNewAgent({ name: "Ana", computer: "virtual" }, []);
  const bob = buildNewAgent({ name: "Bob", computer: "virtual" }, ["Ana"]);
  const max = buildNewAgent({ name: "Max" }, ["Ana", "Bob"]);
  let server: Server;
  let port = 0;
  let anaToken = "";
  let maxToken = "";
  const leaseByAgent = new Map<string, string>();

  async function virtualToken(agentId: string): Promise<string> {
    const resource = store.computers.forAgent(agentId);
    if (!resource) throw new Error("virtual test agent has no computer resource");
    const oldLease = leaseByAgent.get(agentId);
    if (oldLease) hub.computerManagement.leases.release(oldLease);
    const lease = await hub.computerManagement.leases.acquire(agentId, resource.id, resource.revision);
    leaseByAgent.set(agentId, lease.id);
    return hub.runTokens.issue(agentId, {
      agentId, taskId: null, hop: 0, origin: "user", tainted: true, nonce: "n".repeat(32),
      launchedVirtual: true, launchedConnectors: [], computerId: resource.id, computerRevision: resource.revision,
      computerRuntime: resource.runtime, computerProfile: resource.profile, computerLeaseId: lease.id,
    });
  }

  function releaseAgentLease(agentId: string): void {
    const lease = leaseByAgent.get(agentId);
    if (lease) hub.computerManagement.leases.release(lease);
    leaseByAgent.delete(agentId);
  }

  const internal = (route: string, body: unknown, token = anaToken) => call(port, "POST", `/internal/computer/${route}`, { token, body });
  const execCalls = () => docker.calls.filter((entry) => entry.args[0] === "exec" && !entry.args.includes("vnc")).length;

  before(async () => {
    for (const agent of [ana, bob, max]) store.insertAgent(agent, NOW);
    anaToken = await virtualToken(ana.id);
    maxToken = hub.runTokens.issue(max.id);
    port = await freePort();
    server = startServer({ hub, uiSecret: UI_SECRET, port, webDir: "/nonexistent" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  });

  after(() => {
    server.closeAllConnections();
    server.close();
    for (const agentId of leaseByAgent.keys()) releaseAgentLease(agentId);
    hub.shutdown();
    removeTempDirs();
  });

  it("guards the screen with the UI secret and answers 409 while the computer is off", async () => {
    const path = `/api/agents/${ana.id}/computer/screen`;
    assert.equal((await call(port, "GET", path)).status, 401);
    assert.equal((await call(port, "GET", path, { token: anaToken })).status, 401);
    assert.equal((await call(port, "GET", path, { token: UI_SECRET })).status, 409);
  });

  it("rejects run tokens on every public computer route", async () => {
    for (const [method, suffix] of [["GET", ""], ["POST", "/start"], ["POST", "/stop"], ["GET", "/screen"]] as const) {
      assert.equal((await call(port, method, `/api/agents/${ana.id}/computer${suffix}`, { token: anaToken })).status, 401, suffix);
    }
  });

  it("reports state, and refuses computer routes for an agent on the Mac", async () => {
    assert.deepEqual(await call(port, "GET", `/api/agents/${ana.id}/computer`, { token: UI_SECRET }), {
      status: 200, body: { state: "stopped", computerId: ana.id, profile: "desktop", hasScreen: true },
    });
    assert.equal((await call(port, "GET", `/api/agents/${max.id}/computer`, { token: UI_SECRET })).status, 403);
    assert.equal((await internal("run", { command: "id" }, maxToken)).status, 403);
    assert.equal((await internal("run", { command: "id" }, UI_SECRET)).status, 401);
  });

  it("binds every internal call to the token's agent, whatever the body says", async () => {
    const reply = await internal("run", { agentId: bob.id, command: "id" });
    assert.equal(reply.status, 200);
    const runs = docker.calls.filter((entry) => entry.args[0] === "exec" && entry.args.includes("bash"));
    assert.ok(runs.length > 0);
    for (const entry of runs) {
      assert.ok(entry.args.includes(`hive-${ana.id}`));
      assert.ok(!entry.args.some((arg) => arg.includes(bob.id)));
    }
    assert.ok(!docker.calls.some((entry) => entry.args.some((arg) => arg.includes(bob.id))));
  });

  it("hands out screen secrets only through the screen route, never in the state", async () => {
    const reply = await call(port, "GET", `/api/agents/${ana.id}/computer/screen`, { token: UI_SECRET });
    assert.equal(reply.status, 200);
    const token = field(reply.body, "token");
    const password = field(reply.body, "password");
    assert.ok(typeof token === "string" && token.length === 64);
    assert.ok(typeof password === "string" && password.length > 0);
    assert.equal(field(reply.body, "port"), 61234);
    const state = JSON.stringify(hub.state());
    assert.ok(!state.includes(token) && !state.includes(password));
    assert.ok(state.includes('"state":"running"'));
    const wire = JSON.stringify((await call(port, "GET", "/api/state", { token: UI_SECRET })).body);
    assert.ok(!wire.includes(token) && !wire.includes(password));
  });

  it("drives the desktop with argv-only commands as the agent user", async () => {
    assert.equal((await internal("click", { x: 10, y: 20, button: "right" })).status, 200);
    assert.equal((await internal("type", { text: "hello; rm -rf /" })).status, 200);
    assert.equal((await internal("key", { keys: "ctrl+l Return" })).status, 200);
    const url = "https://example.com/?q=$(touch%20/tmp/hive-url-injection)";
    assert.equal((await internal("open", { url })).status, 200);
    const screenshot = await internal("screenshot", {});
    assert.equal(field(screenshot.body, "data"), PNG.toString("base64"));
    const typed = docker.calls.find((entry) => entry.args.includes("type"));
    assert.equal(typed?.input, "hello; rm -rf /");
    assert.ok(!typed?.args.includes("hello; rm -rf /"));
    const opened = docker.calls.findLast((entry) => entry.args.includes("hive-open"));
    const browserScript = opened?.args[opened.args.indexOf("-c") + 1];
    assert.deepEqual(opened?.args.slice(-2), ["hive-open", url]);
    assert.equal(opened?.args[opened.args.indexOf("-u") + 1], "agent");
    assert.ok(typeof browserScript === "string");
    assert.ok(browserScript.includes("$1") && browserScript.includes("DBUS_SESSION_BUS_ADDRESS") && browserScript.includes("--ozone-platform=x11"));
    assert.ok(!browserScript.includes(url));
    for (const entry of [typed, opened]) assert.equal(entry?.args[entry.args.indexOf("-u") + 1], "agent");
    const openedAt = opened ? docker.calls.lastIndexOf(opened) : -1;
    assert.ok(openedAt >= 0);
    const waited = docker.calls.slice(openedAt + 1).find((entry) => entry.args.includes(BROWSER_READY_SCRIPT));
    assert.ok(waited, "open waits for a visible Chromium window before returning");
    assert.equal(waited.args[waited.args.indexOf("-u") + 1], "agent");
    assert.ok(!waited.args.includes("-d"), "the wait isn't detached, so the next screenshot follows it");
    assert.ok(docker.calls.some((entry) => entry.args.includes(DESKTOP_READY_SCRIPT)), "a screen start waits for the window manager");
  });

  it("reads and writes files under the workspace, passing the path as an argument", async () => {
    const written = await internal("write", { path: "notes/a.txt", content: "hi" });
    assert.deepEqual(written.body, { path: "/home/agent/workspace/notes/a.txt", bytes: 2 });
    const write = docker.calls.find((entry) => entry.args.includes("hive-write"));
    assert.equal(write?.args.at(-1), "/home/agent/workspace/notes/a.txt");
    assert.equal(write?.input, "hi");
    const read = await internal("read", { path: "../x" });
    assert.equal(field(read.body, "path"), "/home/agent/x");
    const head = docker.calls.findLast((entry) => entry.args.includes("head"));
    assert.deepEqual(head?.args.slice(-4), ["-c", String(200 * 1024 + 1), "--", "/home/agent/x"]);
  });

  it("rejects bad input on every route before running anything", async () => {
    const bad: [string, unknown][] = [
      ["run", {}], ["run", { command: "id", timeout_s: 601 }], ["run", { command: "id", timeout_s: 0 }], ["run", { command: "id", user: "root" }],
      ["run", { command: "x".repeat(33 * 1024) }],
      ["screenshot", { x: 1 }],
      ["click", { x: -1, y: 0 }], ["click", { x: 1440, y: 0 }], ["click", { x: 0, y: 900 }], ["click", { x: 1.5, y: 0 }], ["click", { x: 1, y: 1, button: "back" }],
      ["type", { text: "" }], ["type", { text: "x".repeat(4001) }],
      ["key", { keys: "ctrl+l; rm" }], ["key", { keys: "--help" }], ["key", { keys: "$(id)" }], ["key", { keys: Array(17).fill("a").join(" ") }],
      ["open", { url: "file:///etc/passwd" }], ["open", { url: "javascript:alert(1)" }], ["open", { url: "http://a b" }], ["open", { url: "-x" }],
      ["read", { path: "" }], ["read", { path: "a\nb" }], ["read", {}],
      ["write", { path: "a.txt", content: "x".repeat(200 * 1024 + 1) }], ["write", { content: "x" }],
      ["export", { path: "/etc/passwd" }], ["export", { path: "../../etc/shadow" }], ["export", {}],
    ];
    const before = execCalls();
    for (const [route, body] of bad) assert.equal((await internal(route, body)).status, 400, `${route} ${JSON.stringify(body).slice(0, 60)}`);
    assert.equal((await internal("shell", { command: "id" })).status, 404);
    assert.equal(execCalls(), before);
    assert.equal(store.pendingApprovals().length, 0);
  });

  it("asks before every export, even after the user chose Always allow", async () => {
    anaToken = await virtualToken(ana.id);
    const first = await internal("export", { path: "report.txt" });
    const approvalId = field(first.body, "approvalId");
    assert.ok(typeof approvalId === "string");
    assert.equal(store.getApproval(approvalId)?.rememberable, false);
    assert.equal(existsSync(join(downloads, ana.id)), false);
    assert.equal((await call(port, "POST", `/api/approvals/${approvalId}`, { token: UI_SECRET, body: { allow: true, remember: true } })).status, 200);
    assert.deepEqual(store.getAgent(ana.id)?.allowedTools, []);
    const second = await internal("export", { path: "/home/agent/workspace/report.txt" });
    assert.equal(second.status, 200);
    const path = field(second.body, "path");
    assert.ok(typeof path === "string");
    assert.equal(readFileSync(path, "utf8"), "quarterly");
    const third = await internal("export", { path: "report.txt" });
    assert.ok(typeof field(third.body, "approvalId") === "string");
    assert.notEqual(field(third.body, "approvalId"), approvalId);
  });

  it("doesn't let one agent's approved export be used by another", async () => {
    anaToken = await virtualToken(ana.id);
    const bobToken = await virtualToken(bob.id);
    const asked = await internal("export", { path: "shared.txt" }, bobToken);
    const approvalId = field(asked.body, "approvalId");
    assert.ok(typeof approvalId === "string");
    hub.decideApproval(approvalId, true, false);
    anaToken = await virtualToken(ana.id);
    const stolen = await internal("export", { path: "shared.txt" });
    assert.ok(typeof field(stolen.body, "approvalId") === "string");
    releaseAgentLease(bob.id);
  });

  it("doesn't re-arm an export when an already-decided approval is decided again", async () => {
    anaToken = await virtualToken(ana.id);
    const asked = await internal("export", { path: "replay.txt" });
    const approvalId = field(asked.body, "approvalId");
    assert.ok(typeof approvalId === "string");
    const decide = () => call(port, "POST", `/api/approvals/${approvalId}`, { token: UI_SECRET, body: { allow: true, remember: false } });
    assert.equal((await decide()).status, 200);
    assert.equal(typeof field((await internal("export", { path: "replay.txt" })).body, "path"), "string");
    const replay = await decide();
    assert.equal(replay.status, 200);
    assert.equal(field(replay.body, "status"), "allowed");
    const again = await internal("export", { path: "replay.txt" });
    assert.equal(typeof field(again.body, "path"), "undefined");
    assert.notEqual(field(again.body, "approvalId"), approvalId);
    assert.equal(typeof field(again.body, "approvalId"), "string");
  });

  it("drops an approved export, and denies a pending one, when the agent leaves the virtual computer", async () => {
    anaToken = await virtualToken(ana.id);
    const granted = field((await internal("export", { path: "switch.txt" })).body, "approvalId");
    assert.ok(typeof granted === "string");
    hub.decideApproval(granted, true, false);
    releaseAgentLease(ana.id);
    hub.updateAgent(ana.id, { computer: "mac" });
    hub.updateAgent(ana.id, { computer: "virtual" });
    anaToken = await virtualToken(ana.id);
    const afterGrantRevocation = await internal("export", { path: "switch.txt" });
    const replacement = field(afterGrantRevocation.body, "approvalId");
    assert.ok(typeof replacement === "string" && replacement !== granted);
    hub.decideApproval(replacement, true, false);
    assert.equal(typeof field((await internal("export", { path: "switch.txt" })).body, "path"), "string");
    const pending = field((await internal("export", { path: "pending.txt" })).body, "approvalId");
    assert.ok(typeof pending === "string");
    releaseAgentLease(ana.id);
    hub.updateAgent(ana.id, { computer: "mac" });
    assert.equal(store.getApproval(pending)?.status, "denied");
    hub.decideApproval(pending, true, false);
    hub.updateAgent(ana.id, { computer: "virtual" });
    anaToken = await virtualToken(ana.id);
    const after = await internal("export", { path: "pending.txt" });
    assert.equal(typeof field(after.body, "approvalId"), "string", JSON.stringify(after.body));
  });

  it("stops the computer and forgets its screen", async () => {
    assert.deepEqual(await call(port, "POST", `/api/agents/${ana.id}/computer/stop`, { token: UI_SECRET }), {
      status: 200, body: { state: "stopped", computerId: ana.id, profile: "desktop", hasScreen: true },
    });
    assert.equal((await call(port, "GET", `/api/agents/${ana.id}/computer/screen`, { token: UI_SECRET })).status, 409);
  });

  it("creates a managed resource, shares it by computer ID, detaches and deletes only after the last member leaves", async () => {
    releaseAgentLease(ana.id);
    releaseAgentLease(bob.id);
    const before = await call(port, "GET", "/api/computers", { token: UI_SECRET });
    assert.ok(Array.isArray(before.body));
    const created = await call(port, "POST", "/api/computers", {
      token: UI_SECRET, body: { name: "Research", runtime: "docker", profile: "browser" },
    });
    assert.equal(created.status, 201);
    const computerId = field(created.body, "id");
    assert.ok(typeof computerId === "string");
    assert.equal(field(created.body, "managed"), true);
    assert.equal((await call(port, "POST", "/api/computers", {
      token: UI_SECRET, body: { name: "bad", runtime: "docker", profile: "desktop", surprise: true },
    })).status, 400);
    for (const agent of [ana, bob]) {
      const attached = await call(port, "PUT", `/api/agents/${agent.id}/computer`, { token: UI_SECRET, body: { computerId } });
      assert.equal(attached.status, 200);
      assert.equal(field(attached.body, "computerId"), computerId);
      assert.equal(field(attached.body, "id"), agent.id);
    }
    const shared = await call(port, "GET", `/api/computers/${computerId}`, { token: UI_SECRET });
    assert.deepEqual(field(shared.body, "members"), [{ agentId: ana.id, name: "Ana" }, { agentId: bob.id, name: "Bob" }]);
    assert.equal((await call(port, "DELETE", `/api/computers/${computerId}`, { token: UI_SECRET })).status, 400);
    for (const agent of [ana, bob]) {
      const detached = await call(port, "DELETE", `/api/agents/${agent.id}/computer`, { token: UI_SECRET });
      assert.deepEqual(detached, { status: 200, body: { ok: true } });
    }
    assert.deepEqual(await call(port, "DELETE", `/api/computers/${computerId}`, { token: UI_SECRET }), { status: 200, body: { ok: true } });
  });
});
