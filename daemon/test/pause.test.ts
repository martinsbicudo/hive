import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { namesFor } from "../src/computerArgs.ts";
import type { Store } from "../src/db.ts";
import { clock, local, stallingDocker } from "./controlFixtures.ts";
import { call, removeTempDirs } from "./fixtures.ts";
import { context, hubHarness, idOf, status, UI_SECRET, until } from "./taskFixtures.ts";

process.env.TZ = "America/New_York";

after(removeTempDirs);

const PAUSED = "Hive is paused.";

async function harness(start = local(10, 21, 8, 0), docker?: ReturnType<typeof stallingDocker>, store?: Store) {
  const c = clock(start);
  const h = await hubHarness(undefined, { now: c.now, docker, store });
  const api = (method: string, path: string, body?: unknown) => call(h.port, method, path, { token: UI_SECRET, body });
  const errors = (agentId: string) => h.hub.messages(agentId, 50).filter((message) => message.role === "error").map((message) => message.text);
  return { ...h, c, api, errors };
}

describe("pause", () => {
  it("stops an active run, a preparing run and a queued entry, denies approvals, stops computers and spawns nothing afterwards", async () => {
    const docker = stallingDocker();
    const h = await harness(local(10, 21, 8, 0), docker);
    try {
      const ana = h.agent({ name: "Ana" });
      const max = h.agent({ name: "Max" });
      const vera = h.agent({ name: "Vera", computer: "virtual" });
      const vic = h.agent({ name: "Vic", computer: "virtual" });
      h.script({ Ana: [[{ sleepMs: 8000 }, { say: "never" }]] });

      assert.equal((await h.api("POST", `/api/agents/${vic.id}/computer/start`)).status, 202);
      await until(() => h.hub.computers.statusOf(vic.id).state === "running", "Vic's computer");
      docker.arm();
      h.hub.send(vera.id, "go");
      await until(() => h.hub.computers.statusOf(vera.id).state === "starting", "Vera's computer to be starting");
      h.hub.send(ana.id, "first");
      await until(() => h.starts() === 1, "Ana's process to start");
      h.hub.send(ana.id, "second");
      assert.equal(h.hub.state().activity.find((item) => item.agentId === ana.id)?.queued, 1);
      assert.ok(h.hub.state().activity.some((item) => item.agentId === vera.id), "Vera is preparing");

      const toolApproval = h.hub.requestApproval(ana.id, "Write", { file_path: "/tmp/x" }).id;
      const taskId = h.hub.tasks.create({ title: "Write it", description: "" }).id;
      const gate = idOf(h.hub.tasks.act(context(max.id), "handoff_task", { taskId, to: "Vera" }), "approvalId");
      assert.throws(() => h.hub.tasks.act(context(max.id), "update_task", { taskId, status: "doing" }), status(409));

      const stopping = h.hub.control.pause();
      assert.ok(!h.hub.state().activity.some((item) => item.agentId === vera.id), "the preparing run is cancelled at once");
      docker.release();
      await stopping;
      assert.deepEqual(h.errors(vera.id), []);

      assert.equal(h.hub.state().paused, true);
      await until(() => h.hub.state().activity.length === 0, "every run to stop");
      assert.equal(h.store.getApproval(toolApproval)?.status, "denied");
      assert.equal(h.store.getApproval(gate)?.status, "denied");
      assert.doesNotThrow(() => h.hub.tasks.act(context(max.id), "update_task", { taskId, status: "doing" }));
      assert.equal(h.store.tasks.getTask(taskId)?.assigneeId, null);

      assert.equal(h.hub.computers.statusOf(vera.id).state, "stopped");
      assert.equal(h.hub.computers.statusOf(vic.id).state, "stopped");
      const stopOf = (agentId: string) => h.docker.calls.findIndex((entry) => entry.args[0] === "stop" && entry.args.includes(namesFor(agentId).agent));
      const startedVera = h.docker.calls.findIndex((entry) => entry.args[0] === "run" && entry.args.includes(namesFor(vera.id).agent));
      assert.ok(startedVera >= 0 && stopOf(vera.id) > startedVera, "Vera's computer was stopped after its start finished");
      assert.ok(stopOf(vic.id) >= 0);

      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(h.starts(), 1, "only Ana's first run ever started");
      assert.equal(h.runs().length, 0);
      assert.deepEqual(h.hub.state().activity, []);
      assert.ok(h.errors(ana.id).includes("Stopped."));
      assert.equal(h.hub.computers.statusOf(vera.id).state, "stopped");
    } finally {
      await h.close();
    }
  });

  it("a computer that is part-way through starting ends stopped, with no run spawned; the route does not wait for it", async () => {
    const docker = stallingDocker();
    const h = await harness(local(10, 21, 8, 0), docker);
    try {
      const vera = h.agent({ name: "Vera", computer: "virtual" });
      docker.arm();
      assert.equal((await h.api("POST", `/api/agents/${vera.id}/computer/start`)).status, 202);
      await until(() => h.hub.computers.statusOf(vera.id).state === "starting", "the computer to be starting");
      const paused = await h.api("POST", "/api/pause");
      assert.deepEqual(paused, { status: 200, body: { ok: true, paused: true } });
      docker.release();
      await until(() => h.hub.computers.statusOf(vera.id).state === "stopped" && docker.calls.some((entry) => entry.args[0] === "stop"), "the computer to be stopped");
      await new Promise((resolve) => setTimeout(resolve, 2200));
      assert.equal(h.hub.computers.statusOf(vera.id).state, "stopped");
      assert.equal(h.starts(), 0);
    } finally {
      await h.close();
    }
  });

  it("answers a message sent while paused with 'Hive is paused.' and spawns nothing; Resume lets the next message run", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      assert.equal((await h.api("POST", "/api/pause")).status, 200);
      assert.equal((await h.api("POST", `/api/agents/${ana.id}/messages`, { text: "hello" })).status, 202);
      assert.deepEqual(h.hub.messages(ana.id, 10).map((message) => [message.role, message.text]), [["user", "hello"], ["error", PAUSED]]);
      assert.equal(h.hub.state().activity.length, 0);
      assert.equal(h.starts(), 0);
      assert.deepEqual((await h.api("POST", "/api/resume")).body, { ok: true, paused: false });
      assert.equal(h.hub.state().paused, false);
      await h.api("POST", `/api/agents/${ana.id}/messages`, { text: "again" });
      await until(() => h.runs().length === 1, "the run after Resume");
      assert.equal(h.runs()[0]?.stdin, "again");
    } finally {
      await h.close();
    }
  });

  it("refuses a task run while paused, with the notice in the chat and the task thread", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      await h.api("POST", "/api/pause");
      const created = await h.api("POST", "/api/tasks", { title: "Write it", assigneeId: ana.id });
      assert.equal(created.status, 201);
      assert.deepEqual(h.errors(ana.id), [PAUSED]);
      assert.ok(h.store.tasks.listEvents(idOf(created.body, "id")).some((event) => event.text.includes("ended early")));
      assert.equal(h.starts(), 0);
    } finally {
      await h.close();
    }
  });

  it("the body must be empty: unknown fields get 400 and do not pause", async () => {
    const h = await harness();
    try {
      assert.equal((await h.api("POST", "/api/pause", { now: true })).status, 400);
      assert.equal((await h.api("POST", "/api/resume", { now: true })).status, 400);
      assert.equal(h.hub.state().paused, false);
    } finally {
      await h.close();
    }
  });
});

