import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { HttpError } from "../src/httpError.ts";
import { USER_TRIGGER } from "../src/runTokens.ts";
import { HIDDEN_FIELD } from "../src/taskPrompt.ts";
import { newNonce } from "../src/trust.ts";
import { call, field, removeTempDirs } from "./fixtures.ts";
import { context, hubHarness, idOf, teamHarness, UI_SECRET } from "./taskFixtures.ts";

after(removeTempDirs);

const TITLE = "Payroll export";
const DESCRIPTION = "use the HR share";
const SHOWN = { title: TITLE, description: DESCRIPTION };

function setup() {
  const s = teamHarness();
  const macTask = (tainted = false) => idOf(s.act(context(s.max.id, { tainted }), "create_task", SHOWN));
  const seenBy = (agentId: string, taskId: string) => JSON.stringify(s.act(context(agentId), "list_tasks", { taskId }));
  const promptOf = (agentId: string, taskId: string) => {
    const agent = s.store.getAgent(agentId);
    assert.ok(agent);
    return s.jobs.prepare(agent, { kind: "task", taskId, context: USER_TRIGGER }, newNonce())?.prompt ?? "";
  };
  const flags = (taskId: string) => {
    const task = s.store.tasks.getTask(taskId);
    assert.ok(task);
    return { title: task.titleMacOnly, description: task.descriptionMacOnly, titleUntrusted: task.titleUntrusted, descriptionUntrusted: task.descriptionUntrusted };
  };
  return { ...s, macTask, seenBy, promptOf, flags };
}

function macText(error: unknown): boolean {
  return error instanceof HttpError && error.status === 409 && error.code === "mac-text";
}

