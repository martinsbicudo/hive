import type { AgentBudget } from "./api.ts";

export type LimitUnit = "usd" | "tokens";

export function limitToText(limit: number | null, unit: LimitUnit): string {
  if (limit === null) return "";
  return unit === "usd" ? String(limit / 100) : String(limit);
}

export function textToLimit(text: string, unit: LimitUnit): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return "invalid";
  const scaled = unit === "usd" ? Math.round(value * 100) : value;
  return Number.isInteger(scaled) ? scaled : "invalid";
}

export function agentUnit(unit: AgentBudget["unit"]): LimitUnit {
  return unit === "tokens" ? "tokens" : "usd";
}

export function ratio(spent: number, limit: number | null): number | null {
  if (limit === null) return null;
  return limit === 0 ? 1 : Math.min(1, spent / limit);
}
