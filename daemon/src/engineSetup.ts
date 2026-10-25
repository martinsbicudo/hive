import { join } from "node:path";
import type { ProviderId } from "./engineSocket.ts";
import { cleanupLeftovers } from "./engineSetupCleanup.ts";
import { checkInstalled, installFlow, launchAndWait, prepare, type FlowContext, type SetupEffects } from "./engineSetupFlow.ts";
import { cleanDetail, pinFor, SetupCancelled, SetupError, SetupRefused, type SetupPin } from "./engineSetupPins.ts";
import { overallProgress, providerStatuses, setupStatusSchema, type SetupAction, type SetupProviderStatus, type SetupStatus, type SetupStep } from "./engineSetupStatus.ts";
import { missing } from "./engineVerify.ts";

export type { SetupEffects } from "./engineSetupFlow.ts";

type Progress = Omit<SetupStatus, "providers">;

const IDLE: Progress = { state: "idle", provider: null, action: null, step: null, progress: 0, detail: "", cancellable: false };
const PROVIDER_CACHE_MS = 3000;

interface Run {
  controller: AbortController;
  done: Promise<void>;
  installed: boolean;
  cancelWhenPossible: boolean;
}

/** One guided engine setup at a time; its state lives in memory, so it outlives the board but not the daemon. */
export class EngineSetup {
  private readonly effects: SetupEffects;
  private current: Progress = IDLE;
  private run: Run | null = null;
  private providers: SetupProviderStatus[] | null = null;
  private checking: Promise<SetupProviderStatus[]> | null = null;
  private checkedAt = Number.NEGATIVE_INFINITY;
  private generation = 0;

  constructor(effects: SetupEffects) {
    this.effects = effects;
  }

  async status(): Promise<SetupStatus> {
    return setupStatusSchema.parse({ ...this.current, providers: await this.providerList() });
  }

  // A check waits on an engine that is still starting (up to its timeout), so once the engines are known the answer
  // never waits for a new check: a setup's progress and its start reply stay immediate.
  private providerList(): Promise<SetupProviderStatus[]> {
    const now = this.effects.now();
    if (!this.checking && now - this.checkedAt > PROVIDER_CACHE_MS) {
      const generation = this.generation;
      this.checkedAt = now;
      const check = providerStatuses(this.effects.engines, this.effects.applicationsDir).then((list) => {
        if (generation === this.generation) this.providers = list;
        return list;
      });
      this.checking = check;
      void check.catch((error: unknown) => this.effects.log(`engine check failed: ${String(error)}`)).finally(() => {
        if (this.checking === check) this.checking = null;
      });
    }
    if (this.providers) return Promise.resolve(this.providers);
    return this.checking ?? providerStatuses(this.effects.engines, this.effects.applicationsDir);
  }

  /** The next answer waits for a fresh check, so a finished setup never shows the engines as they were before it. */
  private forgetProviders(): void {
    this.generation += 1;
    this.providers = null;
    this.checking = null;
    this.checkedAt = Number.NEGATIVE_INFINITY;
  }

  /** Begins installing (the app is absent) or starting (it is present); refused while anything else could clash. */
  async start(provider: ProviderId): Promise<SetupStatus> {
    if (this.current.state === "running") throw new SetupRefused("A setup is already running. Wait for it to finish, or cancel it.");
    if (this.effects.paused()) throw new SetupRefused("Hive is paused. Resume it before setting up an engine.");
    if (this.effects.anyActive()) throw new SetupRefused("A computer is starting or running. Stop your computers before setting up an engine.");
    const pin = pinFor(provider);
    const app = join(this.effects.applicationsDir, pin.appName);
    const action: SetupAction = missing(app) ? "install" : "start";
    const controller = new AbortController();
    const run: Run = { controller, done: Promise.resolve(), installed: false, cancelWhenPossible: false };
    this.run = run;
    this.current = { state: "running", provider, action, step: "check", progress: 0, detail: "Starting.", cancellable: true };
    this.effects.log(`engine setup: ${action} ${provider} started`);
    run.done = this.execute(run, pin, action, app);
    return this.status();
  }