describe("schedules and the pause", () => {
  it("a wake due during the pause fires neither then nor after Resume, and the pause survives a restart", async () => {
    const first = await harness();
    const ana = first.agent({ name: "Ana" });
    await first.api("POST", `/api/agents/${ana.id}/schedules`, { kind: "daily", at: "09:00", prompt: "check the inbox" });
    first.c.set(local(10, 21, 8, 30));
    await first.api("POST", "/api/pause");
    assert.equal(first.hub.state().pausedAt, local(10, 21, 8, 30).toISOString());
    first.c.set(local(10, 21, 9, 10));
    first.hub.checkSchedules();
    assert.equal(first.hub.state().agents[0]?.nextWake, null);
    first.close();

    const second = await harness(local(10, 21, 9, 15), undefined, first.store);
    try {
      assert.equal(second.hub.state().paused, true);
      second.hub.checkSchedules();
      assert.equal(second.hub.state().activity.length, 0);
      assert.equal((await second.api("POST", "/api/resume")).status, 200);
      assert.equal(second.hub.state().pausedAt, null);
      second.c.set(local(10, 21, 9, 21));
      second.hub.checkSchedules();
      assert.equal(second.hub.state().activity.length, 0);
      assert.deepEqual(second.hub.messages(ana.id, 10), []);
      assert.equal(second.hub.state().agents[0]?.nextWake, local(10, 22, 9, 0).toISOString());

      second.c.set(local(10, 22, 9, 0, 30));
      second.hub.checkSchedules();
      await until(() => second.runs().length === 1, "the next day's wake");
      assert.equal(second.runs()[0]?.stdin, "Scheduled wake: check the inbox");
    } finally {
      second.close();
    }
  });

  it("a pause spanning a restart, resumed within 2 hours, does not fire the slot inside the pause, even if nothing checked during it", async () => {
    const first = await harness();
    const ana = first.agent({ name: "Ana" });
    await first.api("POST", `/api/agents/${ana.id}/schedules`, { kind: "daily", at: "09:00", prompt: "check the inbox" });
    first.c.set(local(10, 21, 8, 30));
    await first.api("POST", "/api/pause");
    first.close();

    const second = await harness(local(10, 21, 9, 20), undefined, first.store);
    try {
      assert.equal(second.hub.state().paused, true);
      await second.api("POST", "/api/resume");
      second.c.set(local(10, 21, 9, 21));
      second.hub.checkSchedules();
      assert.equal(second.hub.state().activity.length, 0);
      assert.deepEqual(second.hub.messages(ana.id, 10), []);
    } finally {
      second.close();
    }
  });
});

