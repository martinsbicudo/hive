import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import type { DockerRunner } from "../src/docker.ts";
import type { Hub } from "../src/hub.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { Engine, HubEvent, Schedule } from "../src/types.ts";
import { fakeDocker, tempDir } from "./fixtures.ts";

export function local(month: number, day: number, hours = 0, minutes = 0, seconds = 0): Date {
  return new Date(2026, month - 1, day, hours, minutes, seconds);
}

export function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1", agentId: "a1", kind: "daily", at: "09:00", everyMinutes: null, prompt: "check the inbox", enabled: true,
    lastFiredAt: null, lastRanAt: null, createdAt: local(10, 21, 8, 0).toISOString(), ...overrides,
  };
}

export function schedulerHarness(start: Date) {
  const store = new Store(":memory:");
  const state = { now: start, paused: false };
  const fired: Schedule[] = [];
  const scheduler = new Scheduler({
    schedules: store.schedules, clock: () => state.now, paused: () => state.paused, wake: (due) => fired.push(due), changed: () => undefined,
  });
  return {
    store, scheduler, fired, state,
    add: (overrides: Partial<Schedule> = {}) => {
      const created = schedule({ createdAt: state.now.toISOString(), ...overrides });
      store.schedules.insert(created);
      return created;
    },
    at: (now: Date) => {
      state.now = now;
      scheduler.check();
    },
    lastFired: (id = "s1") => store.schedules.get(id)?.lastFiredAt ?? null,
  };
}

export function addRun(store: Store, agentId: string, engine: Engine, usage: { costUsd?: number; tokens?: number; startedAt: Date }): void {
  const id = crypto.randomUUID();
  const startedAt = usage.startedAt.toISOString();
  store.insertRun({ id, agentId, engine, model: "default", startedAt, endedAt: null, status: "running", costUsd: 0, inputTokens: 0, outputTokens: 0, error: null });
  store.finishRun({
    id, agentId, engine, model: "default", startedAt, endedAt: startedAt, status: "done", costUsd: usage.costUsd ?? 0,
    inputTokens: usage.tokens ?? 0, outputTokens: 0, error: null,
  });
}

export function notifications(hub: Hub): Extract<HubEvent, { type: "notify" }>[] {
  const seen: Extract<HubEvent, { type: "notify" }>[] = [];
  hub.subscribe((event) => {
    if (event.type === "notify") seen.push(event);
  });
  return seen;
}

export function clock(start: Date) {
  const state = { now: start.getTime() };
  return { now: () => state.now, set: (date: Date) => void (state.now = date.getTime()) };
}

export function stallingDocker() {
  const base = fakeDocker();
  const state = { armed: false };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner: DockerRunner = async (args, options) => {
    if (state.armed && args[0] === "network" && args[1] === "create") await gate;
    return base.runner(args, options);
  };
  return { calls: base.calls, runner, arm: () => void (state.armed = true), release: () => release() };
}

export function failingEngine(): string {
  const path = join(tempDir("hive-failing-engine-"), "claude");
  writeFileSync(path, "#!/bin/sh\necho 'secret boom detail' >&2\nexit 3\n");
  chmodSync(path, 0o755);
  return path;
}
