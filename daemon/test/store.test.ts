import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildNewAgent } from "../src/agents.ts";
import { Approvals } from "../src/approvals.ts";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { allowedOrigin } from "../src/auth.ts";
import { removeTempDirs, tempDir } from "./fixtures.ts";

after(removeTempDirs);

const NOW = "2026-10-21T12:00:00.000Z";

function storeWithAgent() {
  const store = new Store(":memory:");
  const agent = buildNewAgent({ name: "Josh", role: "Software Engineer", folders: ["/repo"] }, []);
  store.insertAgent(agent, NOW);
  return { store, agent };
}

describe("store", () => {
  it("round-trips an agent and applies partial updates", () => {
    const { store, agent } = storeWithAgent();
    store.updateAgent(agent.id, { role: "Code Reviewer", allowedTools: ["Write"], sessionId: "s1" }, NOW);
    const saved = store.getAgent(agent.id);
    assert.equal(saved?.name, "Josh");
    assert.equal(saved?.role, "Code Reviewer");
    assert.deepEqual(saved?.folders, ["/repo"]);
    assert.deepEqual(saved?.allowedTools, ["Write"]);
    assert.equal(saved?.sessionId, "s1");
  });

  it("gives virtual agents private computer records and leaves Mac agents unassigned", () => {
    const store = new Store(":memory:");
    const mac = buildNewAgent({ name: "Ana" }, []);
    const virtual = buildNewAgent({ name: "Vera", computer: "virtual" }, []);
    store.insertAgent(mac, NOW);
    store.insertAgent(virtual, NOW);
    assert.equal(store.getAgent(mac.id)?.computerId, null);
    assert.equal(store.getAgent(virtual.id)?.computerId, virtual.id);
    assert.deepEqual(store.computers.get(virtual.id), {
      id: virtual.id, name: "Vera's computer", runtime: "docker", profile: "desktop", engine: null, revision: 1,
      managed: false, createdAt: NOW, updatedAt: NOW,
    });
    assert.equal(store.computers.list().length, 1);
    const shared = store.computers.createManaged("Research desktop", "docker", "browser", NOW);
    assert.notEqual(shared.id, virtual.id);
    assert.equal(shared.managed, true);
    store.close();
  });

  it("loads a computer saved with the removed Apple Container runtime as a Docker computer", () => {
    const path = join(tempDir("hive-computer-db-"), "hive.db");
    const first = new Store(path);
    const saved = first.computers.createManaged("Old runtime", "docker", "terminal", NOW);
    first.close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE computers SET runtime = 'apple-container' WHERE id = ?").run(saved.id);
    raw.close();
    const reopened = new Store(path);
    assert.equal(reopened.computers.get(saved.id)?.runtime, "docker");
    assert.equal(reopened.computers.list().length, 1);
    reopened.close();
  });

  it("keeps the engine a computer is bound to, and binds an older database's computers to Docker Desktop, its only engine then", () => {
    const path = join(tempDir("hive-computer-db-"), "hive.db");
    const first = new Store(path);
    const saved = first.computers.createManaged("Bound", "docker", "browser", NOW);
    assert.equal(first.computers.setEngine(saved.id, "orbstack", NOW), true);
    assert.equal(first.computers.get(saved.id)?.revision, saved.revision);
    first.close();
    const raw = new DatabaseSync(path);
    raw.exec("ALTER TABLE computers DROP COLUMN engine");
    raw.close();
    const older = new Store(path);
    assert.equal(older.computers.get(saved.id)?.engine, "docker-desktop");
    older.computers.setEngine(saved.id, "orbstack", NOW);
    const fresh = older.computers.createManaged("Fresh", "docker", "terminal", NOW);
    older.close();
    const reopened = new Store(path);
    assert.equal(reopened.computers.get(saved.id)?.engine, "orbstack");
    assert.equal(reopened.computers.get(fresh.id)?.engine, null);
    assert.equal(reopened.computers.setEngine("00000000-0000-4000-8000-00000000dead", "orbstack", NOW), false);
    reopened.close();
  });

  it("adopts a legacy virtual agent under its original ID and migrates idempotently", () => {
    const path = join(tempDir("hive-computer-db-"), "hive.db");
    const id = "11111111-1111-4111-8111-111111111111";
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL,
      instructions TEXT NOT NULL, avatar_style TEXT NOT NULL, avatar_seed TEXT NOT NULL,
      use_my_setup INTEGER NOT NULL, permission_mode TEXT NOT NULL, folders TEXT NOT NULL, allowed_tools TEXT NOT NULL,
      computer TEXT NOT NULL, daily_budget INTEGER, connectors TEXT NOT NULL, session_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    legacy.prepare("INSERT INTO agents VALUES (?, 'Ana', 'Researcher', 'claude-code', 'auto', '', 's', 'x', 1, 'ask', '[]', '[]', 'virtual', NULL, '[]', 'legacy-session', ?, ?)").run(id, NOW, NOW);
    legacy.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)");
    legacy.prepare("INSERT INTO messages (agent_id, role, text, created_at) VALUES (?, 'user', 'keep this chat', ?)").run(id, NOW);
    legacy.close();
    const first = new Store(path);
    assert.equal(first.getAgent(id)?.computerId, id);
    assert.equal(first.computers.get(id)?.managed, false);
    const managed = first.computers.createManaged("Shared", "docker", "browser", NOW);
    first.close();
    const reassigned = new DatabaseSync(path);
    reassigned.prepare("UPDATE agents SET computer_id = ? WHERE id = ?").run(managed.id, id);
    reassigned.close();
    const second = new Store(path);
    assert.equal(second.computers.list().length, 2);
    assert.equal(second.getAgent(id)?.computerId, managed.id);
    assert.equal(second.getAgent(id)?.computer, "virtual");
    assert.equal(second.getAgent(id)?.sessionId, "legacy-session");
    assert.equal(second.listMessages(id, 10)[0]?.text, "keep this chat");
    second.close();
  });

  it("keeps the latest messages in order", () => {
    const { store, agent } = storeWithAgent();
    for (const text of ["one", "two", "three"]) store.addMessage(agent.id, "user", text, NOW);
    assert.deepEqual(store.listMessages(agent.id, 2).map((message) => message.text), ["two", "three"]);
  });

  it("deletes an agent with its messages and approvals", () => {
    const { store, agent } = storeWithAgent();
    store.addMessage(agent.id, "user", "hi", NOW);
    new Approvals(store, () => {}).create(agent.id, "Write", {});
    store.deleteAgent(agent.id);
    assert.equal(store.getAgent(agent.id), null);
    assert.deepEqual(store.listMessages(agent.id, 10), []);
    assert.deepEqual(store.pendingApprovals(), []);
  });

  it("marks runs and approvals left over from a crash as finished", () => {
    const { store, agent } = storeWithAgent();
    store.insertRun({ id: "r1", agentId: agent.id, engine: "claude-code", model: "m", startedAt: NOW, endedAt: null, status: "running", costUsd: 0, inputTokens: 0, outputTokens: 0, error: null });
    new Approvals(store, () => {}).create(agent.id, "Write", {});
    store.failInterruptedRuns(NOW);
    assert.equal(store.runsSince(NOW)[0]?.status, "failed");
    assert.deepEqual(store.pendingApprovals(), []);
  });
});

