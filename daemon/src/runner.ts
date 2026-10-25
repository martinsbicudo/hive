import { randomUUID } from "node:crypto";
import type { Store } from "./db.ts";
import { BINARIES, claudeArguments, codexArguments, codexPrompt } from "./engines.ts";
import { log, oneLine } from "./log.ts";
import { findBinary } from "./process.ts";
import type { RunEntry, RunJobs } from "./runJobs.ts";
import type { McpLaunch, StoredAgent } from "./runPlan.ts";
import { handleEvent, spawnEngine, terminate, type EventSink } from "./runProcess.ts";
import { RunQueues, type ActiveRun } from "./runState.ts";
import { RunnerIdle } from "./runnerIdle.ts";
import { USER_TRIGGER, type ComputerRunBinding, type RunContext, type RunTokens } from "./runTokens.ts";
import { prepareRun } from "./runnerPrepare.ts";
import { RunnerFailures } from "./runnerFailures.ts";
import type { Engine, Run } from "./types.ts";

const MISSING_SESSION = /no conversation found|session .* not found|thread .* not found/i;

export interface RunnerEvents {
  changed(): void;
  delta(agentId: string, text: string): void;
  prepareComputer(agentId: string): Promise<ComputerRunBinding>;
  releaseComputer(binding: ComputerRunBinding): void;
  blockedReason(agentId: string): string | null;
  refused(agentId: string, reason: string): void;
  failed(agentId: string, taskId: string | null): void;
}

