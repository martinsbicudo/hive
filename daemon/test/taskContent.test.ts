import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { USER_TRIGGER } from "../src/runTokens.ts";
import { HIDDEN_FIELD } from "../src/taskPrompt.ts";
import { newNonce } from "../src/trust.ts";
import { context, idOf, teamHarness } from "./taskFixtures.ts";

const NOW = "2026-10-21T12:00:00.000Z";

function setup() {
  const s = teamHarness();
  const approvalOf = (reply: unknown) => idOf(reply, "approvalId");
  const seenBy = (agentId: string, taskId: string, launchedVirtual = true) =>
    JSON.stringify(s.act(context(agentId, { launchedVirtual }), "list_tasks", { taskId }));
  const maxTask = (fields: { title: string; description: string }, assignee?: string) =>
    idOf(s.act(context(s.max.id), "create_task", { ...fields, ...(assignee ? { assignee } : {}) }));
  return { ...s, approvalOf, seenBy, maxTask };
}

describe("an approval covers exactly what its card showed", () => {
  it("refuses on allow when the user changed the task after the card was shown", () => {
    const s = setup();
    const taskId = s.maxTask({ title: "Docs", description: "Cover setup" });
    const approvalId = s.approvalOf(s.act(context(s.max.id), "handoff_task", { taskId, to: "Vera" }));
    s.tasks.update(taskId, { description: "the new private plan" });
    s.approvals.decide(approvalId, true);
    assert.equal(s.store.tasks.getTask(taskId)?.assigneeId, null);
    assert.equal(s.events(taskId).at(-1)?.text, "Max's approved handoff wasn't done: the task changed after you were asked; ask again.");
    assert.equal(s.queued.length, 0);
  });

  it("refuses a comment whose task title changed before allow", () => {
    const s = setup();
    const taskId = s.veraTask();
    const approvalId = s.approvalOf(s.act(context(s.max.id), "comment_task", { taskId, text: "notes" }));
    s.tasks.update(taskId, { title: "Renamed" });
    s.approvals.decide(approvalId, true);
    assert.ok(!s.events(taskId).some((event) => event.text === "notes"));
    assert.match(String(s.tasks.outcome(s.max.id, approvalId, "allowed").error), /the task changed after you were asked/);
  });

  it("refuses an allowed request when the user changed the task's status or assignee after it was shown", () => {
    const s = setup();
    const statusTask = s.veraTask();
    const statusApproval = s.approvalOf(s.act(context(s.max.id), "update_task", { taskId: statusTask, title: "Max's title" }));
    s.tasks.update(statusTask, { status: "blocked" });
    s.approvals.decide(statusApproval, true);
    assert.equal(s.store.tasks.getTask(statusTask)?.title, "Scrape prices");
    assert.equal(s.events(statusTask).at(-1)?.text, "Max's approved task change wasn't done: the task changed after you were asked; ask again.");

    const assigned = s.veraTask();
    const handoff = s.approvalOf(s.act(context(s.vera.id), "handoff_task", { taskId: assigned, to: "Max" }));
    s.tasks.update(assigned, { assigneeId: s.mia.id });
    s.approvals.decide(handoff, true);
    assert.equal(s.store.tasks.getTask(assigned)?.assigneeId, s.mia.id);
    assert.match(String(s.tasks.outcome(s.vera.id, handoff, "allowed").error), /the task changed after you were asked/);
    assert.ok(!s.queued.some((item) => item.agentId === s.max.id));
  });

  it("holds agent edits and handoffs on a task while a request about it is pending, and only on that task", () => {
    const s = setup();
    const taskId = s.maxTask({ title: "Docs", description: "Cover setup" });
    const other = s.maxTask({ title: "Other", description: "" });
    s.approvalOf(s.act(context(s.max.id), "handoff_task", { taskId, to: "Vera" }));
    for (const [agentId, action, body] of [
      [s.max.id, "update_task", { taskId, description: "swap it" }],
      [s.mia.id, "handoff_task", { taskId, to: "Max" }],
    ] as const) {
      assert.throws(() => s.act(context(agentId), action, body), (error: unknown) => error instanceof Error && /hasn't answered/.test(error.message));
    }
    assert.equal(s.store.tasks.getTask(taskId)?.description, "Cover setup");
    s.act(context(s.max.id), "update_task", { taskId: other, description: "fine" });
    assert.equal(s.store.tasks.getTask(other)?.description, "fine");
  });
});

describe("task fields written on the Mac stay off virtual computers", () => {
  it("hides a Mac agent's title and description after that agent switches to virtual", () => {
    const s = setup();
    const taskId = s.maxTask({ title: "Payroll export", description: "use the HR share" }, "Max");
    s.store.updateAgent(s.max.id, { computer: "virtual" }, NOW);
    const seen = s.seenBy(s.max.id, taskId);
    assert.ok(!seen.includes("Payroll export") && !seen.includes("use the HR share"));
    assert.equal(seen.split(HIDDEN_FIELD).length - 1, 2);
    const agent = s.store.getAgent(s.max.id);
    assert.ok(agent);
    const prompt = s.jobs.prepare(agent, { kind: "task", taskId, context: USER_TRIGGER }, newNonce())?.prompt ?? "";
    assert.ok(prompt.includes(`Title: ${HIDDEN_FIELD}`) && !prompt.includes("use the HR share"));
  });

  it("hides them from a virtual assignee nobody confirmed them for, but shows the user's own fields", () => {
    const s = setup();
    const macTask = s.maxTask({ title: "Payroll export", description: "use the HR share" });
    s.store.tasks.updateTask(macTask, { assigneeId: s.vera.id }, NOW);
    assert.ok(!s.seenBy(s.vera.id, macTask).includes("Payroll export"));
    const userTask = s.userTask(s.vera.id);
    assert.ok(s.seenBy(s.vera.id, userTask).includes("Write the README"));
    s.tasks.update(macTask, { description: "the user's words" });
    const seen = s.seenBy(s.vera.id, macTask);
    assert.ok(seen.includes("the user's words") && !seen.includes("Payroll export"));
  });

  it("shows exactly what an allowed card delivered", () => {
    const s = setup();
    const handed = s.maxTask({ title: "Docs", description: "Cover setup" });
    s.approvals.decide(s.approvalOf(s.act(context(s.max.id), "handoff_task", { taskId: handed, to: "Vera" })), true);
    const seen = s.seenBy(s.vera.id, handed);
    assert.ok(seen.includes("Docs") && seen.includes("Cover setup"));

    const commented = s.maxTask({ title: "Budget", description: "the private numbers" });
    s.store.tasks.updateTask(commented, { assigneeId: s.vera.id }, NOW);
    s.approvals.decide(s.approvalOf(s.act(context(s.max.id), "comment_task", { taskId: commented, text: "see title" })), true);
    const partly = s.seenBy(s.vera.id, commented);
    assert.ok(partly.includes("Budget") && !partly.includes("the private numbers"));
  });

  it("marks fields by the mode the run launched in, and a Mac edit allowed for a virtual agent is visible", () => {
    const s = setup();
    const taskId = s.veraTask();
    s.store.updateAgent(s.vera.id, { computer: "mac" }, NOW);
    s.act(context(s.vera.id), "update_task", { taskId, title: "Vera's title" });
    assert.equal(s.store.tasks.getTask(taskId)?.titleMacOnly, false);
    s.store.updateAgent(s.vera.id, { computer: "virtual" }, NOW);
    s.approvals.decide(s.approvalOf(s.act(context(s.max.id), "update_task", { taskId, description: "Max's approved text" })), true);
    const seen = s.seenBy(s.vera.id, taskId);
    assert.ok(seen.includes("Vera's title") && seen.includes("Max's approved text"));
    const macTask = s.maxTask({ title: "Mine", description: "" });
    s.act(context(s.max.id), "update_task", { taskId: macTask, title: "Still mine" });
    assert.equal(s.store.tasks.getTask(macTask)?.titleMacOnly, true);
  });
});
