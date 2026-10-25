import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Hub } from "../src/hub.ts";
import { TASK_ACTIONS, TASK_TOOLS, taskToolName } from "../src/hiveTools.ts";
import { toolsOutsideAllowlist } from "../src/virtualClaude.ts";
import type { HubEvent } from "../src/types.ts";
import { call, field, removeTempDirs } from "./fixtures.ts";
import { context, hubHarness, idOf, UI_SECRET, until } from "./taskFixtures.ts";

after(removeTempDirs);

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function gatedHandoff() {
  const h = await hubHarness();
  const vera = h.agent({ name: "Vera", computer: "virtual" });
  const max = h.agent({ name: "Max" });
  const taskId = idOf(h.hub.tasks.act(context(vera.id), "create_task", { title: "Prices" }));
  const approvalId = idOf(h.hub.tasks.act(context(vera.id), "handoff_task", { taskId, to: "Max" }), "approvalId");
  const unchanged = () => {
    assert.equal(h.store.getApproval(approvalId)?.status === "pending", false);
    assert.equal(h.store.tasks.getTask(taskId)?.assigneeId ?? null, null);
    assert.equal(h.runs().length, 0);
    assert.equal(h.hub.state().activity.length, 0);
  };
  return { h, vera, max, taskId, approvalId, unchanged };
}

describe("gated actions when something changes while they wait", () => {
  it("deleting the source denies the approval, posts an event and starts nothing", async () => {
    const { h, vera, taskId, unchanged } = await gatedHandoff();
    try {
      await h.hub.deleteAgent(vera.id);
      unchanged();
      assert.equal(h.store.tasks.listEvents(taskId).at(-1)?.text, "The user didn't allow Vera's handoff (denied). Nothing changed.");
    } finally {
      await h.close();
    }
  });

  it("deleting the target with open tasks denies it, unassigns its tasks with an event and forgets its sessions", async () => {
    const { h, max, taskId } = await gatedHandoff();
    try {
      const own = h.hub.tasks.create({ title: "Max's own", assigneeId: max.id }).id;
      await until(() => h.runs().length === 1, "Max's run");
      await h.idle();
      assert.ok(h.store.tasks.session(own, max.id));
      await h.hub.deleteAgent(max.id);
      assert.equal(h.store.tasks.getTask(own)?.assigneeId, null);
      assert.equal(h.store.tasks.listEvents(own).at(-1)?.text, "Max was deleted, so this task has no assignee now.");
      assert.equal(h.store.tasks.session(own, max.id), null);
      assert.equal(h.store.tasks.getTask(taskId)?.assigneeId, null);
      assert.match(h.store.tasks.listEvents(taskId).at(-1)?.text ?? "", /\(denied\)\. Nothing changed\.$/);
      assert.equal(h.runs().length, 1);
    } finally {
      await h.close();
    }
  });

  it("a mode switch of the target while pending denies it with an event and starts nothing", async () => {
    const { h, max, taskId, unchanged } = await gatedHandoff();
    try {
      h.hub.updateAgent(max.id, { computer: "virtual" });
      unchanged();
      assert.match(h.store.tasks.listEvents(taskId).at(-1)?.text ?? "", /\(denied\)\. Nothing changed\.$/);
    } finally {
      await h.close();
    }
  });

  it("a restart expires it with an event and starts nothing", async () => {
    const { h, taskId, approvalId } = await gatedHandoff();
    try {
      const restarted = new Hub(h.store, { command: "node", args: [], url: "http://127.0.0.1:1" });
      assert.equal(h.store.getApproval(approvalId)?.status, "expired");
      assert.equal(h.store.tasks.listEvents(taskId).at(-1)?.text, "Hive restarted, so Vera's handoff request expired. Nothing changed.");
      assert.equal(h.store.tasks.getTask(taskId)?.assigneeId, null);
      restarted.shutdown();
    } finally {
      await h.close();
    }
  });

  it("shutdown denies pending approvals", async () => {
    const { h, approvalId, taskId } = await gatedHandoff();
    await h.close();
    assert.equal(h.store.getApproval(approvalId)?.status, "denied");
    assert.equal(h.store.tasks.getTask(taskId)?.assigneeId, null);
  });
});

