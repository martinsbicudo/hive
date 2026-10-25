import type { Approvals } from "./approvals.ts";
import type { Architect } from "./architect.ts";
import { budgetInput, budgetState } from "./budgets.ts";
import type { ComputerService } from "./computerService.ts";
import type { Store } from "./db.ts";
import type { EngineSetup } from "./engineSetup.ts";
import type { Notifier } from "./notify.ts";
import { PAUSED_MESSAGE } from "./runGate.ts";
import type { Runner } from "./runner.ts";
import type { Scheduler } from "./scheduler.ts";
import { parseOr400 } from "./taskCore.ts";
import type { Budgets } from "./types.ts";
import { usageWindows } from "./usage.ts";

export interface ControlDeps {
  store: Store;
  runner: Pick<Runner, "stopAll">;
  architect: Pick<Architect, "stop">;
  approvals: Approvals;
  computers: Pick<ComputerService, "stop">;
  leases: { cancelAll(): void };
  scheduler: Scheduler;
  notifier: Notifier;
  clock: () => Date;
  changed: () => void;
  setup: Pick<EngineSetup, "cancelForPause">;
}

export class Control {
  private readonly deps: ControlDeps;

  constructor(deps: ControlDeps) {
    this.deps = deps;
  }

  pause(): Promise<void> {
    const { store, runner, approvals, notifier, clock, changed } = this.deps;
    const wasPaused = store.settings.paused();
    store.settings.setPaused(true, clock().toISOString());
    this.deps.leases.cancelAll();
    runner.stopAll();
    this.deps.architect.stop(PAUSED_MESSAGE);
    approvals.denyPending();
    this.deps.setup.cancelForPause();
    if (!wasPaused) notifier.paused();
    changed();
    return Promise.all(store.computers.resources().map((computer) => this.deps.computers.stop(computer.id))).then(() => undefined);
  }

  resume(): void {
    this.deps.scheduler.consumeAll();
    this.deps.store.settings.setPaused(false, this.deps.clock().toISOString());
    this.deps.changed();
  }

  budgets(): Budgets {
    const { store, clock } = this.deps;
    const windows = usageWindows(clock());
    return budgetState(store.settings.limits(), store.listAgents(), store.runsSince(windows.monthStart), windows);
  }

  setBudgets(raw: unknown): Budgets {
    const input = parseOr400(budgetInput, raw);
    const current = this.deps.store.settings.limits();
    this.deps.store.settings.setLimits({
      globalDailyUsdCents: input.globalDailyUsdCents === undefined ? current.globalDailyUsdCents : input.globalDailyUsdCents,
      globalDailyTokens: input.globalDailyTokens === undefined ? current.globalDailyTokens : input.globalDailyTokens,
      globalMonthlyUsdCents: input.globalMonthlyUsdCents === undefined ? current.globalMonthlyUsdCents : input.globalMonthlyUsdCents,
    });
    this.deps.changed();
    return this.budgets();
  }
}
