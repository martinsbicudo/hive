import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { isUsableRule, matchesRule, ruleFor } from "../src/approvals.ts";
import { claudeArguments, type RunPlan } from "../src/engines.ts";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { addAgent, hubHarness, UI_SECRET } from "./taskFixtures.ts";
import { call, removeTempDirs } from "./fixtures.ts";

after(removeTempDirs);

const plan: RunPlan = {
  engine: "claude-code", model: "sonnet", sessionId: null, newSessionId: "new-id", systemPrompt: "You are Josh",
  workspace: "/w", folders: [], allowedTools: [], permissionMode: "ask", useMySetup: true, mcpConfigPath: "/r/mcp.json",
  computer: "mac", tainted: false,
};

function preAllowed(args: readonly string[]): string[] {
  const index = args.indexOf("--allowedTools");
  if (index < 0) return [];
  const rest = args.slice(index + 1);
  const end = rest.findIndex((arg) => arg.startsWith("--"));
  return end < 0 ? rest : rest.slice(0, end);
}

function deleteRule(port: number, agentId: string, token: string, body: unknown) {
  const headers = { "content-length": Buffer.byteLength(JSON.stringify(body)) };
  return call(port, "DELETE", `/api/agents/${agentId}/rules`, { token, body, headers });
}

function macHub(allowedTools: string[]) {
  const store = new Store(":memory:");
  const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" });
  const agent = addAgent(store, { name: "Ana" });
  store.updateAgent(agent.id, { allowedTools }, "2026-10-21T12:00:00.000Z");
  return { store, hub, agent };
}

describe("rules Claude Code sees", () => {
  it("forwards only bare known tool names to --allowedTools", () => {
    const args = claudeArguments({ ...plan, allowedTools: ["Bash", "Bash(git:*)", "mcp__x", "Bash(ls:*)", "Write"] });
    assert.deepEqual(preAllowed(args), ["Write"]);
    for (const rule of ["Bash", "Bash(git:*)", "mcp__x", "Bash(ls:*)"]) assert.ok(!args.includes(rule), rule);
  });

  it("leaves --allowedTools out when no bare known name is saved", () => {
    assert.ok(!claudeArguments({ ...plan, allowedTools: ["Bash(ls:*)", "mcp__x"] }).includes("--allowedTools"));
  });

  it("counts as usable only known names and Bash rules for rememberable programs", () => {
    for (const rule of ["Write", "WebSearch", "Bash(ls:*)", "Bash(grep:*)"]) assert.ok(isUsableRule(rule), rule);
    for (const rule of ["Bash", "mcp__x", "Agent", "Bash(git:*)", "Bash(uniq:*)", "Read(x:*)", "Bash(/bin/ls:*)", ""]) {
      assert.ok(!isUsableRule(rule), rule);
    }
  });

  it("never matches a stored bare name outside the known tools", () => {
    assert.ok(!matchesRule("mcp__x", "mcp__x", {}));
    assert.ok(!matchesRule("Agent", "Agent", {}));
    assert.ok(matchesRule("Write", "Write", {}));
  });
});

