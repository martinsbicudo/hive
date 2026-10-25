import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { addRun } from "./controlFixtures.ts";
import { architectHarness, json, proposal, user } from "./architectFixtures.ts";
import { field, removeTempDirs } from "./fixtures.ts";
import { addAgent, until } from "./taskFixtures.ts";

after(removeTempDirs);

const SLOW = { steps: [{ writeFile: "scratch.txt" }, { sleepMs: 8000 }, { say: "too late" }] };
const NO_LIMITS = { globalDailyUsdCents: null, globalDailyTokens: null, globalMonthlyUsdCents: null };

describe("Architect lifecycle", () => {
  it("empties its dir after every run", async () => {
    const h = await architectHarness();
    try {
      h.script([{ steps: [{ writeFile: "scratch.txt" }, { say: "Which inbox?" }] }]);
      assert.equal((await h.turn([user("hi")])).status, 200);
      assert.equal(h.starts()[0]?.cwd.endsWith(join("hive-architect", "cwd")), true);
      assert.equal(existsSync(h.cwd), false);
    } finally {
      h.close();
    }
  });

  it("has one deadline for the whole turn, retry included", async () => {
    const h = await architectHarness({ deadlineMs: 4000 });
    try {
      h.script([{ steps: [{ say: "```json\n{oops}\n```" }] }, { steps: [{ ignoreTerm: true }, { sleepMs: 10_000 }, { say: json(proposal()) }] }]);
      const started = Date.now();
      const reply = await h.turn([user("hi")]);
      assert.deepEqual(reply.body, { reply: "", proposal: null, error: "The Architect took too long to answer. Try again." });
      assert.equal(h.armed(), 1, "the retry started before the one deadline fired");
      assert.ok(Date.now() - started < 9000, "killed at the deadline, SIGKILL after the grace period, not after the retry's own 10 s");
      assert.equal(h.starts().length, 2);
      assert.equal(h.finished(), 1);
      assert.deepEqual(h.store.runsSince("1970-01-01T00:00:00.000Z").map((run) => run.status).sort(), ["done", "failed"]);
    } finally {
      h.close();
    }
  });

  it("stops through POST /api/architect/stop", async () => {
    const h = await architectHarness();
    try {
      h.script([SLOW]);
      const turn = h.turn([user("hi")]);
      await until(() => h.starts().length === 1, "the Architect to start");
      assert.equal((await h.api("POST", "/api/architect/stop", { now: true })).status, 400);
      assert.deepEqual((await h.api("POST", "/api/architect/stop", {})).body, { ok: true, stopped: true });
      assert.deepEqual((await turn).body, { reply: "", proposal: null, error: "Stopped." });
      assert.deepEqual((await h.api("POST", "/api/architect/stop", {})).body, { ok: true, stopped: false });
      assert.equal(h.finished(), 0);
      assert.deepEqual(h.store.runsSince("1970-01-01T00:00:00.000Z").map((run) => run.status), ["stopped"]);
    } finally {
      h.close();
    }
  });

  it("is killed by pause, its dir is emptied, and it is refused while paused", async () => {
    const h = await architectHarness();
    try {
      h.script([SLOW]);
      const turn = h.turn([user("hi")]);
      await until(() => existsSync(join(h.cwd, "scratch.txt")), "the Architect to write in its dir");
      assert.equal((await h.api("POST", "/api/pause", {})).status, 200);
      assert.deepEqual((await turn).body, { reply: "", proposal: null, error: "Hive is paused." });
      assert.equal(existsSync(h.cwd), false);
      assert.equal(h.finished(), 0);
      const refused = await h.turn([user("again")]);
      assert.equal(refused.status, 409);
      assert.equal(field(refused.body, "error"), "Hive is paused.");
      assert.equal(h.starts().length, 1);
    } finally {
      h.close();
    }
  });

  it("answers 409 to a second turn while one runs", async () => {
    const h = await architectHarness();
    try {
      h.script([SLOW]);
      const turn = h.turn([user("hi")]);
      await until(() => h.starts().length === 1, "the Architect to start");
      const second = await h.turn([user("me too")]);
      assert.equal(second.status, 409);
      assert.match(String(field(second.body, "error")), /already answering/);
      h.hub.architect.stop();
      await turn;
      assert.equal(h.starts().length, 1);
    } finally {
      h.close();
    }
  });

  it("answers 409 when a global budget is spent, and ignores agents' own budgets", async () => {
    const h = await architectHarness();
    try {
      const ana = addAgent(h.store, { name: "Ana" });
      h.store.updateAgent(ana.id, { dailyBudget: 0 }, new Date().toISOString());
      h.script([{ steps: [{ say: "Which inbox?" }] }]);
      assert.equal((await h.turn([user("hi")])).status, 200);

      h.store.settings.setLimits({ ...NO_LIMITS, globalDailyUsdCents: 1 });
      addRun(h.store, ana.id, "claude-code", { costUsd: 0.05, startedAt: new Date() });
      const refused = await h.turn([user("hi")]);
      assert.equal(refused.status, 409);
      assert.equal(field(refused.body, "error"), "Hive reached its daily budget of $0.01. Runs resume tomorrow.");
      assert.equal(h.starts().length, 1);
    } finally {
      h.close();
    }
  });

  it("checks the global budget again before the retry", async () => {
    const h = await architectHarness();
    try {
      h.store.settings.setLimits({ ...NO_LIMITS, globalMonthlyUsdCents: 2 });
      h.script([{ cost: 0.03, steps: [{ say: "```json\n{oops}\n```" }] }, { steps: [{ say: json(proposal()) }] }]);
      const reply = await h.turn([user("hi")]);
      assert.equal(reply.status, 409);
      assert.equal(field(reply.body, "error"), "Hive reached its monthly budget of $0.02. Runs resume next month.");
      assert.equal(h.starts().length, 1);
      assert.deepEqual(field((await h.api("POST", "/api/architect/stop", {})).body, "stopped"), false);
    } finally {
      h.close();
    }
  });
});
