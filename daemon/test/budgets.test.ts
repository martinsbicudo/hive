import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { addRun, clock, local, notifications, stallingDocker } from "./controlFixtures.ts";
import { call, field, removeTempDirs } from "./fixtures.ts";
import { hubHarness, idOf, UI_SECRET, until } from "./taskFixtures.ts";

after(removeTempDirs);

async function harness(options: { docker?: ReturnType<typeof stallingDocker> } = {}) {
  const c = clock(local(10, 21, 15, 0));
  const h = await hubHarness(undefined, { now: c.now, docker: options.docker });
  const api = (method: string, path: string, body?: unknown) => call(h.port, method, path, { token: UI_SECRET, body });
  const notes = notifications(h.hub);
  const errors = (agentId: string) => h.hub.messages(agentId, 50).filter((message) => message.role === "error").map((message) => message.text);
  const setBudget = async (id: string, dailyBudget: number | null) => {
    assert.equal((await api("PATCH", `/api/agents/${id}`, { dailyBudget })).status, 200);
  };
  return { ...h, c, api, notes, errors, setBudget };
}

describe("a per-agent daily budget (Claude Code: USD cents)", () => {
  it("runs under the limit, refuses at the limit with the budget message and one notify, and runs again the next local day", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      const bob = h.agent({ name: "Bob" });
      await h.setBudget(ana.id, 100);
      addRun(h.store, ana.id, "claude-code", { costUsd: 0.25, startedAt: local(10, 21, 9, 0) });
      addRun(h.store, ana.id, "claude-code", { costUsd: 0.5, startedAt: local(10, 21, 10, 0) });
      h.hub.send(ana.id, "under the limit");
      await until(() => h.runs().length === 1, "the run under the limit");
      await h.idle();

      addRun(h.store, ana.id, "claude-code", { costUsd: 0.25, startedAt: local(10, 21, 11, 0) });
      h.hub.send(ana.id, "at the limit");
      assert.equal(h.hub.state().activity.length, 0);
      assert.deepEqual(h.errors(ana.id), ["Ana reached its daily budget of $1.00. It can run again tomorrow."]);
      assert.equal(h.starts(), 1);
      assert.deepEqual(h.notes.map((note) => [note.kind, note.agentId, note.text]), [["budget", ana.id, "Ana reached its daily budget of $1.00. It can run again tomorrow."]]);

      h.hub.send(ana.id, "still blocked");
      assert.equal(h.errors(ana.id).length, 2);
      assert.equal(h.notes.length, 1);
      assert.equal(h.starts(), 1);

      h.hub.send(bob.id, "Bob has no budget");
      await until(() => h.runs().length === 2, "Bob's run");
      await h.idle();

      h.c.set(local(10, 22, 9, 0));
      h.hub.send(ana.id, "a new day");
      await until(() => h.runs().length === 3, "the next day's run");
      assert.equal(h.errors(ana.id).length, 2);
    } finally {
      await h.close();
    }
  });

  it("clearing the budget lets the agent run, and bad values are refused", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      await h.setBudget(ana.id, 100);
      addRun(h.store, ana.id, "claude-code", { costUsd: 5, startedAt: local(10, 21, 9, 0) });
      h.hub.send(ana.id, "blocked");
      assert.equal(h.starts(), 0);
      for (const dailyBudget of [-1, 1.5, "5", true]) assert.equal((await h.api("PATCH", `/api/agents/${ana.id}`, { dailyBudget })).status, 400, String(dailyBudget));
      assert.equal(h.store.getAgent(ana.id)?.dailyBudget, 100);
      await h.setBudget(ana.id, null);
      h.hub.send(ana.id, "unblocked");
      await until(() => h.runs().length === 1, "the unblocked run");
    } finally {
      await h.close();
    }
  });

  it("refuses queued entries when the budget runs out while the agent is busy, and the queue moves on", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      h.script({ Ana: [[{ sleepMs: 600 }, { say: "done" }]] });
      await h.setBudget(ana.id, 100);
      h.hub.send(ana.id, "first");
      await until(() => h.hub.state().activity.length === 1, "the first run");
      h.hub.send(ana.id, "queued");
      assert.equal(h.hub.state().activity[0]?.queued, 1);
      addRun(h.store, ana.id, "claude-code", { costUsd: 2, startedAt: local(10, 21, 14, 0) });
      await until(() => h.hub.state().activity.length === 0, "the queue to drain");
      assert.equal(h.starts(), 1);
      assert.equal(h.errors(ana.id).length, 1);
    } finally {
      await h.close();
    }
  });

  it("refuses a task run and says so in the task thread", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      await h.setBudget(ana.id, 100);
      addRun(h.store, ana.id, "claude-code", { costUsd: 2, startedAt: local(10, 21, 14, 0) });
      const created = await h.api("POST", "/api/tasks", { title: "Write it", assigneeId: ana.id });
      const events = h.store.tasks.listEvents(idOf(created.body, "id"));
      assert.ok(events.some((event) => event.author === "system" && event.text.includes("ended early")));
      assert.equal(h.errors(ana.id).length, 1);
      assert.equal(h.starts(), 0);
    } finally {
      await h.close();
    }
  });

  it("is rechecked when a virtual agent's computer finishes starting, before anything spawns", async () => {
    const docker = stallingDocker();
    const h = await harness({ docker });
    try {
      const vera = h.agent({ name: "Vera", computer: "virtual" });
      await h.setBudget(vera.id, 100);
      docker.arm();
      h.hub.send(vera.id, "go");
      await until(() => h.hub.computers.statusOf(vera.id).state === "starting", "the computer to start");
      addRun(h.store, vera.id, "claude-code", { costUsd: 2, startedAt: local(10, 21, 14, 0) });
      docker.release();
      await until(() => h.hub.state().activity.length === 0 && h.errors(vera.id).length === 1, "the refusal");
      assert.equal(h.starts(), 0);
    } finally {
      await h.close();
    }
  });
});

