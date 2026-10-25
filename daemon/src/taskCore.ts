import { z } from "zod";
import type { Approvals } from "./approvals.ts";
import type { Store } from "./db.ts";
import { HttpError } from "./httpError.ts";
import type { LoopGuard } from "./loopGuard.ts";
import type { RunEntry, RunJobs } from "./runJobs.ts";
import type { StoredAgent } from "./runPlan.ts";
import type { RunContext, TriggerContext } from "./runTokens.ts";
import type { GateReason } from "./taskGate.ts";
import type { Task, TaskEventKind } from "./types.ts";

export interface TaskDeps {
  store: Store;
  jobs: RunJobs;
  approvals: Approvals;
  guard: LoopGuard;
  enqueue(agentId: string, entry: RunEntry): void;
  dropQueued(agentId: string, drop: (entry: RunEntry) => boolean): RunEntry[];
  emit(taskId: string): void;
}

export interface Caller {
  agent: StoredAgent;
  context: RunContext;
  virtual: boolean;
  tainted: boolean;
}

export function parseOr400<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new HttpError(400, issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "invalid input");
}

export class TaskCore {
  readonly deps: TaskDeps;

  constructor(deps: TaskDeps) {
    this.deps = deps;
  }

  now(): string {
    return new Date().toISOString();
  }

  caller(context: RunContext): Caller {
    const agent = this.deps.store.getAgent(context.agentId);
    if (!agent) throw new HttpError(404, "agent not found");
    const virtual = context.launchedVirtual;
    return { agent, context, virtual, tainted: context.tainted || virtual };
  }

  agent(ref: string): StoredAgent {
    const agents = this.deps.store.listAgents();
    const lower = ref.toLowerCase();
    const byId = agents.find((agent) => agent.id === ref);
    if (byId) return byId;
    const byName = agents.filter((agent) => agent.name.toLowerCase() === lower);
    if (byName.length > 1) throw new HttpError(409, `more than one agent is called ${ref}; use its id from list_agents`);
    const [found] = byName;
    if (!found) throw new HttpError(404, `no agent called ${ref}; list_agents shows who exists`);
    return found;
  }

  isVirtual(agentId: string | null): boolean {
    return agentId !== null && this.deps.store.getAgent(agentId)?.computer === "virtual";
  }

  virtualParties(task: Task): StoredAgent[] {
    const parties: StoredAgent[] = [];
    for (const id of new Set([task.assigneeId, task.createdBy])) {
      const agent = id === null ? undefined : this.deps.store.getAgent(id);
      if (agent?.computer === "virtual") parties.push(agent);
    }
    return parties;
  }

  canSee(caller: Caller, task: Task): boolean {
    return !caller.virtual || task.assigneeId === caller.agent.id || task.createdBy === caller.agent.id;
  }

  scopedTask(caller: Caller, taskId: string): Task {
    const task = this.deps.store.tasks.getTask(taskId);
    if (!task || !this.canSee(caller, task)) throw new HttpError(404, "task not found");
    return task;
  }

  userTask(taskId: string): Task {
    const task = this.deps.store.tasks.getTask(taskId);
    if (!task) throw new HttpError(404, "task not found");
    return task;
  }

  agentEvent(caller: Caller, taskId: string, kind: TaskEventKind, text: string, gate: GateReason | null): void {
    const event = { taskId, author: caller.agent.id, kind, text, untrusted: caller.tainted, authorMac: !caller.virtual, gate };
    this.deps.store.tasks.addEvent(event, this.now());
    this.deps.emit(taskId);
  }

  userEvent(taskId: string, kind: TaskEventKind, text: string): void {
    this.deps.store.tasks.addEvent({ taskId, author: "user", kind, text, untrusted: false, authorMac: false, gate: null }, this.now());
    this.deps.emit(taskId);
  }

  system(taskId: string, text: string): void {
    this.deps.jobs.system(taskId, text);
  }

  nameOf(agentId: string): string {
    return this.deps.jobs.nameOf(agentId);
  }

  nextTrigger(caller: Caller): TriggerContext {
    return { hop: caller.context.hop + 1, origin: caller.agent.id, tainted: caller.tainted };
  }

  checkLoop(caller: Caller, target: StoredAgent, taskId: string | null): void {
    const reason = this.deps.guard.refusal(target.id, caller.context.hop + 1);
    if (reason === null) return;
    const text = `Hive didn't start a run for ${target.name}: ${reason}.`;
    if (taskId !== null) this.system(taskId, text);
    this.deps.store.addMessage(caller.agent.id, "error", text, this.now());
    this.deps.jobs.chatChanged(caller.agent.id);
    throw new HttpError(429, text);
  }

  runTask(targetId: string, taskId: string, context: TriggerContext): void {
    if (context.origin !== "user") this.deps.guard.admit(targetId);
    this.deps.enqueue(targetId, { kind: "task", taskId, context });
  }

  runChat(targetId: string, text: string, from: { agentId: string; untrusted: boolean }, context: TriggerContext): void {
    this.deps.guard.admit(targetId);
    this.deps.enqueue(targetId, { kind: "chat", text, from, context });
  }
}