export type { McpLaunch } from "./runPlan.ts";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Runner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly queues = new RunQueues();
  private readonly failures: RunnerFailures;
  private readonly preparing = new Map<string, { since: string; entry: RunEntry }>();
  private readonly idle = new RunnerIdle();

  private readonly store: Store;
  private readonly mcp: McpLaunch;
  private readonly events: RunnerEvents;
  private readonly jobs: RunJobs;
  private readonly tokens: RunTokens;
  private readonly findEngine: (name: string) => string | null;
  private readonly sink: EventSink;

  constructor(store: Store, mcp: McpLaunch, tokens: RunTokens, events: RunnerEvents, jobs: RunJobs, findEngine: (name: string) => string | null = findBinary) {
    this.store = store;
    this.findEngine = findEngine;
    this.mcp = mcp;
    this.tokens = tokens;
    this.events = events;
    this.jobs = jobs;
    this.sink = { delta: (agentId, text) => events.delta(agentId, text), changed: () => events.changed(), revoke: (token) => tokens.revoke(token) };
    this.failures = new RunnerFailures(jobs, events, tokens, store);
  }

  activeRun(agentId: string): { activity: string | null; since: string; taskId: string | null } | null {
    const active = this.active.get(agentId);
    if (active) return { activity: active.activity, since: active.since, taskId: taskOf(active.entry) };
    const preparing = this.preparing.get(agentId);
    return preparing ? { activity: "Starting its virtual computer…", since: preparing.since, taskId: taskOf(preparing.entry) } : null;
  }

  lastError(agentId: string): string | null {
    return this.failures.lastError(agentId);
  }

  activeEngines(): Map<Engine, number> {
    const counts = new Map<Engine, number>();
    for (const { run } of this.active.values()) counts.set(run.engine, (counts.get(run.engine) ?? 0) + 1);
    return counts;
  }

  queued(agentId: string): number {
    return this.queues.size(agentId);
  }

  send(agentId: string, text: string): void {
    this.store.addMessage(agentId, "user", text, new Date().toISOString());
    this.jobs.chatChanged(agentId);
    this.enqueue(agentId, { kind: "chat", text, from: null, context: USER_TRIGGER });
  }

  enqueue(agentId: string, entry: RunEntry): void {
    if (this.active.has(agentId) || this.preparing.has(agentId)) {
      if (this.failures.blocked(agentId, entry)) return;
      this.queues.push(agentId, entry);
      this.events.changed();
      return;
    }
    this.start(agentId, entry, true);
  }

  dropQueued(agentId: string, drop: (entry: RunEntry) => boolean): RunEntry[] {
    const dropped = this.queues.drop(agentId, drop);
    const preparing = this.preparing.get(agentId);
    if (preparing && drop(preparing.entry)) {
      this.preparing.delete(agentId);
      dropped.push(preparing.entry);
      this.next(agentId);
    }
    if (dropped.length > 0) this.events.changed();
    return dropped;
  }

  stop(agentId: string): void {
    this.queues.clear(agentId);
    this.interrupt(agentId, false);
  }

  stopAndWait(agentId: string): Promise<void> {
    this.stop(agentId);
    return this.waitForAgentIdle(agentId);
  }

  waitForAgentIdle(agentId: string): Promise<void> {
    return this.idle.waitForAgent(agentId, () => this.agentIsIdle(agentId));
  }

  interrupt(agentId: string, continueQueue = true): RunEntry | null {
    const preparing = this.preparing.get(agentId);
    if (preparing) {
      this.preparing.delete(agentId);
      this.events.changed();
      return preparing.entry;
    }
    const active = this.active.get(agentId);
    if (!active) return null;
    active.stopped = true;
    active.continueQueue = continueQueue;
    if (active.token) this.tokens.revoke(active.token);
    terminate(active.child);
    return active.entry;
  }

  resume(agentId: string): void {
    if (!this.active.has(agentId) && !this.preparing.has(agentId)) this.next(agentId);
  }

  stopAll(): Promise<void> {
    const busy = new Set([...this.active.keys(), ...this.preparing.keys(), ...this.queues.agents()]);
    for (const agentId of busy) this.stop(agentId);
    return this.idle.waitForAll(() => this.isIdle());
  }

  private start(agentId: string, entry: RunEntry, retryOnMissingSession: boolean): void {
    const agent = this.store.getAgent(agentId);
    if (!agent) return;
    if (this.failures.blocked(agentId, entry)) return this.next(agentId);
    if (agent.computer !== "virtual") return this.launch(agent, entry, retryOnMissingSession);
    if (agent.engine !== "claude-code") return this.failures.fail(agentId, entry, "A virtual computer works with Claude Code only.");
    const marker = { since: new Date().toISOString(), entry };
    this.preparing.set(agentId, marker);
    this.events.changed();
    this.idle.beginPreparation(agentId);
    this.events.prepareComputer(agentId).then(
      (binding) => {
        try {
          if (this.preparing.get(agentId) !== marker) {
            this.events.releaseComputer(binding);
            return;
          }
          this.preparing.delete(agentId);
          if (this.failures.blocked(agentId, entry)) {
            this.events.releaseComputer(binding);
            return this.next(agentId);
          }
          const current = this.store.getAgent(agentId);
          if (current?.computerId === binding.computerId) this.launch(current, entry, retryOnMissingSession, binding);
          else {
            this.events.releaseComputer(binding);
            this.next(agentId);
          }
        } finally {
          this.preparationFinished(agentId);
        }
      },
      (error: unknown) => {
        try {
          if (this.preparing.get(agentId) !== marker) return;
          this.preparing.delete(agentId);
          this.failures.failAndNotify(agentId, entry, `The virtual computer couldn't start: ${message(error)}`);
          this.next(agentId);
        } finally {
          this.preparationFinished(agentId);
        }
      },
    );
  }

  private launch(agent: StoredAgent, entry: RunEntry, retryOnMissingSession: boolean, binding: ComputerRunBinding | null = null): void {
    const agentId = agent.id;
    const binary = this.findEngine(BINARIES[agent.engine]);
    if (!binary) {
      if (binding) this.events.releaseComputer(binding);
      this.failures.failAndNotify(agentId, entry, `${BINARIES[agent.engine]} isn't installed (looked in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin).`);
      return;
    }
    const prepared = prepareRun(agent, entry, binding, this.jobs, this.tokens, this.mcp, (id, runEntry, reason) => this.failures.failAndNotify(id, runEntry, reason));
    if (!prepared) {
      if (binding) this.events.releaseComputer(binding);
      return this.next(agentId);
    }
    const { job, context, token, plan } = prepared;
    const claude = agent.engine === "claude-code";
    const virtual = agent.computer === "virtual";
    const args = claude ? claudeArguments(plan) : codexArguments(plan);
    const input = claude ? job.prompt : codexPrompt(plan.systemPrompt, job.prompt, plan.sessionId === null);
    const run: Run = {
      id: randomUUID(), agentId, engine: agent.engine, model: plan.model ?? "default",
      startedAt: new Date().toISOString(), endedAt: null, status: "running",
      costUsd: 0, inputTokens: 0, outputTokens: 0, error: null,
    };
    const sessionId = plan.sessionId ?? (claude ? plan.newSessionId : null);
    let child: ReturnType<typeof spawnEngine>;
    try {
      this.store.insertRun(run);
      if (claude && !plan.sessionId) job.saveSession(plan.newSessionId);
      if (context.tainted && sessionId) job.taintSession(sessionId);
      child = spawnEngine(binary, args, plan.workspace, input, agent.engine, {
        event: (event) => handleEvent(active, event, this.sink),
        error: (failure) => {
          active.error = failure;
        },
        close: (code, stderr) => this.finish(active, code, stderr, retryOnMissingSession),
      });
    } catch (error) {
      this.failures.abandonLaunch({ run, entry, token, binding }, error);
      return this.next(agentId);
    }
    const active: ActiveRun = {
      run, child, activity: "Thinking…", since: run.startedAt, sawResult: false, error: null, stopped: false, continueQueue: false,
      token, context, job, entry, sessionId, virtual, verified: !virtual,
    };
    this.active.set(agentId, active);
    this.failures.clear(agentId);
    log(`run ${run.id} started for ${agent.name} (${agent.engine}, ${run.model}${job.taskId ? `, task ${job.taskId}` : ""}, hop ${context.hop})`);
    this.events.changed();
  }

  private finish(active: ActiveRun, code: number | null, stderr: string, retryOnMissingSession: boolean): void {
    const { run } = active;
    if (active.token) this.tokens.revoke(active.token);
    if (active.context.computerId && active.context.computerRevision !== null && active.context.computerRuntime && active.context.computerProfile && active.context.computerLeaseId) {
      this.events.releaseComputer({
        computerId: active.context.computerId, computerRevision: active.context.computerRevision,
        computerRuntime: active.context.computerRuntime, computerProfile: active.context.computerProfile,
        computerLeaseId: active.context.computerLeaseId,
      });
    }
    if (active.context.tainted && active.sessionId) active.job.taintSession(active.sessionId);
    this.active.delete(run.agentId);
    const failure = active.stopped ? null : active.error ?? (active.sawResult || code === 0 ? null : stderr.trim().split("\n").slice(-3).join("\n") || `exited with ${code}`);
    run.endedAt = new Date().toISOString();
    run.status = active.stopped ? "stopped" : failure ? "failed" : "done";
    run.error = failure;
    this.store.finishRun(run);
    log(oneLine(`run ${run.id} ${run.status} ($${run.costUsd.toFixed(4)})${failure ? `: ${failure}` : ""}`));

    if (failure && retryOnMissingSession && MISSING_SESSION.test(failure)) {
      active.job.forgetSession();
      this.start(run.agentId, active.entry, false);
      return;
    }
    if (failure) {
      this.failures.failAndNotify(run.agentId, active.entry, failure);
    }
    if (active.stopped) this.jobs.notice(run.agentId, active.entry, "Stopped.");
    this.events.changed();
    if (!active.stopped || active.continueQueue) this.next(run.agentId);
    this.idle.resolve(run.agentId, () => this.agentIsIdle(run.agentId), () => this.isIdle());
  }

  private next(agentId: string): void {
    const next = this.queues.shift(agentId);
    if (next !== undefined) this.start(agentId, next, true);
  }

  private preparationFinished(agentId: string): void {
    this.idle.preparationFinished(agentId, () => this.agentIsIdle(agentId), () => this.isIdle());
  }

  private isIdle(): boolean {
    return this.active.size === 0 && !this.idle.hasAnyPreparation();
  }

  private agentIsIdle(agentId: string): boolean {
    return !this.active.has(agentId) && !this.preparing.has(agentId) && !this.idle.hasPreparation(agentId);
  }

}

function taskOf(entry: RunEntry): string | null {
  return entry.kind === "task" ? entry.taskId : null;
}
