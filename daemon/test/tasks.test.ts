import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskAction } from "../src/hiveTools.ts";
import { HttpError } from "../src/httpError.ts";
import { addAgent, context, contextFrom, idOf, serviceHarness, status, teamHarness as setup } from "./taskFixtures.ts";

describe("trigger table", () => {
  it("user creates or assigns a task, or comments on an assigned one: a hop-0 run for the assignee", () => {
    const s = setup();
    const taskId = s.userTask(s.max.id);
    assert.deepEqual(s.queued.map(({ agentId, entry }) => [agentId, entry]), [[s.max.id, { kind: "task", taskId, context: { hop: 0, origin: "user", tainted: false } }]]);
    const unassigned = s.userTask();
    assert.equal(s.queued.length, 1);
    s.tasks.update(unassigned, { assigneeId: s.mia.id });
    s.tasks.comment(taskId, { text: "Any news?" });
    assert.deepEqual(s.queued.slice(1).map(({ agentId }) => agentId), [s.mia.id, s.max.id]);
    s.tasks.update(taskId, { status: "doing" });
    s.tasks.comment(s.userTask(), { text: "nobody hears this" });
    assert.equal(s.queued.length, 3);
  });

  it("create_task with an assignee: a run for it with the caller's hop + 1, none when it assigns itself", () => {
    const s = setup();
    const taskId = idOf(s.act(context(s.max.id, { hop: 2 }), "create_task", { title: "Review", assignee: "Mia" }));
    assert.deepEqual(s.queued.at(-1), { agentId: s.mia.id, entry: { kind: "task", taskId, context: { hop: 3, origin: s.max.id, tainted: false } } });
    const own = idOf(s.act(context(s.max.id), "create_task", { title: "Mine", assignee: s.max.id }));
    assert.equal(s.store.tasks.getTask(own)?.assigneeId, s.max.id);
    assert.equal(s.queued.length, 1);
  });

  it("update_task changing the assignee to someone else: a run for them; unchanged or the caller: none", () => {
    const s = setup();
    const taskId = s.userTask(s.max.id);
    s.queued.length = 0;
    s.act(context(s.max.id, { hop: 1 }), "update_task", { taskId, assignee: "Mia" });
    assert.deepEqual(s.queued.map(({ agentId, entry }) => [agentId, entry.context.hop]), [[s.mia.id, 2]]);
    s.act(context(s.max.id), "update_task", { taskId, assignee: "Mia" });
    s.act(context(s.max.id), "update_task", { taskId, assignee: s.max.id });
    s.act(context(s.max.id), "update_task", { taskId, assignee: null });
    assert.equal(s.queued.length, 1);
    assert.equal(s.store.tasks.getTask(taskId)?.assigneeId, null);
  });

  it("update_task with status, title or description only starts no run", () => {
    const s = setup();
    const taskId = s.userTask(s.max.id);
    s.queued.length = 0;
    s.act(context(s.max.id), "update_task", { taskId, status: "review", title: "README v2", description: "longer" });
    assert.equal(s.queued.length, 0);
    const task = s.store.tasks.getTask(taskId);
    assert.deepEqual([task?.title, task?.description, task?.status, task?.assigneeId], ["README v2", "longer", "review", s.max.id]);
  });

  it("handoff_task: a run for the target with hop + 1, and never to the caller", () => {
    const s = setup();
    const taskId = s.userTask(s.max.id);
    s.queued.length = 0;
    assert.deepEqual(s.act(context(s.max.id, { hop: 1 }), "handoff_task", { taskId, to: "mia", note: "please finish it" }), { taskId, assignee: "Mia" });
    assert.deepEqual(s.queued.map(({ agentId, entry }) => [agentId, entry]), [[s.mia.id, { kind: "task", taskId, context: { hop: 2, origin: s.max.id, tainted: false } }]]);
    assert.equal(s.store.tasks.getTask(taskId)?.assigneeId, s.mia.id);
    const handoff = s.events(taskId).at(-1);
    assert.deepEqual([handoff?.kind, handoff?.author, handoff?.text], ["handoff", s.max.id, "Handed to Mia: please finish it"]);
    assert.throws(() => s.act(context(s.mia.id), "handoff_task", { taskId, to: s.mia.id }), status(400));
  });

  it("comment_task only adds an event, so comment ping-pong can't loop", () => {
    const s = setup();
    const taskId = s.userTask(s.max.id);
    s.queued.length = 0;
    for (let round = 0; round < 5; round++) s.act(context(round % 2 ? s.max.id : s.mia.id, { hop: round }), "comment_task", { taskId, text: `ping ${round}` });
    assert.equal(s.queued.length, 0);
    assert.equal(s.events(taskId).filter((event) => event.kind === "comment").length, 5);
  });

  it("message_agent: a chat run for the target with hop + 1, and never to the caller", () => {
    const s = setup();
    s.act(context(s.max.id, { hop: 4 }), "message_agent", { to: "Mia", text: "lunch?" });
    assert.deepEqual(s.queued, [{ agentId: s.mia.id, entry: { kind: "chat", text: "lunch?", from: { agentId: s.max.id, untrusted: false }, context: { hop: 5, origin: s.max.id, tainted: false } } }]);
    assert.equal(s.store.listMessages(s.mia.id, 5).at(-1)?.text, "From Max: lunch?");
    assert.throws(() => s.act(context(s.max.id), "message_agent", { to: "Max", text: "hi me" }), status(400));
  });
});