describe("mode switches and queued agent runs", () => {
  it("M→M2 queued, then M2 switched to virtual: the entry never runs, its task sessions are gone, an event is posted", async () => {
    const h = await hubHarness();
    try {
      const max = h.agent({ name: "Max" });
      const mia = h.agent({ name: "Mia" });
      h.script({ Mia: [[{ sleepMs: 600 }, { say: "chat done" }]] });
      const taskId = h.hub.tasks.create({ title: "Shared" }).id;
      h.store.tasks.setSession(taskId, mia.id, "mac-made-session");
      h.hub.send(mia.id, "busy for a moment");
      await until(() => h.hub.state().activity.length === 1, "Mia's chat run");
      h.hub.tasks.act(context(max.id), "handoff_task", { taskId, to: "Mia" });
      assert.equal(h.hub.state().activity[0]?.queued, 1);
      h.hub.updateAgent(mia.id, { computer: "virtual" });
      assert.equal(h.hub.state().activity[0]?.queued, 0);
      assert.equal(h.store.tasks.session(taskId, mia.id), null);
      assert.match(h.store.tasks.listEvents(taskId).at(-1)?.text ?? "", /^Mia changed where it works, so its current run was stopped, runs queued by other agents were dropped/);
      await h.idle();
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(h.runs().map((run) => run.agent), []);
    } finally {
      await h.close();
    }
  });

  it("switching back to the Mac doesn't resume a session made while virtual", async () => {
    const h = await hubHarness();
    try {
      const vera = h.agent({ name: "Vera", computer: "virtual" });
      const taskId = h.hub.tasks.create({ title: "Shared" }).id;
      h.store.tasks.setSession(taskId, vera.id, "virtual-made-session");
      h.hub.updateAgent(vera.id, { computer: "mac" });
      h.hub.tasks.update(taskId, { assigneeId: vera.id });
      await until(() => h.runs().length === 1, "the run");
      await h.idle();
      const args = h.runs()[0]?.args ?? [];
      assert.equal(valueAfter(args, "--resume"), undefined);
      assert.notEqual(valueAfter(args, "--session-id"), "virtual-made-session");
    } finally {
      await h.close();
    }
  });

  it("a user message queued behind a run survives a mode switch", async () => {
    const h = await hubHarness();
    try {
      const mia = h.agent({ name: "Mia" });
      h.script({ Mia: [[{ sleepMs: 400 }]] });
      h.hub.send(mia.id, "first");
      await until(() => h.hub.state().activity.length === 1, "the first run");
      h.hub.send(mia.id, "second");
      h.hub.updateAgent(mia.id, { model: "haiku" });
      h.hub.updateAgent(mia.id, { computer: "virtual" });
      assert.equal(h.hub.state().activity[0]?.queued, 1);
      await until(() => h.runs().some((run) => run.stdin.includes("second")), "the queued message to run");
    } finally {
      await h.close();
    }
  });
});

describe("task tools on the allow lists", () => {
  it("TASK_TOOLS is one list feeding both the auto-allow and the virtual init allowlist", async () => {
    const h = await hubHarness();
    try {
      const max = h.agent({ name: "Max" });
      const vera = h.agent({ name: "Vera", computer: "virtual" });
      assert.deepEqual([...TASK_TOOLS], TASK_ACTIONS.map(taskToolName));
      assert.deepEqual(toolsOutsideAllowlist([...TASK_TOOLS]), []);
      for (const tool of TASK_TOOLS) {
        for (const agent of [max, vera]) assert.deepEqual(h.hub.requestApproval(agent.id, tool, {}), { id: "", autoAllowed: true }, tool);
      }
      for (const lookalike of ["mcp__hive__list_tasksx", "mcp__hivex__list_tasks", "mcp__hive__delete_task"]) {
        assert.deepEqual(toolsOutsideAllowlist([lookalike]), [lookalike]);
        assert.equal(h.hub.requestApproval(vera.id, lookalike, {}).autoAllowed, false);
      }
    } finally {
      await h.close();
    }
  });
});

