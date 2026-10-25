import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { namesFor } from "../src/computerArgs.ts";
import { USER_TRIGGER } from "../src/runTokens.ts";
import { newNonce } from "../src/trust.ts";
import { removeTempDirs } from "./fixtures.ts";
import { context, hubHarness, idOf, teamHarness, until } from "./taskFixtures.ts";

after(removeTempDirs);

const LATE = [{ sleepMs: 700 }, { call: "comment_task", body: { taskId: "$TASK", text: "late comment" } }, { say: "late reply" }];

async function switchMidRun(from: "mac" | "virtual", to: "mac" | "virtual") {
  const h = await hubHarness();
  try {
    const agent = h.agent({ name: "Ada", computer: from });
    h.script({ Ada: [LATE] });
    const taskId = h.hub.tasks.create({ title: "Long job", assigneeId: agent.id }).id;
    await until(() => h.hub.state().activity.some((activity) => activity.agentId === agent.id && !activity.detail.startsWith("Starting")), "Ada's run");
    await new Promise((resolve) => setTimeout(resolve, 300));
    h.hub.updateAgent(agent.id, { computer: to });
    const switched = h.store.tasks.listEvents(taskId).map((event) => event.text);
    assert.ok(switched.some((text) => /^Ada changed where it works, so its current run was stopped/.test(text)));
    await h.idle();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const texts = h.store.tasks.listEvents(taskId).map((event) => event.text);
    assert.ok(!texts.includes("late comment") && !texts.includes("late reply"), JSON.stringify(texts));
    for (const run of h.runs()) assert.ok(run.calls.every((call) => call.status !== 200));
  } finally {
    await h.close();
  }
}

describe("a mode switch in the middle of a run", () => {
  it("Mac to virtual: the running Mac run is stopped, and nothing it does later lands", () => switchMidRun("mac", "virtual"));

  it("virtual to Mac: the running virtual run is stopped, and nothing it does later lands", () => switchMidRun("virtual", "mac"));
});

describe("a run that outlives its stop", () => {
  it("can't call Hive with its old token, and its output is dropped", async () => {
    const h = await hubHarness();
    try {
      const ada = h.agent({ name: "Ada" });
      const stubborn = [{ ignoreTerm: true }, { sleepMs: 700 }, { call: "list_tasks", body: {} }, { say: "late reply" }];
      h.script({ Ada: [stubborn] });
      const taskId = h.hub.tasks.create({ title: "Long job", assigneeId: ada.id }).id;
      await until(() => h.armed() === 1, "Ada's run to ignore SIGTERM");
      h.hub.updateAgent(ada.id, { computer: "virtual" });
      await until(() => h.runs().length === 1, "the stubborn run to exit");
      await h.idle();
      assert.deepEqual(h.runs()[0]?.calls.map((call) => call.status), [401]);
      assert.ok(!h.store.tasks.listEvents(taskId).some((event) => event.text === "late reply"));
    } finally {
      await h.close();
    }
  });

  it("a run that ignores SIGTERM is killed after the grace period", async () => {
    const h = await hubHarness();
    try {
      const ada = h.agent({ name: "Ada" });
      h.script({ Ada: [[{ ignoreTerm: true }, { sleepMs: 9000 }]] });
      h.hub.send(ada.id, "hold on");
      await until(() => h.armed() === 1, "Ada's run to ignore SIGTERM");
      const stoppedAt = Date.now();
      h.hub.updateAgent(ada.id, { computer: "virtual" });
      await h.idle();
      assert.ok(Date.now() - stoppedAt < 5000, `took ${Date.now() - stoppedAt} ms`);
    } finally {
      await h.close();
    }
  });

  it("closing the hub waits for a run that ignores SIGTERM to end", async () => {
    const h = await hubHarness();
    const ada = h.agent({ name: "Ada" });
    h.script({ Ada: [[{ ignoreTerm: true }, { sleepMs: 9000 }]] });
    h.hub.send(ada.id, "hold on");
    await until(() => h.armed() === 1, "Ada's run to ignore SIGTERM");
    await h.close();
    assert.deepEqual(h.hub.state().activity, []);
    assert.equal(h.hub.state().agents.find((agent) => agent.id === ada.id)?.status, "sleeping");
  });

  it("closing the harness removes the virtual working folder of an agent switched to virtual", async () => {
    const h = await hubHarness();
    const ada = h.agent({ name: "Ada" });
    h.hub.updateAgent(ada.id, { computer: "virtual" });
    h.hub.send(ada.id, "hi");
    await h.idle();
    const cwd = join(tmpdir(), namesFor(ada.id).agent);
    assert.ok(existsSync(cwd));
    await h.close();
    assert.ok(!existsSync(cwd));
  });

  it("a mode switch denies every pending approval the agent has", async () => {
    const h = await hubHarness();
    try {
      const ada = h.agent({ name: "Ada" });
      const { id } = h.hub.requestApproval(ada.id, "Bash", { command: "rm -rf build" });
      h.hub.updateAgent(ada.id, { computer: "virtual" });
      assert.equal(h.store.getApproval(id)?.status, "denied");
    } finally {
      await h.close();
    }
  });

  it("the interrupted task gets the mode-switch event even with no saved session", () => {
    const s = teamHarness();
    const taskId = s.userTask(s.max.id);
    s.tasks.modeChanged(s.max.id, "Max", { kind: "task", taskId, context: USER_TRIGGER });
    assert.match(s.events(taskId).at(-1)?.text ?? "", /^Max changed where it works, so its current run was stopped/);
  });
});