describe("task status", () => {
  it("moves through every status, records each change once and rejects unknown ones", () => {
    const s = setup();
    const taskId = s.userTask(s.max.id);
    for (const next of ["doing", "blocked", "doing", "review", "done", "todo", "backlog"]) s.act(context(s.max.id), "update_task", { taskId, status: next });
    s.act(context(s.max.id), "update_task", { taskId, status: "backlog" });
    s.tasks.update(taskId, { status: "done" });
    const changes = s.events(taskId).filter((event) => event.kind === "status").map((event) => event.text);
    assert.deepEqual(changes, [
      "Status: todo → doing", "Status: doing → blocked", "Status: blocked → doing", "Status: doing → review", "Status: review → done",
      "Status: done → todo", "Status: todo → backlog", "Status: backlog → done",
    ]);
    assert.throws(() => s.act(context(s.max.id), "update_task", { taskId, status: "archived" }), status(400));
    assert.throws(() => s.tasks.update(taskId, { status: "wip" }), status(400));
    assert.throws(() => s.act(context(s.max.id), "update_task", { taskId }), status(400));
    assert.equal(s.store.tasks.getTask(s.userTask())?.status, "backlog");
  });
});

describe("zod at the task boundary", () => {
  it("rejects unknown keys from agents and from the board", () => {
    const s = setup();
    const taskId = s.userTask(s.max.id);
    const attempts: [TaskAction, Record<string, unknown>][] = [
      ["list_agents", { all: true }], ["list_tasks", { scope: "all" }], ["create_task", { title: "x", createdBy: "user" }],
      ["update_task", { taskId, untrusted: false }], ["comment_task", { taskId, text: "x", author: "user" }],
      ["handoff_task", { taskId, to: "Mia", hop: 0 }], ["message_agent", { to: "Mia", text: "x", tainted: false }],
    ];
    for (const [action, body] of attempts) assert.throws(() => s.act(context(s.max.id), action, body), status(400), action);
    assert.throws(() => s.tasks.create({ title: "x", createdBy: s.vera.id }), status(400));
    assert.throws(() => s.tasks.update(taskId, { titleUntrusted: false }), status(400));
    assert.throws(() => s.tasks.comment(taskId, { text: "x", untrusted: false }), status(400));
  });
});

