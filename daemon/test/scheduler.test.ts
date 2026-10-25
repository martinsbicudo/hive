import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dueWakes, earliestWake, nextWake } from "../src/scheduler.ts";
import { local, schedule, schedulerHarness } from "./controlFixtures.ts";

process.env.TZ = "America/New_York";

describe("the test time zone", () => {
  it("is New York, with the fall-back and spring-forward days where the spec expects them", () => {
    assert.equal(new Date(2026, 10, 1, 1, 30).toISOString(), "2026-11-01T05:30:00.000Z");
    assert.equal(new Date(2026, 2, 8, 2, 30).toISOString(), "2026-03-08T07:30:00.000Z");
  });
});

describe("daily and weekday slots", () => {
  it("a daily schedule fires once at its time and again the next day", () => {
    const h = schedulerHarness(local(10, 21, 8, 0));
    h.add({ at: "09:00" });
    h.at(local(10, 21, 8, 59));
    assert.equal(h.fired.length, 0);
    h.at(local(10, 21, 9, 0, 10));
    assert.deepEqual(h.fired.map((due) => due.prompt), ["check the inbox"]);
    h.at(local(10, 21, 9, 0, 40));
    h.at(local(10, 21, 17, 0));
    assert.equal(h.fired.length, 1);
    h.at(local(10, 22, 9, 0, 5));
    assert.equal(h.fired.length, 2);
  });

  it("a weekday schedule skips Saturday and Sunday and fires on Monday", () => {
    const h = schedulerHarness(local(10, 23, 8, 0));
    h.add({ kind: "weekdays" });
    h.at(local(10, 23, 9, 1));
    assert.equal(h.fired.length, 1);
    h.at(local(10, 24, 9, 1));
    h.at(local(10, 25, 9, 1));
    assert.equal(h.fired.length, 1);
    h.at(local(10, 26, 9, 1));
    assert.equal(h.fired.length, 2);
  });

  it("a weekday schedule created on a Saturday does not fire that day", () => {
    const h = schedulerHarness(local(10, 24, 8, 0));
    h.add({ kind: "weekdays" });
    h.at(local(10, 24, 9, 1));
    assert.equal(h.fired.length, 0);
    h.at(local(10, 26, 9, 1));
    assert.equal(h.fired.length, 1);
  });

  it("moving the time later after it fired today does not fire it a second time that day", () => {
    const h = schedulerHarness(local(10, 21, 8, 0));
    h.add({ at: "09:00" });
    h.at(local(10, 21, 9, 1));
    h.store.schedules.update("s1", { at: "11:00" });
    h.at(local(10, 21, 11, 1));
    assert.equal(h.fired.length, 1);
    h.at(local(10, 22, 11, 1));
    assert.equal(h.fired.length, 2);
  });
});

describe("interval slots", () => {
  it("fires every N minutes, on the grid from its anchor", () => {
    const h = schedulerHarness(local(10, 21, 10, 0));
    h.add({ kind: "interval", at: null, everyMinutes: 15 });
    h.at(local(10, 21, 10, 14, 59));
    assert.equal(h.fired.length, 0);
    h.at(local(10, 21, 10, 15, 5));
    assert.equal(h.fired.length, 1);
    h.at(local(10, 21, 10, 20));
    assert.equal(h.fired.length, 1);
    h.at(local(10, 21, 10, 30, 2));
    assert.equal(h.fired.length, 2);
    assert.equal(h.lastFired(), local(10, 21, 10, 30).toISOString());
    h.at(local(10, 21, 10, 44));
    assert.equal(h.fired.length, 2);
    h.at(local(10, 21, 10, 45));
    assert.equal(h.fired.length, 3);
  });

  it("slots missed while asleep fire once, on the latest slot", () => {
    const h = schedulerHarness(local(10, 21, 10, 0));
    h.add({ kind: "interval", at: null, everyMinutes: 60 });
    h.at(local(10, 21, 14, 30));
    assert.equal(h.fired.length, 1);
    assert.equal(h.lastFired(), local(10, 21, 14, 0).toISOString());
    h.at(local(10, 21, 14, 31));
    assert.equal(h.fired.length, 1);
    h.at(local(10, 21, 15, 0, 5));
    assert.equal(h.fired.length, 2);
  });

  it("a slot missed by 3 hours is skipped, and the next slot is a full interval later", () => {
    const h = schedulerHarness(local(10, 21, 10, 0));
    h.add({ kind: "interval", at: null, everyMinutes: 1440 });
    h.at(local(10, 22, 13, 0));
    assert.equal(h.fired.length, 0);
    assert.equal(h.lastFired(), local(10, 22, 10, 0).toISOString());
    h.at(local(10, 23, 10, 0, 5));
    assert.equal(h.fired.length, 1);
  });
});

