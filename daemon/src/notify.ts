import type { HubEvent } from "./types.ts";

function dayKey(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

export class Notifier {
  private readonly emit: (event: HubEvent) => void;
  private readonly clock: () => Date;
  private readonly seen = new Set<string>();
  private seenDay = "";

  constructor(emit: (event: HubEvent) => void, clock: () => Date) {
    this.emit = emit;
    this.clock = clock;
  }

  approval(agentName: string, agentId: string, taskId: string | null): void {
    this.emit({ type: "notify", kind: "approval", text: `${agentName} is waiting for your approval.`, agentId, ...(taskId ? { taskId } : {}) });
  }

  budget(agentId: string, reason: string): void {
    const today = dayKey(this.clock());
    if (today !== this.seenDay) this.seen.clear();
    this.seenDay = today;
    const key = `${agentId}|${reason}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.emit({ type: "notify", kind: "budget", text: reason, agentId });
  }

  failed(agentName: string, agentId: string, taskId: string | null): void {
    this.emit({ type: "notify", kind: "failed", text: `${agentName}'s run failed.`, agentId, ...(taskId ? { taskId } : {}) });
  }

  paused(): void {
    this.emit({ type: "notify", kind: "paused", text: "Hive is paused. Every run was stopped." });
  }
}