describe("loop guard", () => {
  it("stops A → create_task(B) → B → create_task(A) at the hop limit and says so", () => {
    const s = setup();
    let ctx = context(s.max.id);
    const names = ["Mia", "Max"];
    let created = 0;
    for (let hop = 1; hop <= 6; hop++) {
      s.act(ctx, "create_task", { title: `round ${hop}`, assignee: names[(hop - 1) % 2] ?? "" });
      created++;
      const last = s.queued.at(-1);
      ctx = contextFrom(last?.entry, last?.agentId ?? "");
      assert.equal(ctx.hop, hop);
    }
    assert.throws(() => s.act(ctx, "create_task", { title: "round 7", assignee: "Mia" }), status(429));
    assert.equal(s.store.tasks.listTasks().length, created);
    assert.equal(s.queued.length, 6);
    assert.match(s.store.listMessages(ctx.agentId, 5).at(-1)?.text ?? "", /hop limit \(6\)/);
  });

  it("posts the refusal to the thread and the caller's chat, and stores nothing", () => {
    const s = setup();
    const taskId = s.userTask(s.max.id);
    assert.throws(() => s.act(context(s.max.id, { hop: 6 }), "handoff_task", { taskId, to: "Mia" }), status(429));
    assert.equal(s.store.tasks.getTask(taskId)?.assigneeId, s.max.id);
    assert.match(s.events(taskId).at(-1)?.text ?? "", /Hive didn't start a run for Mia: .*hop limit/);
    assert.equal(s.store.listMessages(s.max.id, 5).at(-1)?.role, "error");
  });

  it("the per-agent cap stops two agents round-robining a third", () => {
    const s = serviceHarness({ maxHop: 6, perAgentPerHour: 3, totalPerHour: 100 });
    const [a, b, c] = ["A", "B", "C"].map((name) => addAgent(s.store, { name }));
    if (!a || !b || !c) throw new Error("agents");
    for (let round = 0; round < 3; round++) s.tasks.act(context(round % 2 ? a.id : b.id), "message_agent", { to: c.id, text: `${round}` });
    assert.throws(() => s.tasks.act(context(a.id), "message_agent", { to: c.id, text: "again" }), status(429));
    assert.doesNotThrow(() => s.tasks.act(context(c.id), "message_agent", { to: a.id, text: "other agents still can" }));
    s.clock.now = 60 * 60 * 1000 + 1;
    assert.doesNotThrow(() => s.tasks.act(context(a.id), "message_agent", { to: c.id, text: "an hour later" }));
  });

  it("the global cap stops N agents round-robining", () => {
    const s = serviceHarness({ maxHop: 6, perAgentPerHour: 100, totalPerHour: 5 });
    const agents = ["A", "B", "C", "D"].map((name) => addAgent(s.store, { name }));
    for (let round = 0; round < 5; round++) {
      const from = agents[round % 4];
      const to = agents[(round + 1) % 4];
      if (!from || !to) throw new Error("agents");
      s.tasks.act(context(from.id), "message_agent", { to: to.id, text: `${round}` });
    }
    const [first, second] = agents;
    if (!first || !second) throw new Error("agents");
    assert.throws(() => s.tasks.act(context(first.id), "message_agent", { to: second.id, text: "6th" }), (error: unknown) => error instanceof HttpError && error.status === 429 && /5 runs for each other/.test(error.message));
    assert.equal(s.queued.length, 5);
  });

  it("task runs started by agents count too: handoff round-robin hits the per-agent cap", () => {
    const s = serviceHarness({ maxHop: 100, perAgentPerHour: 2, totalPerHour: 100 });
    const a = addAgent(s.store, { name: "A" });
    const b = addAgent(s.store, { name: "B" });
    const taskId = s.tasks.create({ title: "ping-pong", assigneeId: a.id }).id;
    const pass = (from: string, to: string) => s.tasks.act(context(from), "handoff_task", { taskId, to });
    pass(a.id, b.id);
    pass(b.id, a.id);
    pass(a.id, b.id);
    pass(b.id, a.id);
    assert.throws(() => pass(a.id, b.id), status(429));
    assert.equal(s.store.tasks.getTask(taskId)?.assigneeId, a.id);
  });

  it("user-started runs don't count against the caps", () => {
    const s = serviceHarness({ maxHop: 6, perAgentPerHour: 1, totalPerHour: 1 });
    const a = addAgent(s.store, { name: "A" });
    const b = addAgent(s.store, { name: "B" });
    for (let round = 0; round < 3; round++) s.tasks.create({ title: `user task ${round}`, assigneeId: b.id });
    assert.doesNotThrow(() => s.tasks.act(context(a.id), "message_agent", { to: b.id, text: "first agent run" }));
    assert.throws(() => s.tasks.act(context(a.id), "message_agent", { to: b.id, text: "second" }), status(429));
  });
});
