import type { DatabaseSync } from "node:sqlite";
import { optionalText } from "./sqlRows.ts";
import type { BudgetLimits } from "./types.ts";

const SCHEMA = "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);";

const LIMIT_KEYS = ["globalDailyUsdCents", "globalDailyTokens", "globalMonthlyUsdCents"] as const;

export class SettingsStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  paused(): boolean {
    return this.read("paused") === true;
  }

  pausedAt(): string | null {
    const at = this.read("pausedAt");
    return this.paused() && typeof at === "string" ? at : null;
  }

  setPaused(paused: boolean, now: string): void {
    this.write("paused", paused);
    if (paused) this.write("pausedAt", now);
    else this.remove("pausedAt");
  }

  limits(): BudgetLimits {
    return {
      globalDailyUsdCents: this.limit("globalDailyUsdCents"),
      globalDailyTokens: this.limit("globalDailyTokens"),
      globalMonthlyUsdCents: this.limit("globalMonthlyUsdCents"),
    };
  }

  setLimits(limits: BudgetLimits): void {
    for (const key of LIMIT_KEYS) this.write(key, limits[key]);
  }

  private limit(key: (typeof LIMIT_KEYS)[number]): number | null {
    const value = this.read(key);
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
  }

  private read(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    const raw = row ? optionalText(row, "value") : null;
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private write(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  private remove(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
