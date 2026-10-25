import { z } from "zod";

export interface LoopLimits {
  maxHop: number;
  perAgentPerHour: number;
  totalPerHour: number;
}

export const DEFAULT_LIMITS: LoopLimits = { maxHop: 6, perAgentPerHour: 30, totalPerHour: 60 };

const HOUR_MS = 60 * 60 * 1000;

const limit = z.coerce.number().int().min(0).max(10_000);

export function limitsFromEnv(env: NodeJS.ProcessEnv): LoopLimits {
  const pick = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const parsed = limit.safeParse(raw);
    if (!parsed.success) throw new Error(`${name} must be a whole number from 0 to 10000`);
    return parsed.data;
  };
  return {
    maxHop: pick("HIVE_TASK_MAX_HOP", DEFAULT_LIMITS.maxHop),
    perAgentPerHour: pick("HIVE_AGENT_RUNS_PER_HOUR", DEFAULT_LIMITS.perAgentPerHour),
    totalPerHour: pick("HIVE_TOTAL_AGENT_RUNS_PER_HOUR", DEFAULT_LIMITS.totalPerHour),
  };
}

export class LoopGuard {
  private runs: { agentId: string; at: number }[] = [];
  private readonly limits: LoopLimits;
  private readonly now: () => number;

  constructor(limits: LoopLimits = DEFAULT_LIMITS, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  refusal(agentId: string, hop: number): string | null {
    if (hop > this.limits.maxHop) return `this chain of agent-to-agent runs reached the hop limit (${this.limits.maxHop})`;
    const recent = this.recent();
    if (recent.filter((run) => run.agentId === agentId).length >= this.limits.perAgentPerHour) {
      return `this agent already had ${this.limits.perAgentPerHour} runs started by other agents in the last hour`;
    }
    if (recent.length >= this.limits.totalPerHour) return `agents already started ${this.limits.totalPerHour} runs for each other in the last hour`;
    return null;
  }

  admit(agentId: string): void {
    this.runs = [...this.recent(), { agentId, at: this.now() }];
  }

  private recent(): { agentId: string; at: number }[] {
    const since = this.now() - HOUR_MS;
    return this.runs.filter((run) => run.at > since);
  }
}
