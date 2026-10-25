import type { ChildProcess } from "node:child_process";
import type { RunEntry, RunJob } from "./runJobs.ts";
import type { RunContext } from "./runTokens.ts";
import type { Run } from "./types.ts";

export interface ActiveRun {
  run: Run;
  child: ChildProcess;
  activity: string | null;
  since: string;
  sawResult: boolean;
  error: string | null;
  stopped: boolean;
  continueQueue: boolean;
  token: string | null;
  context: RunContext;
  job: RunJob;
  entry: RunEntry;
  sessionId: string | null;
  virtual: boolean;
  verified: boolean;
}

export class RunQueues {
  private readonly queues = new Map<string, RunEntry[]>();

  push(agentId: string, entry: RunEntry): void {
    this.queues.set(agentId, [...(this.queues.get(agentId) ?? []), entry]);
  }

  shift(agentId: string): RunEntry | undefined {
    return this.queues.get(agentId)?.shift();
  }

  size(agentId: string): number {
    return this.queues.get(agentId)?.length ?? 0;
  }

  agents(): string[] {
    return [...this.queues.keys()];
  }

  clear(agentId: string): void {
    this.queues.delete(agentId);
  }

  drop(agentId: string, drop: (entry: RunEntry) => boolean): RunEntry[] {
    const queue = this.queues.get(agentId) ?? [];
    this.queues.set(agentId, queue.filter((entry) => !drop(entry)));
    return queue.filter(drop);
  }
}