describe("a Codex agent's daily budget counts tokens", () => {
  it("ignores the cost, blocks at the token limit, and a Claude agent's budget ignores tokens", async () => {
    const h = await harness();
    try {
      const cody = h.agent({ name: "Cody", engine: "codex" });
      const ana = h.agent({ name: "Ana" });
      await h.setBudget(cody.id, 1000);
      await h.setBudget(ana.id, 100);
      addRun(h.store, cody.id, "codex", { costUsd: 50, tokens: 10, startedAt: local(10, 21, 9, 0) });
      addRun(h.store, ana.id, "claude-code", { costUsd: 0, tokens: 5_000_000, startedAt: local(10, 21, 9, 0) });
      h.hub.send(cody.id, "cost is not counted");
      h.hub.send(ana.id, "tokens are not counted");
      await until(() => h.runs().length === 2, "both runs");
      await h.idle();
      assert.equal(h.errors(cody.id).length + h.errors(ana.id).length, 0);

      addRun(h.store, cody.id, "codex", { tokens: 990, startedAt: local(10, 21, 10, 0) });
      h.hub.send(cody.id, "now at the limit");
      assert.equal(h.hub.state().activity.length, 0);
      assert.deepEqual(h.errors(cody.id), ["Cody reached its daily budget of 1,000 tokens. It can run again tomorrow."]);
      assert.deepEqual(h.notes.map((note) => note.kind), ["budget"]);
      assert.equal(h.starts(), 2);
    } finally {
      await h.close();
    }
  });
});

