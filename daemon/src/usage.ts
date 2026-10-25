import { ARCHITECT_ID, ENGINES, type ArchitectUsage, type Engine, type EngineUsage, type Run } from "./types.ts";

export interface UsageWindows {
  todayStart: string;
  weekStart: string;
  monthStart: string;
}

export function usageWindows(now: Date): UsageWindows {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(today);
  week.setDate(week.getDate() - 6);
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  return { todayStart: today.toISOString(), weekStart: week.toISOString(), monthStart: month.toISOString() };
}

export function earliest(windows: UsageWindows): string {
  return windows.weekStart < windows.monthStart ? windows.weekStart : windows.monthStart;
}

export function summarizeUsage(
  runs: readonly Run[],
  agentsPerEngine: ReadonlyMap<Engine, number>,
  activeRunsPerEngine: ReadonlyMap<Engine, number>,
  windows: UsageWindows,
): EngineUsage[] {
  return ENGINES.filter((engine) => (agentsPerEngine.get(engine) ?? 0) > 0).map((engine) => {
    const own = runs.filter((run) => run.engine === engine && run.agentId !== ARCHITECT_ID);
    const sum = (from: string) => own.filter((run) => run.startedAt >= from).reduce((total, run) => total + run.costUsd, 0);
    return {
      engine,
      agents: agentsPerEngine.get(engine) ?? 0,
      activeRuns: activeRunsPerEngine.get(engine) ?? 0,
      todayUsd: sum(windows.todayStart),
      weekUsd: sum(windows.weekStart),
      monthUsd: sum(windows.monthStart),
      todayTokens: own
        .filter((run) => run.startedAt >= windows.todayStart)
        .reduce((total, run) => total + run.inputTokens + run.outputTokens, 0),
    };
  });
}

export function architectUsage(runs: readonly Run[], windows: UsageWindows): ArchitectUsage | null {
  const own = runs.filter((run) => run.agentId === ARCHITECT_ID);
  const sum = (from: string) => own.filter((run) => run.startedAt >= from).reduce((total, run) => total + run.costUsd, 0);
  const usage = { todayUsd: sum(windows.todayStart), weekUsd: sum(windows.weekStart), monthUsd: sum(windows.monthStart) };
  return Object.values(usage).some((value) => value > 0) ? usage : null;
}