describe("run tokens and the control routes", () => {
  it("a run token gets 401 on pause, resume, budgets and schedules, and nothing changes", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      const id = idOf((await h.api("POST", `/api/agents/${ana.id}/schedules`, { kind: "daily", at: "09:00", prompt: "go" })).body, "id");
      const token = h.hub.runTokens.issue(ana.id);
      const routes: [string, string, unknown?][] = [
        ["POST", "/api/pause", {}], ["POST", "/api/resume", {}], ["GET", "/api/budgets"], ["PUT", "/api/budgets", { globalDailyTokens: 1 }],
        ["GET", `/api/agents/${ana.id}/schedules`],
        ["POST", `/api/agents/${ana.id}/schedules`, { kind: "daily", at: "10:00", prompt: "x" }],
        ["PATCH", `/api/agents/${ana.id}/schedules/${id}`, { enabled: false }],
        ["DELETE", `/api/agents/${ana.id}/schedules/${id}`],
      ];
      for (const [method, path, body] of routes) {
        assert.equal((await call(h.port, method, path, { token, body })).status, 401, `${method} ${path} with a run token`);
        assert.equal((await call(h.port, method, path, { body })).status, 401, `${method} ${path} with no token`);
      }
      assert.equal(h.hub.state().paused, false);
      assert.equal(h.store.settings.limits().globalDailyTokens, null);
      assert.deepEqual(h.store.schedules.list().map((schedule) => [schedule.id, schedule.enabled]), [[id, true]]);
      for (const path of ["/internal/pause", "/internal/resume", "/internal/budgets", `/internal/agents/${ana.id}/schedules`]) {
        assert.equal((await call(h.port, "POST", path, { token, body: {} })).status, 404, path);
        assert.equal((await call(h.port, "POST", path, { token: UI_SECRET, body: {} })).status, 401, path);
      }
      assert.equal((await h.api("POST", "/api/pause")).status, 200);
      assert.equal(h.hub.state().paused, true);
    } finally {
      await h.close();
    }
  });
});