describe("short-flag clusters", () => {
  it("auto-allows grep -l with Bash(grep:*) saved, but asks for grep -lo", () => {
    const { hub, agent } = macHub(["Bash(grep:*)"]);
    try {
      assert.equal(hub.requestApproval(agent.id, "Bash", { command: "grep -l x f" }).autoAllowed, true);
      assert.equal(hub.requestApproval(agent.id, "Bash", { command: "grep -lo x f" }).autoAllowed, false);
    } finally {
      hub.shutdown();
    }
  });

  it("rejects any single-dash cluster containing o and keeps other clusters", () => {
    for (const command of ["grep -lo x f", "grep -ol x f", "ls -lo", "grep -rno x ."]) {
      assert.equal(ruleFor("Bash", { command }), null, command);
    }
    assert.equal(ruleFor("Bash", { command: "grep -rn x src" }), "Bash(grep:*)");
    assert.equal(ruleFor("Bash", { command: "ls -la" }), "Bash(ls:*)");
  });

  it("doesn't make uniq rememberable, since its second argument is an output file", () => {
    assert.equal(ruleFor("Bash", { command: "uniq a b" }), null);
    assert.ok(!matchesRule("Bash(uniq:*)", "Bash", { command: "uniq a b" }));
    const { hub, agent } = macHub(["Bash(uniq:*)"]);
    try {
      const asked = hub.requestApproval(agent.id, "Bash", { command: "uniq a b" });
      assert.equal(asked.autoAllowed, false);
      assert.equal(hub.approvals.decide(asked.id, false)?.rememberable, false);
    } finally {
      hub.shutdown();
    }
  });
});

describe("removing saved rules", () => {
  it("removes one rule by exact match, idempotently, and applies a Bash rule at once", async () => {
    const h = await hubHarness();
    try {
      const ana = h.agent({ name: "Ana" });
      h.store.updateAgent(ana.id, { allowedTools: ["Write", "Bash(ls:*)", "Bash(grep:*)"] }, "2026-10-21T12:00:00.000Z");
      const remove = (rule: unknown) => deleteRule(h.port, ana.id, UI_SECRET, { rule });
      assert.equal(h.hub.requestApproval(ana.id, "Bash", { command: "ls -la" }).autoAllowed, true);
      assert.deepEqual(await remove("Bash(ls:*)"), { status: 200, body: { ok: true, allowedTools: ["Write", "Bash(grep:*)"] } });
      assert.equal(h.hub.requestApproval(ana.id, "Bash", { command: "ls -la" }).autoAllowed, false);
      assert.deepEqual(await remove("Bash(ls:*)"), { status: 200, body: { ok: true, allowedTools: ["Write", "Bash(grep:*)"] } });
      assert.equal((await remove("bash(grep:*)")).status, 200);
      assert.deepEqual(h.store.getAgent(ana.id)?.allowedTools, ["Write", "Bash(grep:*)"]);
    } finally {
      await h.close();
    }
  });

  it("validates the body strictly and answers 404 for an unknown agent", async () => {
    const h = await hubHarness();
    try {
      const ana = h.agent({ name: "Ana" });
      for (const body of [{}, { rule: "" }, { rule: "x".repeat(201) }, { rule: 1 }, { rule: "Write", extra: true }]) {
        assert.equal((await deleteRule(h.port, ana.id, UI_SECRET, body)).status, 400, JSON.stringify(body));
      }
      assert.equal((await deleteRule(h.port, crypto.randomUUID(), UI_SECRET, { rule: "Write" })).status, 404);
      assert.equal((await deleteRule(h.port, ana.id, UI_SECRET, { rule: "x".repeat(200) })).status, 200);
    } finally {
      await h.close();
    }
  });

  it("refuses a run token and offers no way to add a rule", async () => {
    const h = await hubHarness();
    try {
      const ana = h.agent({ name: "Ana" });
      h.store.updateAgent(ana.id, { allowedTools: ["Write"] }, "2026-10-21T12:00:00.000Z");
      const runToken = h.hub.runTokens.issue(ana.id);
      assert.equal((await deleteRule(h.port, ana.id, runToken, { rule: "Write" })).status, 401);
      assert.equal((await call(h.port, "POST", `/api/agents/${ana.id}/rules`, { token: UI_SECRET, body: { rule: "Bash(cat:*)" } })).status, 404);
      assert.equal((await call(h.port, "PATCH", `/api/agents/${ana.id}`, { token: UI_SECRET, body: { allowedTools: ["Bash(cat:*)", "Agent"] } })).status, 200);
      assert.deepEqual(h.store.getAgent(ana.id)?.allowedTools, ["Write"]);
    } finally {
      await h.close();
    }
  });
});