describe("a run keeps the mode it launched in", () => {
  it("a Mac-launched run still counts as Mac after the agent turns virtual", () => {
    const s = teamHarness();
    const launched = context(s.max.id);
    s.store.updateAgent(s.max.id, { computer: "virtual" }, "2026-10-21T12:00:00.000Z");
    const shared = s.veraTask();
    assert.equal(typeof idOf(s.act(launched, "comment_task", { taskId: shared, text: "from the Mac" }), "approvalId"), "string");
    const own = s.userTask();
    s.act(launched, "comment_task", { taskId: own, text: "plain" });
    const event = s.events(own).at(-1);
    assert.deepEqual([event?.text, event?.authorMac, event?.untrusted], ["plain", true, false]);
  });

  it("a virtual-launched run still counts as virtual and tainted after the agent moves to the Mac", () => {
    const s = teamHarness();
    const launched = context(s.vera.id);
    const taskId = s.veraTask();
    s.store.updateAgent(s.vera.id, { computer: "mac" }, "2026-10-21T12:00:00.000Z");
    s.act(launched, "comment_task", { taskId, text: "still virtual" });
    const event = s.events(taskId).at(-1);
    assert.deepEqual([event?.authorMac, event?.untrusted], [false, true]);
    assert.equal(typeof idOf(s.act(launched, "handoff_task", { taskId, to: "Max" }), "approvalId"), "string");
    assert.equal(s.queued.length, 0);
  });

  it("a task run's reply is authored by the mode it launched in", () => {
    const s = teamHarness();
    const macTask = s.userTask(s.max.id);
    const veraTask = s.userTask(s.vera.id);
    const stored = (id: string) => {
      const agent = s.store.getAgent(id);
      assert.ok(agent);
      return agent;
    };
    const macJob = s.jobs.prepare(stored(s.max.id), { kind: "task", taskId: macTask, context: USER_TRIGGER }, newNonce());
    const veraJob = s.jobs.prepare(stored(s.vera.id), { kind: "task", taskId: veraTask, context: USER_TRIGGER }, newNonce());
    s.store.updateAgent(s.max.id, { computer: "virtual" }, "2026-10-21T12:00:00.000Z");
    s.store.updateAgent(s.vera.id, { computer: "mac" }, "2026-10-21T12:00:00.000Z");
    macJob?.reply("mac reply", { tainted: false, launchedVirtual: false });
    veraJob?.reply("virtual reply", { tainted: true, launchedVirtual: true });
    assert.equal(s.events(macTask).at(-1)?.authorMac, true);
    assert.equal(s.events(veraTask).at(-1)?.authorMac, false);
  });
});
