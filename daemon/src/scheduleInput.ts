import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "./httpError.ts";
import type { SchedulePatch } from "./scheduleStore.ts";
import { parseOr400 } from "./taskCore.ts";
import { SCHEDULE_KINDS, type Schedule, type ScheduleKind } from "./types.ts";

const kind = z.enum(SCHEDULE_KINDS);
const at = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24 hours").nullable();
const everyMinutes = z.number().int().min(15).max(1440).nullable();
const prompt = z.string().trim().min(1).max(4000);

export const createInput = z.object({ kind, at: at.optional(), everyMinutes: everyMinutes.optional(), prompt, enabled: z.boolean().optional() }).strict();
const patchInput = z
  .object({ kind: kind.optional(), at: at.optional(), everyMinutes: everyMinutes.optional(), prompt: prompt.optional(), enabled: z.boolean().optional() })
  .strict();

const usesTime = (scheduleKind: ScheduleKind): boolean => scheduleKind !== "interval";

export function checkShape(scheduleKind: ScheduleKind, time: string | null, every: number | null): void {
  if (usesTime(scheduleKind) && (time === null || every !== null)) throw new HttpError(400, `${scheduleKind}: give at (HH:MM) and no everyMinutes`);
  if (!usesTime(scheduleKind) && (every === null || time !== null)) throw new HttpError(400, "interval: give everyMinutes (15 to 1440) and no at");
}

export function buildSchedule(raw: unknown, agentId: string, now: string): Schedule {
  const input = parseOr400(createInput, raw);
  const time = input.at ?? null;
  const every = input.everyMinutes ?? null;
  checkShape(input.kind, time, every);
  return {
    id: randomUUID(), agentId, kind: input.kind, at: time, everyMinutes: every, prompt: input.prompt,
    enabled: input.enabled ?? true, lastFiredAt: null, lastRanAt: null, createdAt: now,
  };
}

function timeAnchor(time: string, now: string): string {
  const moment = new Date(now);
  const slot = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate(), Number(time.slice(0, 2)), Number(time.slice(3)));
  const startOfDay = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate());
  return slot.getTime() <= moment.getTime() ? now : new Date(startOfDay.getTime() - 1).toISOString();
}

function anchorReset(next: ScheduleKind, time: string | null, every: number | null, current: Schedule, now: string): { lastFiredAt?: string } {
  if (next === "interval") return every !== current.everyMinutes ? { lastFiredAt: now } : {};
  return time !== null && (time !== current.at || next !== current.kind) ? { lastFiredAt: timeAnchor(time, now) } : {};
}

export function buildPatch(raw: unknown, current: Schedule, now: string): SchedulePatch {
  const input = parseOr400(patchInput, raw);
  const next = input.kind ?? current.kind;
  const switched = usesTime(next) !== usesTime(current.kind);
  const time = input.at !== undefined ? input.at : switched ? null : current.at;
  const every = input.everyMinutes !== undefined ? input.everyMinutes : switched ? null : current.everyMinutes;
  checkShape(next, time, every);
  return {
    kind: next, at: time, everyMinutes: every, prompt: input.prompt, enabled: input.enabled,
    ...anchorReset(next, time, every, current, now),
  };
}