describe("missed slots", () => {
  it("a slot missed by 1 hour fires once at the next check", () => {
    const h = schedulerHarness(local(10, 21, 8, 0));
    h.add();
    h.at(local(10, 21, 10, 0));
    assert.equal(h.fired.length, 1);
    h.at(local(10, 21, 10, 0, 30));
    assert.equal(h.fired.length, 1);
  });

  it("a slot missed by 3 hours does not fire, is consumed, and the next day fires", () => {
    const h = schedulerHarness(local(10, 21, 8, 0));
    h.add();
    h.at(local(10, 21, 12, 0));
    assert.equal(h.fired.length, 0);
    assert.equal(h.lastFired(), local(10, 21, 9, 0).toISOString());
    h.at(local(10, 21, 12, 0, 30));
    assert.equal(h.fired.length, 0);
    h.at(local(10, 22, 9, 0, 5));
    assert.equal(h.fired.length, 1);
  });

  it("the limit is 2 hours: 1:59:59 late fires, exactly 2:00:00 late does not", () => {
    const early = schedulerHarness(local(10, 21, 8, 0));
    early.add();
    early.at(local(10, 21, 10, 59, 59));
    assert.equal(early.fired.length, 1);
    const late = schedulerHarness(local(10, 21, 8, 0));
    late.add();
    late.at(local(10, 21, 11, 0, 0));
    assert.equal(late.fired.length, 0);
  });

  it("never fires slots from before the schedule was created", () => {
    const h = schedulerHarness(local(10, 21, 9, 30));
    h.add();
    h.at(local(10, 21, 9, 31));
    assert.equal(h.fired.length, 0);
  });
});

describe("disabled schedules", () => {
  it("never fire, and enabling one later does not replay the slot it missed", () => {
    const h = schedulerHarness(local(10, 21, 8, 0));
    h.add({ enabled: false });
    h.at(local(10, 21, 9, 5));
    assert.equal(h.fired.length, 0);
    h.store.schedules.update("s1", { enabled: true });
    h.at(local(10, 21, 9, 30));
    assert.equal(h.fired.length, 0);
    h.at(local(10, 22, 9, 1));
    assert.equal(h.fired.length, 1);
  });
});

describe("restarts", () => {
  it("a restart right after a slot fired does not fire it again", () => {
    const h = schedulerHarness(local(10, 21, 8, 0));
    h.add();
    h.at(local(10, 21, 9, 0, 5));
    assert.equal(h.fired.length, 1);
    const restarted = schedulerHarness(local(10, 21, 9, 0, 20));
    for (const stored of h.store.schedules.list()) restarted.store.schedules.insert(stored);
    restarted.scheduler.start();
    restarted.scheduler.stop();
    restarted.at(local(10, 21, 9, 0, 50));
    assert.equal(restarted.fired.length, 0);
  });

  it("the stored lastFiredAt is the only memory: a fresh Scheduler on the same store does not refire", () => {
    const h = schedulerHarness(local(10, 21, 8, 0));
    h.add();
    h.at(local(10, 21, 9, 0, 5));
    const again = dueWakes(h.store.schedules.list(), local(10, 21, 9, 0, 35), false);
    assert.deepEqual(again, []);
  });
});

describe("pause", () => {
  it("every check while paused consumes the current slot without firing it", () => {
    const h = schedulerHarness(local(10, 21, 8, 0));
    h.add();
    h.state.paused = true;
    h.at(local(10, 21, 9, 10));
    assert.equal(h.fired.length, 0);
    assert.equal(h.lastFired(), local(10, 21, 9, 0).toISOString());
    h.state.paused = false;
    h.at(local(10, 21, 9, 20));
    assert.equal(h.fired.length, 0);
  });

  it("resuming consumes every current slot before the flag clears, even if no check ran during the pause", () => {
    const h = schedulerHarness(local(10, 21, 8, 0));
    h.add();
    h.add({ id: "s2", kind: "interval", at: null, everyMinutes: 15 });
    h.state.now = local(10, 21, 9, 20);
    h.state.paused = true;
    h.scheduler.consumeAll();
    h.state.paused = false;
    h.at(local(10, 21, 9, 21));
    assert.equal(h.fired.length, 0);
    h.at(local(10, 21, 9, 45, 5));
    assert.deepEqual(h.fired.map((due) => due.id), ["s2"]);
  });
});

