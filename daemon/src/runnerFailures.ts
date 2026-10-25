import type { Store } from "./db.ts";
import { log } from "./log.ts";
import type { RunEntry, RunJobs } from "./runJobs.ts";
import type { ComputerRunBinding, RunTokens } from "./runTokens.ts";
import type { Run } from "./types.ts";

export interface RunnerFailureEvents {
  changed(): void;
  blockedReason(agentId: string): string | null;
  refused(agentId: string, reason: string): void;
  failed(agentId: string, taskId: string | null): void;
  releaseComputer(binding: ComputerRunBinding): void;
}

export interface AbandonedLaunch {
  run: Run;
  entry: RunEntry;
  token: string | null;
  binding: ComputerRunBinding | null;
}

function taskOf(entry: RunEntry): string | null {
  return entry.kind === "task" ? entry.taskId : null;
}

export class RunnerFailures {
  private readonly lastErrors = new Map<string, string>();
  private readonly jobs: RunJobs;
  private readonly events: RunnerFailureEvents;
  private readonly tokens: Pick<RunTokens, "revoke">;
  private readonly runs: Pick<Store, "finishRun">;

  constructor(jobs: RunJobs, events: RunnerFailureEvents, tokens: Pick<RunTokens, "revoke">, runs: Pick<Store, "finishRun">) {
    this.jobs = jobs;
    this.events = events;
    this.tokens = tokens;
    this.runs = runs;
  }

  lastError(agentId: string): string | null {
    return this.lastErrors.get(agentId) ?? null;
  }

  clear(agentId: string): void {
    this.lastErrors.delete(agentId);
  }

  blocked(agentId: string, entry: RunEntry): boolean {
    const reason = this.events.blockedReason(agentId);
    if (reason === null) return false;
    this.jobs.notice(agentId, entry, reason);
    this.events.refused(agentId, reason);
    this.events.changed();
    return true;
  }

  failAndNotify(agentId: string, entry: RunEntry, failure: string): void {
    this.fail(agentId, entry, failure);
    this.events.failed(agentId, taskOf(entry));
  }

  fail(agentId: string, entry: RunEntry, failure: string): void {
    this.lastErrors.set(agentId, failure);
    this.jobs.notice(agentId, entry, failure);
    this.events.changed();
  }

  abandonLaunch(launch: AbandonedLaunch, error: unknown): void {
    if (launch.token) this.tokens.revoke(launch.token);
    if (launch.binding) this.events.releaseComputer(launch.binding);
    const failure = `Hive couldn't start this run: ${error instanceof Error ? error.message : String(error)}`;
    try {
      this.runs.finishRun({ ...launch.run, endedAt: new Date().toISOString(), status: "failed", error: failure });
    } catch (finishing) {
      log(`run ${launch.run.id} couldn't be marked failed: ${String(finishing)}`);
    }
    this.failAndNotify(launch.run.agentId, launch.entry, failure);
  }
}
