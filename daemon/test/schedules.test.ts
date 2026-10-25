import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { call, field, removeTempDirs } from "./fixtures.ts";
import { clock, local } from "./controlFixtures.ts";
import { hubHarness, idOf, UI_SECRET, until } from "./taskFixtures.ts";

process.env.TZ = "America/New_York";

after(removeTempDirs);

async function harness(start = local(10, 21, 8, 0)) {
  const c = clock(start);
  const h = await hubHarness(undefined, { now: c.now });
  const api = (method: string, path: string, body?: unknown) => call(h.port, method, path, { token: UI_SECRET, body });
  return { ...h, c, api };
}

describe("schedule routes", () => {
  it("creates, lists, edits and deletes a schedule", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      const created = await h.api("POST", `/api/agents/${ana.id}/schedules`, { kind: "daily", at: "09:00", prompt: "check the inbox" });
      assert.equal(created.status, 201);
      const id = idOf(created.body, "id");
      assert.deepEqual(
        [field(created.body, "kind"), field(created.body, "at"), field(created.body, "everyMinutes"), field(created.body, "enabled"), field(created.body, "lastFiredAt"), field(created.body, "agentId")],
        ["daily", "09:00", null, true, null, ana.id],
      );
      assert.deepEqual((await h.api("GET", `/api/agents/${ana.id}/schedules`)).body, [created.body]);
      const edited = await h.api("PATCH", `/api/agents/${ana.id}/schedules/${id}`, { prompt: "new prompt", at: "10:30" });
      assert.equal(edited.status, 200);
      assert.deepEqual([field(edited.body, "prompt"), field(edited.body, "at")], ["new prompt", "10:30"]);
      assert.equal(h.store.schedules.get(id)?.at, "10:30");
      assert.equal((await h.api("DELETE", `/api/agents/${ana.id}/schedules/${id}`)).status, 200);
      assert.deepEqual((await h.api("GET", `/api/agents/${ana.id}/schedules`)).body, []);
    } finally {
      await h.close();
    }
  });

  it("answers 400 to anything that is not a well-formed, strict body", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      const path = `/api/agents/${ana.id}/schedules`;
      const valid = { kind: "daily", at: "09:00", prompt: "go" };
      const bad: Record<string, unknown>[] = [
        { ...valid, lastFiredAt: "2026-01-01T00:00:00.000Z" },
        { ...valid, agentId: "x" },
        { ...valid, at: "25:00" },
        { ...valid, at: "9:00" },
        { ...valid, at: "09:60" },
        { ...valid, kind: "monthly" },
        { ...valid, prompt: "" },
        { ...valid, prompt: "   " },
        { ...valid, prompt: "x".repeat(4001) },
        { ...valid, everyMinutes: 30 },
        { kind: "daily", prompt: "go" },
        { kind: "weekdays", at: null, prompt: "go" },
        { kind: "interval", everyMinutes: 14, prompt: "go" },
        { kind: "interval", everyMinutes: 1441, prompt: "go" },
        { kind: "interval", everyMinutes: 30.5, prompt: "go" },
        { kind: "interval", prompt: "go" },
        { kind: "interval", everyMinutes: 30, at: "09:00", prompt: "go" },
        { ...valid, enabled: "yes" },
      ];
      for (const body of bad) assert.equal((await h.api("POST", path, body)).status, 400, JSON.stringify(body));
      assert.equal(h.store.schedules.list().length, 0);
      assert.equal((await h.api("POST", path, { kind: "interval", everyMinutes: 15, prompt: "x".repeat(4000) })).status, 201);

      const id = idOf((await h.api("POST", path, valid)).body, "id");
      for (const body of [{ lastFiredAt: "x" }, { agentId: "x" }, { at: "24:00" }, { kind: "interval" }, { everyMinutes: 30 }, { prompt: "" }]) {
        assert.equal((await h.api("PATCH", `${path}/${id}`, body)).status, 400, JSON.stringify(body));
      }
      assert.equal(h.store.schedules.get(id)?.at, "09:00");
    } finally {
      await h.close();
    }
  });

  it("answers 404 for unknown agents and schedules, and for another agent's schedule", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      const bob = h.agent({ name: "Bob" });
      const id = idOf((await h.api("POST", `/api/agents/${ana.id}/schedules`, { kind: "daily", at: "09:00", prompt: "go" })).body, "id");
      assert.equal((await h.api("GET", "/api/agents/nope/schedules")).status, 404);
      assert.equal((await h.api("POST", "/api/agents/nope/schedules", { kind: "daily", at: "09:00", prompt: "go" })).status, 404);
      assert.equal((await h.api("PATCH", `/api/agents/${ana.id}/schedules/nope`, { prompt: "x" })).status, 404);
      assert.equal((await h.api("PATCH", `/api/agents/${bob.id}/schedules/${id}`, { prompt: "x" })).status, 404);
      assert.equal((await h.api("DELETE", `/api/agents/${bob.id}/schedules/${id}`)).status, 404);
      assert.equal(h.store.schedules.get(id)?.prompt, "go");
    } finally {
      await h.close();
    }
  });

  it("changing the interval resets its anchor to the time of the change; other edits do not", async () => {
    const h = await harness(local(10, 21, 10, 0));
    try {
      const ana = h.agent({ name: "Ana" });
      const id = idOf((await h.api("POST", `/api/agents/${ana.id}/schedules`, { kind: "interval", everyMinutes: 30, prompt: "go" })).body, "id");
      const nextWake = () => h.hub.state().agents.find((agent) => agent.id === ana.id)?.nextWake;
      assert.equal(nextWake(), local(10, 21, 10, 30).toISOString());
      h.c.set(local(10, 21, 10, 20));
      await h.api("PATCH", `/api/agents/${ana.id}/schedules/${id}`, { prompt: "other" });
      assert.equal(h.store.schedules.get(id)?.lastFiredAt, null);
      await h.api("PATCH", `/api/agents/${ana.id}/schedules/${id}`, { everyMinutes: 60 });
      assert.equal(h.store.schedules.get(id)?.lastFiredAt, local(10, 21, 10, 20).toISOString());
      assert.equal(nextWake(), local(10, 21, 11, 20).toISOString());
      h.c.set(local(10, 21, 10, 40));
      await h.api("PATCH", `/api/agents/${ana.id}/schedules/${id}`, { everyMinutes: 60 });
      assert.equal(h.store.schedules.get(id)?.lastFiredAt, local(10, 21, 10, 20).toISOString());
    } finally {
      await h.close();
    }
  });

  it("switching kind drops the field the new kind does not use", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      const path = `/api/agents/${ana.id}/schedules`;
      const id = idOf((await h.api("POST", path, { kind: "interval", everyMinutes: 30, prompt: "go" })).body, "id");
      const toWeekdays = await h.api("PATCH", `${path}/${id}`, { kind: "weekdays", at: "07:15" });
      assert.deepEqual([field(toWeekdays.body, "kind"), field(toWeekdays.body, "at"), field(toWeekdays.body, "everyMinutes")], ["weekdays", "07:15", null]);
      assert.equal((await h.api("PATCH", `${path}/${id}`, { kind: "interval" })).status, 400);
      const back = await h.api("PATCH", `${path}/${id}`, { kind: "interval", everyMinutes: 45 });
      assert.deepEqual([field(back.body, "at"), field(back.body, "everyMinutes")], [null, 45]);
    } finally {
      await h.close();
    }
  });

  it("state shows each agent's next wake, none for a disabled schedule", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      h.agent({ name: "Bob" });
      const id = idOf((await h.api("POST", `/api/agents/${ana.id}/schedules`, { kind: "daily", at: "09:00", prompt: "go" })).body, "id");
      const wakes = () => Object.fromEntries(h.hub.state().agents.map((agent) => [agent.name, agent.nextWake]));
      assert.deepEqual(wakes(), { Ana: local(10, 21, 9, 0).toISOString(), Bob: null });
      await h.api("PATCH", `/api/agents/${ana.id}/schedules/${id}`, { enabled: false });
      assert.deepEqual(wakes(), { Ana: null, Bob: null });
    } finally {
      await h.close();
    }
  });
});