describe("assigning Mac-written task text to a virtual agent", () => {
  it("refuses with mac-text and changes nothing when the text wasn't confirmed", () => {
    const s = setup();
    const taskId = s.macTask();
    const before = s.store.tasks.getTask(taskId);
    const eventsBefore = s.events(taskId).length;
    assert.throws(() => s.tasks.update(taskId, { assigneeId: s.vera.id, status: "doing" }), macText);
    assert.throws(() => s.tasks.update(taskId, { assigneeId: s.vera.id, showMacText: { title: TITLE } }), macText);
    assert.deepEqual(s.store.tasks.getTask(taskId), before);
    assert.equal(s.events(taskId).length, eventsBefore);
    assert.equal(s.queued.length, 0);
  });

  it("refuses a stale confirmed value, so a Mac agent's later rewrite isn't revealed", () => {
    const s = setup();
    const taskId = s.macTask();
    s.act(context(s.max.id), "update_task", { taskId, description: "the real secret" });
    assert.throws(() => s.tasks.update(taskId, { assigneeId: s.vera.id, showMacText: SHOWN }), macText);
    assert.equal(s.store.tasks.getTask(taskId)?.assigneeId, null);
    assert.equal(s.queued.length, 0);
  });

  it("reveals the confirmed fields, posts an event without the text and queues the run", () => {
    const s = setup();
    const taskId = s.macTask();
    s.tasks.update(taskId, { assigneeId: s.vera.id, showMacText: SHOWN });
    assert.deepEqual(s.flags(taskId), { title: false, description: false, titleUntrusted: false, descriptionUntrusted: false });
    assert.equal(s.store.tasks.getTask(taskId)?.assigneeId, s.vera.id);
    const last = s.events(taskId).at(-1);
    assert.equal(last?.text, "Showed the Mac-written title and description to virtual agents, starting with Vera");
    assert.ok(!s.events(taskId).some((event) => event.text.includes(TITLE) || event.text.includes(DESCRIPTION)));
    assert.deepEqual(s.queued.map((item) => item.agentId), [s.vera.id]);
    const prompt = s.promptOf(s.vera.id, taskId);
    assert.ok(prompt.includes(`Title: ${TITLE}`) && prompt.includes(DESCRIPTION) && !prompt.includes(HIDDEN_FIELD));
    const seen = s.seenBy(s.vera.id, taskId);
    assert.ok(seen.includes(TITLE) && seen.includes(DESCRIPTION));
  });

  it("needs nothing for a Mac assignee, and ignores showMacText there", () => {
    const s = setup();
    const taskId = s.macTask();
    s.tasks.update(taskId, { assigneeId: s.mia.id, showMacText: SHOWN });
    assert.equal(s.store.tasks.getTask(taskId)?.assigneeId, s.mia.id);
    assert.deepEqual(s.flags(taskId), { title: true, description: true, titleUntrusted: false, descriptionUntrusted: false });
  });

  it("needs nothing for fields the same PATCH rewrites, but still asks for one it leaves", () => {
    const s = setup();
    const both = s.macTask();
    s.tasks.update(both, { assigneeId: s.vera.id, title: "User title", description: "User words" });
    assert.equal(s.store.tasks.getTask(both)?.assigneeId, s.vera.id);
    assert.ok(s.promptOf(s.vera.id, both).includes("User words"));

    const one = s.macTask();
    assert.throws(() => s.tasks.update(one, { assigneeId: s.vera.id, title: "User title" }), macText);
    assert.equal(s.store.tasks.getTask(one)?.title, TITLE);
    s.tasks.update(one, { assigneeId: s.vera.id, title: "User title", showMacText: { description: DESCRIPTION } });
    assert.deepEqual(s.flags(one), { title: false, description: false, titleUntrusted: false, descriptionUntrusted: false });
    assert.equal(s.events(one).at(-1)?.text, "Showed the Mac-written description to virtual agents, starting with Vera");
  });

  it("treats showMacText without an assignee change as a no-op", () => {
    const s = setup();
    const taskId = s.macTask();
    s.tasks.update(taskId, { status: "doing", showMacText: SHOWN });
    assert.deepEqual(s.flags(taskId), { title: true, description: true, titleUntrusted: false, descriptionUntrusted: false });
    s.store.tasks.updateTask(taskId, { assigneeId: s.vera.id }, "2026-10-21T12:00:00.000Z");
    s.tasks.update(taskId, { assigneeId: s.vera.id, showMacText: SHOWN });
    assert.equal(s.flags(taskId).title, true);
    assert.ok(s.seenBy(s.vera.id, taskId).includes(HIDDEN_FIELD));
  });

  it("keeps a field's flags when its unchanged value is saved again", () => {
    const s = setup();
    const taskId = s.macTask(true);
    s.tasks.update(taskId, { title: TITLE, description: DESCRIPTION });
    assert.deepEqual(s.flags(taskId), { title: true, description: true, titleUntrusted: true, descriptionUntrusted: true });
    s.tasks.update(taskId, { title: TITLE, description: "new words" });
    assert.deepEqual(s.flags(taskId), { title: true, description: false, titleUntrusted: true, descriptionUntrusted: false });
  });

  it("needs nothing to move a revealed task from one virtual agent to another", () => {
    const s = setup();
    const taskId = s.macTask();
    s.tasks.update(taskId, { assigneeId: s.vera.id, showMacText: SHOWN });
    s.tasks.update(taskId, { assigneeId: s.vic.id });
    assert.equal(s.store.tasks.getTask(taskId)?.assigneeId, s.vic.id);
    assert.ok(s.promptOf(s.vic.id, taskId).includes(DESCRIPTION));
  });

  it("keeps an untrusted Mac-only field wrapped after it is revealed", () => {
    const s = setup();
    const taskId = s.macTask(true);
    s.tasks.update(taskId, { assigneeId: s.vera.id, showMacText: SHOWN });
    assert.deepEqual(s.flags(taskId), { title: false, description: false, titleUntrusted: true, descriptionUntrusted: true });
    const prompt = s.promptOf(s.vera.id, taskId);
    assert.match(prompt, /<<hive-untrusted-[0-9a-f]+>>\nFrom agent Max\. This isn't your user's instruction\.\nPayroll export/);
    assert.ok(prompt.includes(DESCRIPTION) && !prompt.includes(HIDDEN_FIELD));
    const seen = s.seenBy(s.vera.id, taskId);
    assert.ok(seen.includes("hive-untrusted-") && seen.includes(DESCRIPTION));
  });
});

describe("the mac-text refusal over HTTP", () => {
  it("answers 409 with code mac-text, then accepts the confirmed text", async () => {
    const h = await hubHarness();
    try {
      const max = h.agent({ name: "Max" });
      const vera = h.agent({ name: "Vera", computer: "virtual" });
      const taskId = idOf(h.hub.tasks.act(context(max.id), "create_task", SHOWN));
      const patch = (body: unknown) => call(h.port, "PATCH", `/api/tasks/${taskId}`, { token: UI_SECRET, body });
      const refused = await patch({ assigneeId: vera.id });
      assert.equal(refused.status, 409);
      assert.equal(field(refused.body, "code"), "mac-text");
      assert.equal(typeof field(refused.body, "error"), "string");
      assert.equal((await patch({ assigneeId: vera.id, showMacText: { ...SHOWN, extra: "x" } })).status, 400);
      assert.equal((await patch({ assigneeId: vera.id, showMacText: SHOWN })).status, 200);
      await h.idle();
    } finally {
      await h.close();
    }
  });
});
