import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ValidationError } from "../src/agents.ts";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { connectorHarness, SEND_BINARY } from "./connectorFixtures.ts";
import { field, removeTempDirs, tempDir } from "./fixtures.ts";
import { NOW } from "./taskFixtures.ts";

after(removeTempDirs);

function throwsValidation(action: () => unknown, pattern: RegExp): void {
  assert.throws(action, (error: unknown) => error instanceof ValidationError && pattern.test(error.message));
}

describe("connector placement", () => {
  it("stores deduplicated connectors on a Mac Claude Code agent and shows them in state", async () => {
    const h = await connectorHarness();
    try {
      const agent = h.hub.createAgent({ name: "Ana", connectors: ["github", "mail", "github"] });
      assert.deepEqual(agent.connectors, ["mail", "github"]);
      assert.deepEqual(h.store.getAgent(agent.id)?.connectors, ["mail", "github"]);
      assert.deepEqual(h.hub.createAgent({ name: "Bo" }).connectors, []);
      throwsValidation(() => h.hub.createAgent({ connectors: ["gmail"] }), /connectors must be/);
      throwsValidation(() => h.hub.createAgent({ connectors: "mail" }), /connectors must be/);
    } finally {
      await h.close();
    }
  });

  it("refuses connectors on create for a virtual or Codex agent, but takes [] on either", async () => {
    const h = await connectorHarness();
    try {
      throwsValidation(() => h.hub.createAgent({ computer: "virtual", connectors: ["mail"] }), /virtual computer/);
      throwsValidation(() => h.hub.createAgent({ engine: "codex", connectors: ["github"] }), /Claude Code only/);
      assert.deepEqual(h.hub.createAgent({ computer: "virtual", connectors: [] }).connectors, []);
      assert.deepEqual(h.hub.createAgent({ engine: "codex", connectors: [] }).connectors, []);
    } finally {
      await h.close();
    }
  });

  it("checks PATCH on the merged agent: switching needs the same patch to clear connectors", async () => {
    const h = await connectorHarness();
    try {
      const mo = h.hub.createAgent({ name: "Mo", connectors: ["mail"] });
      throwsValidation(() => h.hub.updateAgent(mo.id, { computer: "virtual" }), /virtual computer/);
      throwsValidation(() => h.hub.updateAgent(mo.id, { engine: "codex" }), /Claude Code only/);
      assert.equal(h.store.getAgent(mo.id)?.computer, "mac");
      assert.equal(h.store.getAgent(mo.id)?.engine, "claude-code");
      const codex = h.hub.updateAgent(mo.id, { engine: "codex", connectors: [] });
      assert.deepEqual([codex.engine, codex.connectors], ["codex", []]);
      throwsValidation(() => h.hub.updateAgent(mo.id, { connectors: ["mail"] }), /Claude Code only/);
      const vera = h.hub.createAgent({ name: "Vera", connectors: ["calendar"] });
      assert.equal(h.hub.updateAgent(vera.id, { computer: "virtual", connectors: [] }).computer, "virtual");
      throwsValidation(() => h.hub.updateAgent(vera.id, { connectors: ["calendar"] }), /virtual computer/);
      assert.deepEqual(h.hub.updateAgent(vera.id, { connectors: [] }).connectors, []);
    } finally {
      await h.close();
    }
  });

  it("adds the column to an older database with no connectors for anyone", () => {
    const path = join(tempDir("hive-db-"), "hive.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL,
      instructions TEXT NOT NULL, avatar_style TEXT NOT NULL, avatar_seed TEXT NOT NULL,
      use_my_setup INTEGER NOT NULL, permission_mode TEXT NOT NULL, folders TEXT NOT NULL, allowed_tools TEXT NOT NULL,
      session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    legacy.prepare("INSERT INTO agents VALUES ('a1','Ana','R','claude-code','auto','','s','x',1,'ask','[]','[]',NULL,?,?)").run(NOW, NOW);
    legacy.close();
    const store = new Store(path);
    assert.deepEqual(store.getAgent("a1")?.connectors, []);
    store.close();
  });
});

describe("connector route access", () => {
  it("answers 403 for a disabled connector, a virtual agent, a Codex agent, or no connectors", async () => {
    const h = await connectorHarness();
    try {
      const mo = h.mailAgent();
      assert.equal((await h.post(h.tokenFor(mo.id).token, "test_events", {})).status, 403);
      const plain = h.agent({ name: "Pia" });
      assert.equal((await h.post(h.tokenFor(plain.id).token, "test_read", {})).status, 403);
      const vic = h.mailAgent({ name: "Vic" });
      h.store.updateAgent(vic.id, { computer: "virtual" }, NOW);
      assert.equal((await h.post(h.tokenFor(vic.id).token, "test_read", {})).status, 403);
      assert.equal((await h.post(h.tokenFor(vic.id).token, "test_send", { to: "a@b.c", text: "x" })).status, 403);
      const cody = h.mailAgent({ name: "Cody" });
      h.store.updateAgent(cody.id, { engine: "codex" }, NOW);
      assert.equal((await h.post(h.tokenFor(cody.id).token, "test_read", {})).status, 403);
      const launched = h.mailAgent({ name: "Lu" });
      assert.equal((await h.post(h.tokenFor(launched.id, { launchedVirtual: true }).token, "test_read", {})).status, 403);
      assert.equal(h.commands.calls.length + h.hub.state().approvals.length, 0);
    } finally {
      await h.close();
    }
  });

  it("answers 403 for a connector turned on after the run started, until the next run", async () => {
    const h = await connectorHarness();
    try {
      const pia = h.agent({ name: "Pia" });
      const before = h.tokenFor(pia.id).token;
      h.store.updateAgent(pia.id, { connectors: ["mail"] }, NOW);
      const refused = await h.post(before, "test_read", {});
      assert.equal(refused.status, 403);
      assert.match(String(field(refused.body, "error")), /after this run started/);
      assert.equal((await h.post(h.tokenFor(pia.id, { launchedConnectors: ["mail"] }).token, "test_read", {})).status, 200);
    } finally {
      await h.close();
    }
  });

  it("needs a run token, refuses unknown tools and extra fields", async () => {
    const h = await connectorHarness();
    try {
      const mo = h.mailAgent();
      const { token } = h.tokenFor(mo.id);
      assert.equal((await h.post("", "test_read", {})).status, 401);
      assert.equal((await h.post("x".repeat(64), "test_read", {})).status, 401);
      assert.equal((await h.post(token, "mail_send", {})).status, 404);
      assert.equal((await h.post(token, "test_send", { to: "a@b.c", text: "x", cc: "evil@x.y" })).status, 400);
      assert.equal((await h.post(token, "test_read", { extra: 1 })).status, 400);
      assert.equal(h.hub.state().approvals.length, 0);
    } finally {
      await h.close();
    }
  });
});

describe("connector snapshot gate", () => {
  it("runs only after approval, from the original input, once", async () => {
    const h = await connectorHarness();
    try {
      const mo = h.mailAgent();
      const { token } = h.tokenFor(mo.id);
      const first = await h.ask(token, { to: "me@example.com", text: "hello" });
      assert.equal(first.reply.status, 200);
      const second = await h.ask(token, { to: "evil@example.com", text: "changed" });
      assert.equal(second.reply.status, 409);
      assert.match(String(field(second.reply.body, "error")), /one send at a time/);
      const card = h.hub.state().approvals.find((approval) => approval.id === first.approvalId);
      assert.deepEqual([card?.toolName, card?.input, card?.rememberable], ["mcp__hive__test_send", { to: "me@example.com", text: "hello" }, false]);
      assert.equal(h.commands.calls.length, 0);
      h.hub.decideApproval(first.approvalId, true, false);
      const outcome = await h.post(token, "wait", { approvalId: first.approvalId });
      assert.deepEqual(outcome.body, { status: "allowed", result: { sent: "me@example.com", code: 0 } });
      assert.equal(h.commands.calls.length, 1);
      assert.deepEqual(h.commands.calls[0]?.file, SEND_BINARY);
      assert.deepEqual(h.commands.calls[0]?.args, ["--to", "me@example.com"]);
      assert.equal(h.commands.calls[0]?.options.input, "hello");
      h.hub.decideApproval(first.approvalId, true, false);
      assert.deepEqual((await h.post(token, "wait", { approvalId: first.approvalId })).body, { status: "allowed" });
      assert.equal(h.commands.calls.length, 1);
    } finally {
      await h.close();
    }
  });

  it("never runs on deny, and remember stores nothing and asks again", async () => {
    const h = await connectorHarness();
    try {
      const mo = h.mailAgent();
      const { token } = h.tokenFor(mo.id);
      const denied = await h.ask(token);
      h.hub.decideApproval(denied.approvalId, false, false);
      assert.deepEqual((await h.post(token, "wait", { approvalId: denied.approvalId })).body, { status: "denied" });
      const remembered = await h.ask(token);
      h.hub.decideApproval(remembered.approvalId, true, true);
      assert.equal((await h.post(token, "wait", { approvalId: remembered.approvalId })).status, 200);
      assert.deepEqual(h.store.getAgent(mo.id)?.allowedTools, []);
      const again = await h.ask(token);
      assert.notEqual(again.approvalId, "");
      assert.equal(h.statusOf(again.approvalId), "pending");
      assert.equal(h.commands.calls.length, 1);
    } finally {
      await h.close();
    }
  });

  it("keeps one pending send per agent, not per Hive", async () => {
    const h = await connectorHarness();
    try {
      const mo = h.mailAgent();
      const mia = h.mailAgent({ name: "Mia" });
      assert.equal((await h.ask(h.tokenFor(mo.id).token)).reply.status, 200);
      assert.equal((await h.ask(h.tokenFor(mo.id).token)).reply.status, 409);
      assert.equal((await h.ask(h.tokenFor(mia.id).token)).reply.status, 200);
    } finally {
      await h.close();
    }
  });

  it("re-checks the connector right before running", async () => {
    const h = await connectorHarness();
    try {
      const mo = h.mailAgent();
      const { token } = h.tokenFor(mo.id);
      const asked = await h.ask(token);
      h.store.updateAgent(mo.id, { connectors: [] }, NOW);
      h.hub.decideApproval(asked.approvalId, true, false);
      const outcome = await h.post(token, "wait", { approvalId: asked.approvalId });
      assert.match(String(field(outcome.body, "error")), /can't use the mail connector/);
      assert.equal(h.commands.calls.length, 0);
    } finally {
      await h.close();
    }
  });

  const denials: [string, (h: Awaited<ReturnType<typeof connectorHarness>>, agentId: string) => unknown][] = [
    ["connector removal", (h, id) => h.hub.updateAgent(id, { connectors: ["calendar"] })],
    ["a move to the virtual computer", (h, id) => h.hub.updateAgent(id, { computer: "virtual", connectors: [] })],
    ["a switch to Codex", (h, id) => h.hub.updateAgent(id, { engine: "codex", connectors: [] })],
    ["stop", (h, id) => h.hub.stop(id)],
    ["pause", (h) => h.hub.control.pause()],
    ["delete", (h, id) => h.hub.deleteAgent(id)],
  ];
  for (const [what, change] of denials) {
    it(`denies the pending send on ${what} and runs nothing`, async () => {
      const h = await connectorHarness();
      try {
        const mo = h.mailAgent();
        const asked = await h.ask(h.tokenFor(mo.id).token);
        await change(h, mo.id);
        assert.equal(h.statusOf(asked.approvalId), "denied");
        if (h.store.getApproval(asked.approvalId)) assert.equal(h.hub.decideApproval(asked.approvalId, true, false).status, "denied");
        assert.equal(h.commands.calls.length, 0);
      } finally {
        await h.close();
      }
    });
  }

  it("keeps the pending send when a connector is only added", async () => {
    const h = await connectorHarness();
    try {
      const mo = h.mailAgent();
      const asked = await h.ask(h.tokenFor(mo.id).token);
      h.hub.updateAgent(mo.id, { connectors: ["mail", "calendar"], name: "Moe" });
      assert.equal(h.statusOf(asked.approvalId), "pending");
    } finally {
      await h.close();
    }
  });

  it("never runs a send after a restart, even if the old card is approved", async () => {
    const h = await connectorHarness();
    try {
      const mo = h.mailAgent();
      const asked = await h.ask(h.tokenFor(mo.id).token);
      const restarted = new Hub(h.store, { command: "node", args: [], url: "http://127.0.0.1:1" }, undefined, { commands: h.commands.runner });
      assert.equal(h.store.getApproval(asked.approvalId)?.status, "expired");
      assert.equal(restarted.decideApproval(asked.approvalId, true, false).status, "expired");
      restarted.shutdown();
      assert.equal(h.commands.calls.length, 0);
    } finally {
      await h.close();
    }
  });
});
