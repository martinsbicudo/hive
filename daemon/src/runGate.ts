import { exceeded, globalExceeded } from "./budgets.ts";
import type { Store } from "./db.ts";
import { usageWindows } from "./usage.ts";

export const PAUSED_MESSAGE = "Hive is paused.";

export class RunGate {
  private readonly store: Store;
  private readonly clock: () => Date;

  constructor(store: Store, clock: () => Date) {
    this.store = store;
    this.clock = clock;
  }

  blockedReason(agentId: string, now: Date = this.clock()): string | null {
    if (this.store.settings.paused()) return PAUSED_MESSAGE;
    const agent = this.store.getAgent(agentId);
    if (!agent) return null;
    const limits = this.store.settings.limits();
    if (agent.dailyBudget === null && Object.values(limits).every((value) => value === null)) return null;
    const windows = usageWindows(now);
    return exceeded(agent, limits, this.store.runsSince(windows.monthStart), windows);
  }

  globalBlockedReason(now: Date = this.clock()): string | null {
    if (this.store.settings.paused()) return PAUSED_MESSAGE;
    const limits = this.store.settings.limits();
    if (Object.values(limits).every((value) => value === null)) return null;
    const windows = usageWindows(now);
    return globalExceeded(limits, this.store.runsSince(windows.monthStart), windows);
  }
}