  /** Cancels a running setup and waits for its cleanup; refused while the app is being moved into Applications. */
  async cancel(): Promise<SetupStatus> {
    const run = this.run;
    if (!run || this.current.state !== "running") return this.status();
    if (!this.current.cancellable) throw new SetupRefused("The engine is being moved into Applications right now; this step can't be cancelled. It takes a few seconds.");
    run.controller.abort();
    await run.done;
    return this.status();
  }

  /** Pause cancels the setup, at once or as soon as the move into Applications has finished. */
  cancelForPause(): void {
    const run = this.run;
    if (!run || this.current.state !== "running") return;
    if (this.current.cancellable) run.controller.abort();
    else run.cancelWhenPossible = true;
  }

  settled(): Promise<void> {
    return this.run?.done ?? Promise.resolve();
  }

  cleanup(): Promise<void> {
    return cleanupLeftovers({ run: this.effects.run, cacheRoot: this.effects.cacheRoot, applicationsDir: this.effects.applicationsDir, tag: this.effects.tag, log: this.effects.log });
  }

  private context(run: Run, pin: SetupPin, action: SetupAction): FlowContext {
    return {
      effects: this.effects,
      pin,
      signal: run.controller.signal,
      report: (step, fraction, detail) => this.report(run, action, step, fraction, detail),
      cancellable: (value) => this.setCancellable(run, value),
    };
  }

  private async execute(run: Run, pin: SetupPin, action: SetupAction, app: string): Promise<void> {
    const context = this.context(run, pin, action);
    try {
      if (action === "install") {
        await installFlow(context);
        run.installed = true;
        this.setCancellable(run, true);
      } else {
        await checkInstalled(context, app);
      }
      if (run.controller.signal.aborted) throw new SetupCancelled("cancelled");
      const started = await launchAndWait(context, app);
      if (started.kind === "other") return this.finish(run, "done", started.detail);
      await prepare(context, started.engine);
      if (run.controller.signal.aborted) throw new SetupCancelled("cancelled");
      this.effects.engines.refresh();
      this.finish(run, "done", `${pin.spec.name} is ready, and Hive's images are prepared.`);
    } catch (error) {
      this.fail(run, pin, error);
    }
  }

  private fail(run: Run, pin: SetupPin, error: unknown): void {
    if (run.controller.signal.aborted || error instanceof SetupCancelled) {
      const kept = run.installed ? `${pin.appName} stays installed in Applications.` : "Nothing was installed.";
      return this.finish(run, "cancelled", `Setup cancelled. ${kept}`);
    }
    if (error instanceof SetupError) return this.finish(run, "failed", error.message);
    const message = error instanceof Error ? error.message : String(error);
    this.finish(run, "failed", `Setup stopped: ${message}`);
  }

  private finish(run: Run, state: "done" | "failed" | "cancelled", detail: string): void {
    if (this.run !== run) return;
    const step: SetupStep | null = state === "done" ? "ready" : this.current.step;
    const progress = state === "done" ? 1 : this.current.progress;
    this.current = { ...this.current, state, step, progress, detail: cleanDetail(detail), cancellable: false };
    this.forgetProviders();
    this.effects.log(`engine setup: ${this.current.action ?? "setup"} ${this.current.provider ?? ""} ${state}: ${this.current.detail}`);
  }

  private report(run: Run, action: SetupAction, step: SetupStep, fraction: number, detail: string): void {
    if (this.run !== run || this.current.state !== "running") return;
    const progress = Math.max(this.current.progress, overallProgress(action, step, fraction));
    this.current = { ...this.current, step, progress, detail: cleanDetail(detail) };
  }

  private setCancellable(run: Run, value: boolean): void {
    if (this.run !== run || this.current.state !== "running") return;
    this.current = { ...this.current, cancellable: value };
    if (value && run.cancelWhenPossible) run.controller.abort();
  }
}
