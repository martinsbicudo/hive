import type { DatabaseSync } from "node:sqlite";
import { flag, oneOf, optionalNumber, optionalText, text, type Row } from "./sqlRows.ts";
import { SCHEDULE_KINDS, type Schedule } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, every_minutes INTEGER, prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, last_fired_at TEXT, created_at TEXT NOT NULL, last_ran_at TEXT
);
CREATE INDEX IF NOT EXISTS schedules_agent ON schedules(agent_id);
`;

export type SchedulePatch = Partial<Pick<Schedule, "kind" | "at" | "everyMinutes" | "prompt" | "enabled" | "lastFiredAt" | "lastRanAt">>;

export class ScheduleStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    const columns = this.db.prepare("PRAGMA table_info(schedules)").all().map((row) => text(row, "name"));
    if (!columns.includes("last_ran_at")) this.db.exec("ALTER TABLE schedules ADD COLUMN last_ran_at TEXT");
  }

  insert(schedule: Schedule): void {
    this.db
      .prepare("INSERT INTO schedules (id, agent_id, kind, at, every_minutes, prompt, enabled, last_fired_at, created_at, last_ran_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(schedule.id, schedule.agentId, schedule.kind, schedule.at, schedule.everyMinutes, schedule.prompt, schedule.enabled ? 1 : 0, schedule.lastFiredAt, schedule.createdAt, schedule.lastRanAt);
  }

  list(): Schedule[] {
    return this.db.prepare("SELECT * FROM schedules ORDER BY created_at, id").all().map(toSchedule);
  }

  listFor(agentId: string): Schedule[] {
    return this.db.prepare("SELECT * FROM schedules WHERE agent_id = ? ORDER BY created_at, id").all(agentId).map(toSchedule);
  }

  get(id: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id);
    return row ? toSchedule(row) : null;
  }

  update(id: string, patch: SchedulePatch): void {
    const columns: [string, string | number | null][] = [];
    if (patch.kind !== undefined) columns.push(["kind", patch.kind]);
    if (patch.at !== undefined) columns.push(["at", patch.at]);
    if (patch.everyMinutes !== undefined) columns.push(["every_minutes", patch.everyMinutes]);
    if (patch.prompt !== undefined) columns.push(["prompt", patch.prompt]);
    if (patch.enabled !== undefined) columns.push(["enabled", patch.enabled ? 1 : 0]);
    if (patch.lastFiredAt !== undefined) columns.push(["last_fired_at", patch.lastFiredAt]);
    if (patch.lastRanAt !== undefined) columns.push(["last_ran_at", patch.lastRanAt]);
    if (columns.length === 0) return;
    const assignments = columns.map(([column]) => `${column} = ?`).join(", ");
    this.db.prepare(`UPDATE schedules SET ${assignments} WHERE id = ?`).run(...columns.map(([, value]) => value), id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  forgetAgent(agentId: string): void {
    this.db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(agentId);
  }
}

function toSchedule(row: Row): Schedule {
  return {
    id: text(row, "id"),
    agentId: text(row, "agent_id"),
    kind: oneOf(text(row, "kind"), SCHEDULE_KINDS, "daily"),
    at: optionalText(row, "at"),
    everyMinutes: optionalNumber(row, "every_minutes"),
    prompt: text(row, "prompt"),
    enabled: flag(row, "enabled"),
    lastFiredAt: optionalText(row, "last_fired_at"),
    lastRanAt: optionalText(row, "last_ran_at"),
    createdAt: text(row, "created_at"),
  };
}
