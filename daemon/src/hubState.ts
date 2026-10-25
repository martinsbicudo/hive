import { SUGGESTED_NAMES, SUGGESTED_ROLES } from "./agents.ts";
import { AVATAR_STYLES } from "./avatars.ts";
import { budgetState } from "./budgets.ts";
import type { ComputerService } from "./computerService.ts";
import type { Store } from "./db.ts";
import { BINARIES } from "./engines.ts";
import { MODEL_CHOICES } from "./models.ts";
import type { Runner } from "./runner.ts";
import { earliestWake } from "./scheduler.ts";
import type { Agent, AgentStatus, Engine, HubOptions, HubState } from "./types.ts";
import { architectUsage, earliest, summarizeUsage, usageWindows } from "./usage.ts";

export interface StateSources {
  store: Store;
  runner: Pick<Runner, "activeRun" | "lastError" | "activeEngines" | "queued">;
  computers: Pick<ComputerService, "statusOf">;
}

function statusOf(lastError: string | null, running: boolean, waiting: boolean): AgentStatus {
  if (waiting) return "waiting-approval";
  if (running) return "working";
  return lastError ? "error" : "sleeping";
}

export function buildState({ store, runner, computers }: StateSources, now: Date): HubState {
  const pending = store.pendingApprovals();
  const waiting = new Set(pending.map((approval) => approval.agentId));
  const paused = store.settings.paused();
  const schedules = store.schedules.list();
  const agents = store.listAgents().map((agent): Agent => {
    const run = runner.activeRun(agent.id);
    const lastError = runner.lastError(agent.id);
    const own = schedules.filter((schedule) => schedule.agentId === agent.id);
    return {
      ...agent, status: statusOf(lastError, run !== null, waiting.has(agent.id)), activity: run?.activity ?? lastError,
      nextWake: paused ? null : earliestWake(own, now),
    };
  });
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const perEngine = new Map<Engine, number>();
  for (const agent of agents) perEngine.set(agent.engine, (perEngine.get(agent.engine) ?? 0) + 1);
  const windows = usageWindows(now);
  const runs = store.runsSince(earliest(windows));
  return {
    agents,
    computers: agents.filter((agent) => agent.computer === "virtual").map((agent) => {
      const resource = store.computers.forAgent(agent.id);
      return {
        agentId: agent.id, ...(resource ? computers.statusOf(resource.id) : { state: "stopped" as const }),
        ...(resource ? { computerId: resource.id, profile: resource.profile, hasScreen: resource.profile !== "terminal" } : {}),
      };
    }),
    approvals: pending.map((approval) => ({ ...approval, agentName: names.get(approval.agentId) ?? "Agent" })),
    usage: summarizeUsage(runs, perEngine, runner.activeEngines(), windows),
    architectUsage: architectUsage(runs, windows),
    activity: agents.flatMap((agent) => {
      const run = runner.activeRun(agent.id);
      if (!run) return [];
      const task = run.taskId === null ? null : store.tasks.getTask(run.taskId);
      return [{
        agentId: agent.id, name: agent.name, role: agent.role, detail: run.activity ?? "Working…", since: run.since, queued: runner.queued(agent.id),
        ...(task ? { taskId: task.id, taskTitle: task.title } : {}),
      }];
    }),
    paused,
    pausedAt: store.settings.pausedAt(),
    budgets: budgetState(store.settings.limits(), store.listAgents(), runs, windows),
  };
}

export function buildOptions(findEngine: (name: string) => string | null): HubOptions {
  const installed = (engine: Engine) => findEngine(BINARIES[engine]) !== null;
  return {
    names: SUGGESTED_NAMES, roles: SUGGESTED_ROLES, models: MODEL_CHOICES, avatarStyles: AVATAR_STYLES,
    engines: { "claude-code": installed("claude-code"), codex: installed("codex") },
  };
}
