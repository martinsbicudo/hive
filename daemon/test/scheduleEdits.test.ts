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

describe("editing a schedule", () => {
  it("editing the time or kind of a daily schedule never fires a slot that already passed today", async () => {
    const h = await harness(local(10, 21, 10, 0));
    try {
      const ana = h.agent({ name: "Ana" });
      const path = `/api/agents/${ana.id}/schedules`;
      const fired = () => h.hub.messages(ana.id, 50).filter((message) => message.text.startsWith("Scheduled wake")).length;
      const id = idOf((await h.api("POST", path, { kind: "daily", at: "18:00", prompt: "go" })).body, "id");
      await h.api("PATCH", `${path}/${id}`, { at: "07:00" });
      h.hub.checkSchedules();
      assert.equal(fired(), 0);
      assert.equal(h.store.schedules.get(id)?.lastFiredAt, local(10, 21, 10, 0).toISOString());
      await h.api("PATCH", `${path}/${id}`, { at: "17:00" });
      h.hub.checkSchedules();
      assert.equal(fired(), 0);
      h.c.set(local(10, 21, 17, 0));
      h.hub.checkSchedules();
      assert.equal(fired(), 1);
      const interval = idOf((await h.api("POST", path, { kind: "interval", everyMinutes: 60, prompt: "tick" })).body, "id");
      h.c.set(local(10, 21, 20, 0));
      await h.api("PATCH", `${path}/${interval}`, { kind: "weekdays", at: "06:00" });
      h.hub.checkSchedules();
      assert.equal(fired(), 1);
    } finally {
      await h.close();
    }
  });

  it("a daily schedule that already ran today doesn't run again after its time is moved later", async () => {
    const h = await harness(local(10, 21, 8, 0));
    try {
      const ana = h.agent({ name: "Ana" });
      const path = `/api/agents/${ana.id}/schedules`;
      const fired = () => h.hub.messages(ana.id, 50).filter((message) => message.text.startsWith("Scheduled wake")).length;
      const id = idOf((await h.api("POST", path, { kind: "daily", at: "09:00", prompt: "go" })).body, "id");
      h.c.set(local(10, 21, 9, 0));
      h.hub.checkSchedules();
      await until(() => fired() === 1, "wake 1");
      h.c.set(local(10, 21, 10, 0));
      await h.api("PATCH", `${path}/${id}`, { at: "17:00" });
      h.c.set(local(10, 21, 17, 1));
      h.hub.checkSchedules();
      h.c.set(local(10, 21, 17, 30));
      await h.api("PATCH", `${path}/${id}`, { at: "18:00" });
      h.c.set(local(10, 21, 18, 1));
      h.hub.checkSchedules();
      assert.equal(fired(), 1);
      h.c.set(local(10, 22, 18, 0));
      h.hub.checkSchedules();
      await until(() => fired() === 2, "wake 2");
    } finally {
      await h.close();
    }
  });

  it("switching only the kind never fires a slot that already passed today", async () => {
    const h = await harness(local(10, 23, 8, 0));
    try {
      const ana = h.agent({ name: "Ana" });
      const path = `/api/agents/${ana.id}/schedules`;
      const fired = () => h.hub.messages(ana.id, 50).filter((message) => message.text.startsWith("Scheduled wake")).length;
      const id = idOf((await h.api("POST", path, { kind: "weekdays", at: "09:00", prompt: "go" })).body, "id");
      h.c.set(local(10, 23, 9, 0));
      h.hub.checkSchedules();
      await until(() => fired() === 1, "wake 1");
      h.c.set(local(10, 24, 10, 0));
      await h.api("PATCH", `${path}/${id}`, { kind: "daily" });
      h.hub.checkSchedules();
      assert.equal(fired(), 1);
      h.c.set(local(10, 25, 9, 0));
      h.hub.checkSchedules();
      await until(() => fired() === 2, "wake 2");
    } finally {
      await h.close();
    }
  });
});