describe("a scheduled wake", () => {
  it("is a user chat message prefixed 'Scheduled wake: ' and runs the agent", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      await h.api("POST", `/api/agents/${ana.id}/schedules`, { kind: "daily", at: "09:00", prompt: "check the inbox" });
      h.c.set(local(10, 21, 9, 1));
      h.hub.checkSchedules();
      await until(() => h.runs().length === 1, "the wake's run");
      assert.equal(h.runs()[0]?.stdin, "Scheduled wake: check the inbox");
      const chat = h.hub.messages(ana.id, 10);
      assert.deepEqual(chat.filter((message) => message.role === "user").map((message) => message.text), ["Scheduled wake: check the inbox"]);
    } finally {
      await h.close();
    }
  });

  it("for a busy agent queues behind the current run like any message", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      h.script({ Ana: [[{ sleepMs: 700 }, { say: "first done" }], [{ say: "wake done" }]] });
      await h.api("POST", `/api/agents/${ana.id}/schedules`, { kind: "daily", at: "09:00", prompt: "check the inbox" });
      h.hub.send(ana.id, "hello");
      await until(() => h.hub.state().activity.length === 1, "the first run");
      h.c.set(local(10, 21, 9, 1));
      h.hub.checkSchedules();
      assert.equal(h.hub.state().activity[0]?.queued, 1);
      assert.equal(h.runs().length, 0);
      await until(() => h.runs().length === 2, "both runs");
      await h.idle();
      assert.deepEqual(h.runs().map((run) => run.stdin), ["hello", "Scheduled wake: check the inbox"]);
    } finally {
      await h.close();
    }
  });

  it("a disabled schedule never runs the agent", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      await h.api("POST", `/api/agents/${ana.id}/schedules`, { kind: "daily", at: "09:00", prompt: "go", enabled: false });
      h.c.set(local(10, 21, 9, 1));
      h.hub.checkSchedules();
      assert.equal(h.hub.state().activity.length, 0);
      assert.deepEqual(h.hub.messages(ana.id, 10), []);
    } finally {
      await h.close();
    }
  });

  it("does not run again after a restart right after the slot fired", async () => {
    const first = await harness();
    const ana = first.agent({ name: "Ana" });
    await first.api("POST", `/api/agents/${ana.id}/schedules`, { kind: "daily", at: "09:00", prompt: "go" });
    first.c.set(local(10, 21, 9, 0, 5));
    first.hub.checkSchedules();
    await until(() => first.runs().length === 1, "the wake's run");
    first.close();
    const c = clock(local(10, 21, 9, 0, 20));
    const second = await hubHarness(undefined, { now: c.now, store: first.store });
    try {
      second.hub.startScheduler();
      c.set(local(10, 21, 9, 0, 50));
      second.hub.checkSchedules();
      assert.equal(second.hub.state().activity.length, 0);
      assert.equal(first.store.listMessages(ana.id, 10).filter((message) => message.role === "user").length, 1);
    } finally {
      second.close();
    }
  });
});

describe("deleting an agent", () => {
  it("deletes its schedules and keeps everyone else's", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      const bob = h.agent({ name: "Bob" });
      for (const agent of [ana, bob]) await h.api("POST", `/api/agents/${agent.id}/schedules`, { kind: "daily", at: "09:00", prompt: "go" });
      assert.equal(h.store.schedules.list().length, 2);
      assert.equal((await h.api("DELETE", `/api/agents/${ana.id}`)).status, 200);
      assert.deepEqual(h.store.schedules.list().map((schedule) => schedule.agentId), [bob.id]);
    } finally {
      await h.close();
    }
  });
});
