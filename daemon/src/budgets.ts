import { z } from "zod";
import type { AgentBudget, BudgetLimits, Budgets, Run, StoredAgent } from "./types.ts";
import type { UsageWindows } from "./usage.ts";

const MAX_LIMIT = 1_000_000_000_000;
const limit = z.number().int().min(0).max(MAX_LIMIT).nullable();

export const budgetInput = z
  .object({ globalDailyUsdCents: limit.optional(), globalDailyTokens: limit.optional(), globalMonthlyUsdCents: limit.optional() })
  .strict();

export const dailyBudgetInput = z.number().int().min(0).max(MAX_LIMIT).nullable();

export interface Spend {
  usd: number;
  tokens: number;
}

export function spendSince(runs: readonly Run[], from: string, agentId?: string): Spend {
  const spend: Spend = { usd: 0, tokens: 0 };
  for (const run of runs) {
    if (run.startedAt < from || (agentId !== undefined && run.agentId !== agentId)) continue;
    spend.usd += run.costUsd;
    spend.tokens += run.inputTokens + run.outputTokens;
  }
  return spend;
}

export function unitOf(agent: Pick<StoredAgent, "engine">): AgentBudget["unit"] {
  return agent.engine === "codex" ? "tokens" : "usd-cents";
}

export function budgetState(limits: BudgetLimits, agents: readonly StoredAgent[], runs: readonly Run[], windows: UsageWindows): Budgets {
  const today = spendSince(runs, windows.todayStart);
  return {
    limits,
    spent: { todayUsd: today.usd, todayTokens: today.tokens, monthUsd: spendSince(runs, windows.monthStart).usd },
    agents: agents.map((agent) => {
      const own = spendSince(runs, windows.todayStart, agent.id);
      const unit = unitOf(agent);
      return { agentId: agent.id, unit, limit: agent.dailyBudget, spent: unit === "tokens" ? own.tokens : own.usd * 100 };
    }),
  };
}

export const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
export const tokens = (count: number): string => `${count.toLocaleString("en-US")} tokens`;

export function agentExceeded(agent: StoredAgent, runs: readonly Run[], windows: UsageWindows): string | null {
  if (agent.dailyBudget === null) return null;
  const own = spendSince(runs, windows.todayStart, agent.id);
  const codex = unitOf(agent) === "tokens";
  if ((codex ? own.tokens : own.usd * 100) < agent.dailyBudget) return null;
  return `${agent.name} reached its daily budget of ${codex ? tokens(agent.dailyBudget) : dollars(agent.dailyBudget)}. It can run again tomorrow.`;
}

export function globalExceeded(limits: BudgetLimits, runs: readonly Run[], windows: UsageWindows): string | null {
  const today = spendSince(runs, windows.todayStart);
  if (limits.globalDailyUsdCents !== null && today.usd * 100 >= limits.globalDailyUsdCents) {
    return `Hive reached its daily budget of ${dollars(limits.globalDailyUsdCents)}. Runs resume tomorrow.`;
  }
  if (limits.globalDailyTokens !== null && today.tokens >= limits.globalDailyTokens) {
    return `Hive reached its daily limit of ${tokens(limits.globalDailyTokens)}. Runs resume tomorrow.`;
  }
  const month = spendSince(runs, windows.monthStart);
  if (limits.globalMonthlyUsdCents !== null && month.usd * 100 >= limits.globalMonthlyUsdCents) {
    return `Hive reached its monthly budget of ${dollars(limits.globalMonthlyUsdCents)}. Runs resume next month.`;
  }
  return null;
}

export function exceeded(agent: StoredAgent, limits: BudgetLimits, runs: readonly Run[], windows: UsageWindows): string | null {
  return agentExceeded(agent, runs, windows) ?? globalExceeded(limits, runs, windows);
}