describe("approvals", () => {
  it("wakes a waiting agent when the user decides, and only once", async () => {
    const { store, agent } = storeWithAgent();
    const approvals = new Approvals(store, () => {});
    const approval = approvals.create(agent.id, "Bash", { command: "ls" });
    assert.equal(approval.summary, "Bash: ls");
    const waiting = approvals.wait(approval.id, 5000);
    approvals.decide(approval.id, true);
    assert.equal(await waiting, "allowed");
    approvals.decide(approval.id, false);
    assert.equal(store.getApproval(approval.id)?.status, "allowed");
  });

  it("reports pending when nobody answers within the poll window", async () => {
    const { store, agent } = storeWithAgent();
    const approvals = new Approvals(store, () => {});
    const approval = approvals.create(agent.id, "Write", {});
    assert.equal(await approvals.wait(approval.id, 10), "pending");
    approvals.denyAllFor(agent.id);
    assert.equal(await approvals.wait(approval.id, 10), "denied");
    assert.equal(await approvals.wait("missing", 10), "expired");
  });
});

describe("always allow", () => {
  function hubWithAgent() {
    const { store, agent } = storeWithAgent();
    return { store, agent, hub: new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }) };
  }

  it("marks approvals rememberable only when a safe rule exists", () => {
    const { store, agent, hub } = hubWithAgent();
    const safe = hub.requestApproval(agent.id, "Bash", { command: "ls -la src" });
    const unsafe = hub.requestApproval(agent.id, "Bash", { command: "git push" });
    const unknown = hub.requestApproval(agent.id, "mcp__x__y", {});
    assert.equal(store.getApproval(safe.id)?.rememberable, true);
    assert.equal(store.getApproval(unsafe.id)?.rememberable, false);
    assert.equal(store.getApproval(unknown.id)?.rememberable, false);
  });

  it("allows a non-rememberable request once and saves no rule", () => {
    const { store, agent, hub } = hubWithAgent();
    const requests: [string, Record<string, unknown>][] = [["Bash", { command: "git push" }], ["mcp__x__y", {}]];
    for (const [toolName, input] of requests) {
      const { id } = hub.requestApproval(agent.id, toolName, input);
      assert.equal(hub.decideApproval(id, true, true).status, "allowed");
    }
    assert.deepEqual(store.getAgent(agent.id)?.allowedTools, []);
  });

  it("saves the rule for a rememberable request", () => {
    const { store, agent, hub } = hubWithAgent();
    const { id } = hub.requestApproval(agent.id, "Bash", { command: "ls -la src" });
    hub.decideApproval(id, true, true);
    assert.deepEqual(store.getAgent(agent.id)?.allowedTools, ["Bash(ls:*)"]);
    assert.equal(hub.requestApproval(agent.id, "Bash", { command: "ls docs" }).autoAllowed, true);
  });

  it("saves no rule when a denied request is answered again with Always allow", () => {
    const { store, agent, hub } = hubWithAgent();
    const { id } = hub.requestApproval(agent.id, "Bash", { command: "ls -la src" });
    assert.equal(hub.decideApproval(id, false, false).status, "denied");
    assert.equal(hub.decideApproval(id, true, true).status, "denied");
    assert.deepEqual(store.getAgent(agent.id)?.allowedTools, []);
  });

  it("adds the rememberable column to an older database as not rememberable", () => {
    const path = join(tempDir("hive-db-"), "hive.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE approvals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tool_name TEXT NOT NULL, input TEXT NOT NULL,
      summary TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT)`);
    legacy.prepare("INSERT INTO approvals VALUES ('p1','a','Bash','{}','Bash: ls','pending',?,NULL)").run(NOW);
    legacy.close();
    const store = new Store(path);
    assert.equal(store.getApproval("p1")?.rememberable, false);
    store.close();
  });
});

describe("request origin", () => {
  it("accepts the board and non-browser clients but not other websites", () => {
    assert.ok(allowedOrigin(undefined, 47321));
    assert.ok(allowedOrigin("http://127.0.0.1:47321", 47321));
    assert.ok(allowedOrigin("http://localhost:47321", 47321));
    assert.ok(!allowedOrigin("https://evil.example", 47321));
    assert.ok(!allowedOrigin("http://127.0.0.1:3000", 47321));
  });
});