describe("global budgets", () => {
  it("the daily USD limit blocks every agent, one notify per agent, and again on a later day", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      const bob = h.agent({ name: "Bob" });
      const set = await h.api("PUT", "/api/budgets", { globalDailyUsdCents: 100 });
      assert.equal(set.status, 200);
      assert.equal(field(field(set.body, "limits"), "globalDailyUsdCents"), 100);
      addRun(h.store, bob.id, "claude-code", { costUsd: 1, startedAt: local(10, 21, 9, 0) });
      h.hub.send(ana.id, "one");
      h.hub.send(bob.id, "two");
      h.hub.send(ana.id, "three");
      const text = "Hive reached its daily budget of $1.00. Runs resume tomorrow.";
      assert.deepEqual(h.errors(ana.id), [text, text]);
      assert.deepEqual(h.errors(bob.id), [text]);
      assert.deepEqual(h.notes.map((note) => [note.kind, note.agentId]), [["budget", ana.id], ["budget", bob.id]]);
      assert.equal(h.starts(), 0);

      h.c.set(local(10, 22, 9, 0));
      h.hub.send(ana.id, "next day");
      await until(() => h.runs().length === 1, "the next day's run");
      await h.idle();
      addRun(h.store, ana.id, "claude-code", { costUsd: 1, startedAt: local(10, 22, 10, 0) });
      h.hub.send(ana.id, "blocked again");
      assert.equal(h.notes.length, 3);

      await h.api("PUT", "/api/budgets", { globalDailyUsdCents: null });
      h.hub.send(ana.id, "unlimited");
      await until(() => h.runs().length === 2, "the unlimited run");
    } finally {
      await h.close();
    }
  });

  it("the daily token limit counts every engine's tokens", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      const cody = h.agent({ name: "Cody", engine: "codex" });
      await h.api("PUT", "/api/budgets", { globalDailyTokens: 1000 });
      addRun(h.store, cody.id, "codex", { tokens: 600, startedAt: local(10, 21, 9, 0) });
      h.hub.send(ana.id, "under");
      await until(() => h.runs().length === 1, "the run under the limit");
      await h.idle();
      addRun(h.store, ana.id, "claude-code", { tokens: 400, startedAt: local(10, 21, 10, 0) });
      h.hub.send(ana.id, "over");
      assert.deepEqual(h.errors(ana.id), ["Hive reached its daily limit of 1,000 tokens. Runs resume tomorrow."]);
      assert.equal(h.notes.length, 1);
      assert.equal(h.starts(), 1);
    } finally {
      await h.close();
    }
  });

  it("the monthly USD limit holds across days, ignores earlier months and resets next month", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      await h.api("PUT", "/api/budgets", { globalMonthlyUsdCents: 500 });
      addRun(h.store, ana.id, "claude-code", { costUsd: 9, startedAt: new Date(2026, 8, 30, 12, 0) });
      h.hub.send(ana.id, "last month's spend is not counted");
      await until(() => h.runs().length === 1, "the first run");
      await h.idle();

      addRun(h.store, ana.id, "claude-code", { costUsd: 5, startedAt: local(10, 3, 12, 0) });
      const text = "Hive reached its monthly budget of $5.00. Runs resume next month.";
      h.hub.send(ana.id, "blocked");
      assert.deepEqual(h.errors(ana.id), [text]);
      h.c.set(local(10, 22, 9, 0));
      h.hub.send(ana.id, "still blocked tomorrow");
      assert.deepEqual(h.errors(ana.id), [text, text]);
      assert.equal(h.starts(), 1);

      h.c.set(local(11, 2, 9, 0));
      h.hub.send(ana.id, "next month");
      await until(() => h.runs().length === 2, "the next month's run");
    } finally {
      await h.close();
    }
  });

  it("GET and PUT /api/budgets report limits and what was spent, merge partial updates and validate strictly", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      await h.setBudget(ana.id, 300);
      addRun(h.store, ana.id, "claude-code", { costUsd: 1.5, tokens: 20, startedAt: local(10, 21, 9, 0) });
      addRun(h.store, ana.id, "claude-code", { costUsd: 2, startedAt: local(10, 5, 9, 0) });
      await h.api("PUT", "/api/budgets", { globalDailyTokens: 5000 });
      await h.api("PUT", "/api/budgets", { globalMonthlyUsdCents: 2000 });
      const got = await h.api("GET", "/api/budgets");
      assert.deepEqual(field(got.body, "limits"), { globalDailyUsdCents: null, globalDailyTokens: 5000, globalMonthlyUsdCents: 2000 });
      assert.deepEqual(field(got.body, "spent"), { todayUsd: 1.5, todayTokens: 20, monthUsd: 3.5 });
      assert.deepEqual(field(got.body, "agents"), [{ agentId: ana.id, unit: "usd-cents", limit: 300, spent: 150 }]);
      assert.deepEqual(h.hub.state().budgets, got.body);
      for (const body of [{ extra: 1 }, { globalDailyTokens: -1 }, { globalDailyTokens: 1.5 }, { globalDailyUsdCents: "5" }, { globalDailyUsdCents: true }]) {
        assert.equal((await h.api("PUT", "/api/budgets", body)).status, 400, JSON.stringify(body));
      }
      assert.deepEqual(field((await h.api("GET", "/api/budgets")).body, "limits"), { globalDailyUsdCents: null, globalDailyTokens: 5000, globalMonthlyUsdCents: 2000 });
    } finally {
      await h.close();
    }
  });
});