describe("task routes", () => {
  it("bind internal calls to the token's agent and its run, never the body", async () => {
    const h = await hubHarness();
    try {
      const ana = h.agent({ name: "Ana" });
      const bob = h.agent({ name: "Bob", computer: "virtual" });
      const anaToken = h.hub.runTokens.issue(ana.id);
      const created = await call(h.port, "POST", "/internal/tasks/create_task", { token: anaToken, body: { agentId: bob.id, title: "From Ana" } });
      assert.equal(created.status, 200);
      assert.equal(h.store.tasks.getTask(idOf(created.body))?.createdBy, ana.id);
      const bobAsk = idOf(h.hub.tasks.act(context(bob.id), "message_agent", { to: "Ana", text: "x" }), "approvalId");
      assert.equal((await call(h.port, "POST", "/internal/tasks/wait", { token: anaToken, body: { approvalId: bobAsk } })).status, 404);
      assert.equal((await call(h.port, "POST", "/internal/tasks/list_tasks", { token: UI_SECRET, body: {} })).status, 401);
      assert.equal((await call(h.port, "GET", "/api/tasks", { token: anaToken })).status, 401);
      h.hub.runTokens.revoke(anaToken);
      assert.equal((await call(h.port, "POST", "/internal/tasks/list_tasks", { token: anaToken, body: {} })).status, 401);
    } finally {
      await h.close();
    }
  });

  it("reject unknown keys and unknown routes with zod and 404", async () => {
    const h = await hubHarness();
    try {
      const ana = h.agent({ name: "Ana" });
      const token = h.hub.runTokens.issue(ana.id);
      const internal = (route: string, body: unknown) => call(h.port, "POST", `/internal/tasks/${route}`, { token, body });
      assert.equal((await internal("create_task", { title: "x", untrusted: false })).status, 400);
      assert.equal((await internal("wait", { approvalId: "x", status: "allowed" })).status, 400);
      assert.equal((await internal("delete_task", {})).status, 404);
      const ui = (method: string, path: string, body?: unknown) => call(h.port, method, path, { token: UI_SECRET, body });
      assert.equal((await ui("POST", "/api/tasks", { title: "x", createdBy: ana.id })).status, 400);
      const taskId = idOf((await ui("POST", "/api/tasks", { title: "ok" })).body, "id");
      assert.equal((await ui("PATCH", `/api/tasks/${taskId}`, { titleUntrusted: true })).status, 400);
      assert.equal((await ui("POST", `/api/tasks/${taskId}/comments`, { text: "hi", gated: true })).status, 400);
      assert.equal((await ui("GET", "/api/tasks/missing")).status, 404);
      assert.equal((await ui("PATCH", `/api/tasks/${taskId}`, { assigneeId: "not-an-agent" })).status, 400);
    } finally {
      await h.close();
    }
  });

  it("serve the board the full list and thread, and push task events on the socket", async () => {
    const h = await hubHarness();
    try {
      const events: HubEvent[] = [];
      h.hub.subscribe((event) => events.push(event));
      const created = await call(h.port, "POST", "/api/tasks", { token: UI_SECRET, body: { title: "Board task", description: "d" } });
      const taskId = idOf(created.body, "id");
      const comment = await call(h.port, "POST", `/api/tasks/${taskId}/comments`, { token: UI_SECRET, body: { text: "  a note  " } });
      assert.deepEqual([comment.status, field(comment.body, "text"), field(comment.body, "author")], [201, "a note", "user"]);
      const list = await call(h.port, "GET", "/api/tasks", { token: UI_SECRET });
      assert.ok(Array.isArray(list.body) && list.body.some((task) => field(task, "id") === taskId));
      assert.ok(events.some((event) => event.type === "task" && event.taskId === taskId));
    } finally {
      await h.close();
    }
  });
});

describe("activity shows the task a run works on", () => {
  it("has taskId and taskTitle during a task run, and neither during a chat run", async () => {
    const h = await hubHarness();
    try {
      const ada = h.agent({ name: "Ada" });
      h.script({ Ada: [[{ sleepMs: 500 }], [{ sleepMs: 500 }]] });
      const taskId = h.hub.tasks.create({ title: "Fix the <b>login</b> page", assigneeId: ada.id }).id;
      await until(() => h.hub.state().activity.length === 1, "the task run");
      const during = h.hub.state().activity[0];
      assert.deepEqual([during?.taskId, during?.taskTitle], [taskId, "Fix the <b>login</b> page"]);
      await h.idle();
      h.hub.send(ada.id, "just chatting");
      await until(() => h.hub.state().activity.length === 1, "the chat run");
      const chat = h.hub.state().activity[0];
      assert.ok(chat && !("taskId" in chat) && !("taskTitle" in chat));
      await h.idle();
    } finally {
      await h.close();
    }
  });
});
