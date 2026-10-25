import { log } from "./log.ts";
import type { ScheduleStore } from "./scheduleStore.ts";
import type { Schedule } from "./types.ts";

const LATE_LIMIT_MS = 2 * 60 * 60 * 1000;
const CHECK_MS = 30_000;
const MINUTE_MS = 60_000;
const LOOKBACK_DAYS = 8;

export interface Wake {
  schedule: Schedule;
  slot: string;
  fire: boolean;
}

function slotOn(day: Date, at: string): Date {
  const [hours, minutes] = at.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours ?? 0, minutes ?? 0);
}

function dayOffset(from: Date, days: number): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
}

function worksOn(schedule: Schedule, day: Date): boolean {
  return schedule.kind !== "weekdays" || (day.getDay() !== 0 && day.getDay() !== 6);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function anchorOf(schedule: Schedule): number {
  return Date.parse(schedule.lastFiredAt ?? schedule.createdAt);
}

function intervalMs(schedule: Schedule): number {
  return (schedule.everyMinutes ?? 0) * MINUTE_MS;
}

function currentSlot(schedule: Schedule, now: Date): Date | null {
  if (schedule.kind === "interval") {
    const every = intervalMs(schedule);
    const elapsed = Math.floor((now.getTime() - anchorOf(schedule)) / every);
    return every > 0 && elapsed >= 1 ? new Date(anchorOf(schedule) + elapsed * every) : null;
  }
  if (schedule.at === null) return null;
  for (let back = 0; back < LOOKBACK_DAYS; back++) {
    const day = dayOffset(now, -back);
    if (!worksOn(schedule, day)) continue;
    const slot = slotOn(day, schedule.at);
    if (slot.getTime() <= now.getTime()) return slot;
  }
  return null;
}

function consumed(schedule: Schedule, slot: Date): boolean {
  if (slot.getTime() <= anchorOf(schedule)) return true;
  return schedule.kind !== "interval" && schedule.lastRanAt !== null && sameDay(slot, new Date(schedule.lastRanAt));
}

export function dueWakes(schedules: readonly Schedule[], now: Date, paused: boolean): Wake[] {
  return schedules.flatMap((schedule): Wake[] => {
    const slot = currentSlot(schedule, now);
    if (slot === null || consumed(schedule, slot)) return [];
    const onTime = now.getTime() - slot.getTime() < LATE_LIMIT_MS;
    return [{ schedule, slot: slot.toISOString(), fire: schedule.enabled && !paused && onTime }];
  });
}

export function nextWake(schedule: Schedule, now: Date): Date | null {
  if (!schedule.enabled) return null;
  if (schedule.kind === "interval") {
    const every = intervalMs(schedule);
    if (every <= 0) return null;
    const elapsed = Math.max(0, Math.floor((now.getTime() - anchorOf(schedule)) / every));
    return new Date(anchorOf(schedule) + (elapsed + 1) * every);
  }
  if (schedule.at === null) return null;
  for (let ahead = 0; ahead < LOOKBACK_DAYS; ahead++) {
    const day = dayOffset(now, ahead);
    if (!worksOn(schedule, day)) continue;
    const slot = slotOn(day, schedule.at);
    if (slot.getTime() > now.getTime() && !consumed(schedule, slot)) return slot;
  }
  return null;
}

export function earliestWake(schedules: readonly Schedule[], now: Date): string | null {
  const times = schedules.flatMap((schedule) => nextWake(schedule, now) ?? []);
  const first = times.reduce<Date | null>((best, time) => (best === null || time < best ? time : best), null);
  return first?.toISOString() ?? null;
}

export interface SchedulerDeps {
  schedules: ScheduleStore;
  clock: () => Date;
  paused: () => boolean;
  wake: (schedule: Schedule) => void;
  changed: () => void;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly checkMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: SchedulerDeps, checkMs: number = CHECK_MS) {
    this.deps = deps;
    this.checkMs = checkMs;
  }

  start(): void {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), this.checkMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  check(): void {
    this.apply(dueWakes(this.deps.schedules.list(), this.deps.clock(), this.deps.paused()));
  }

  consumeAll(): void {
    this.apply(dueWakes(this.deps.schedules.list(), this.deps.clock(), true));
  }

  private apply(wakes: readonly Wake[]): void {
    for (const { schedule, slot, fire } of wakes) {
      this.deps.schedules.update(schedule.id, fire && schedule.kind !== "interval" ? { lastFiredAt: slot, lastRanAt: slot } : { lastFiredAt: slot });
      if (!fire) continue;
      try {
        this.deps.wake(schedule);
      } catch (error) {
        log(`scheduled wake for ${schedule.agentId} failed: ${String(error)}`);
      }
    }
    if (wakes.length > 0) this.deps.changed();
  }
}