describe("DST days", () => {
  it("a 01:30 daily schedule fires once on the fall-back day, on the first 01:30", () => {
    const h = schedulerHarness(new Date("2026-11-01T04:10:00Z"));
    h.add({ at: "01:30" });
    h.at(new Date("2026-11-01T05:29:00Z"));
    assert.equal(h.fired.length, 0);
    h.at(new Date("2026-11-01T05:31:00Z"));
    assert.equal(h.fired.length, 1);
    h.at(new Date("2026-11-01T06:10:00Z"));
    h.at(new Date("2026-11-01T06:31:00Z"));
    h.at(new Date("2026-11-01T08:00:00Z"));
    assert.equal(h.fired.length, 1);
    h.at(new Date("2026-11-02T06:31:00Z"));
    assert.equal(h.fired.length, 2);
  });

  it("a 02:30 daily schedule fires at the next valid minute on the spring-forward day", () => {
    const h = schedulerHarness(new Date("2026-03-08T05:00:00Z"));
    h.add({ at: "02:30" });
    h.at(new Date("2026-03-08T07:29:00Z"));
    assert.equal(h.fired.length, 0);
    h.at(new Date("2026-03-08T07:31:00Z"));
    assert.equal(h.fired.length, 1);
    h.at(new Date("2026-03-08T09:00:00Z"));
    assert.equal(h.fired.length, 1);
  });
});

describe("nextWake", () => {
  it("a daily schedule is today's time before it, tomorrow's after it", () => {
    const daily = schedule({ createdAt: local(10, 21, 7, 0).toISOString() });
    assert.equal(nextWake(daily, local(10, 21, 8, 0))?.toISOString(), local(10, 21, 9, 0).toISOString());
    assert.equal(nextWake(daily, local(10, 21, 10, 0))?.toISOString(), local(10, 22, 9, 0).toISOString());
  });

  it("a weekday schedule jumps over the weekend", () => {
    const weekdays = schedule({ kind: "weekdays" });
    assert.equal(nextWake(weekdays, local(10, 23, 10, 0))?.toISOString(), local(10, 26, 9, 0).toISOString());
    assert.equal(nextWake(weekdays, local(10, 24, 12, 0))?.toISOString(), local(10, 26, 9, 0).toISOString());
  });

  it("an interval schedule counts from its anchor: lastFiredAt, else createdAt", () => {
    const created = schedule({ kind: "interval", at: null, everyMinutes: 45, createdAt: local(10, 21, 10, 0).toISOString() });
    assert.equal(nextWake(created, local(10, 21, 10, 50))?.toISOString(), local(10, 21, 11, 30).toISOString());
    const fired = { ...created, lastFiredAt: local(10, 21, 10, 20).toISOString() };
    assert.equal(nextWake(fired, local(10, 21, 10, 30))?.toISOString(), local(10, 21, 11, 5).toISOString());
  });

  it("is null for a disabled schedule, and the agent's next wake is the earliest enabled one", () => {
    const now = local(10, 21, 8, 0);
    assert.equal(nextWake(schedule({ enabled: false }), now), null);
    const soon = schedule({ id: "s2", at: "08:30" });
    const off = schedule({ id: "s3", at: "08:10", enabled: false });
    assert.equal(earliestWake([schedule(), soon, off], now), local(10, 21, 8, 30).toISOString());
    assert.equal(earliestWake([off], now), null);
  });

  it("a 01:30 schedule on the fall-back day points at the first 01:30", () => {
    const daily = schedule({ at: "01:30", createdAt: new Date("2026-10-31T12:00:00Z").toISOString() });
    assert.equal(nextWake(daily, new Date("2026-11-01T04:30:00Z"))?.toISOString(), "2026-11-01T05:30:00.000Z");
  });
});
