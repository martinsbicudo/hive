import { randomUUID } from "node:crypto";
import { TASK_ACTIONS, TASK_TOOLS, taskToolName, type TaskAction } from "./hiveTools.ts";
import { HttpError } from "./httpError.ts";
import { USER_TRIGGER, type RunContext } from "./runTokens.ts";
import { TaskActions } from "./taskActions.ts";
import { TASK_CHANGED, TaskChangedError } from "./taskApprovals.ts";
import { parseOr400, TaskCore, type TaskDeps } from "./taskCore.ts";
import type { RunEntry } from "./runJobs.ts";
import { userTaskInputs } from "./taskInput.ts";
import type { Approval, ApprovalStatus, Task, TaskEvent } from "./types.ts";

const OUTCOME_LIMIT = 500;
const MAC_TEXT_CHANGED = "a Mac agent's text on this task changed or wasn't confirmed; reload the task and confirm again";

type MacField = "title" | "description";

const LABELS: Record<TaskAction, string> = {
  list_agents: "agent list", list_tasks: "task list", create_task: "new task", update_task: "task change",
  comment_task: "comment", handoff_task: "handoff", message_agent: "message",
};

function labelOf(toolName: string): string {
  const action = TASK_ACTIONS.find((candidate) => taskToolName(candidate) === toolName);
  return action ? LABELS[action] : "request";
}

function taskIdOf(approval: Approval): string | null {
  return typeof approval.input.taskId === "string" ? approval.input.taskId : null;
}

export class TaskService {
  private readonly core: TaskCore;
  private readonly actions: TaskActions;
  private readonly outcomes = new Map<string, { agentId: string; body: Record<string, unknown> }>();

  constructor(deps: TaskDeps) {
    this.core = new TaskCore(deps);
    this.actions = new TaskActions(this.core);
    deps.approvals.onSettled((approval) => this.settled(approval));
  }

  act(context: RunContext, action: TaskAction, raw: unknown): unknown {
    return this.actions.perform(this.core.caller(context), action, raw, null);
  }

  outcome(agentId: string, approvalId: string, status: ApprovalStatus): Record<string, unknown> {
    if (status === "pending") return { status };
    const outcome = this.outcomes.get(approvalId);
    if (!outcome || outcome.agentId !== agentId) return { status };
    this.outcomes.delete(approvalId);
    return { status, ...outcome.body };
  }

  list(): Task[] {
    return this.core.deps.store.tasks.listTasks();
  }

  get(id: string): { task: Task; events: TaskEvent[] } {
    return { task: this.core.userTask(id), events: this.core.deps.store.tasks.listEvents(id) };
  }

  create(raw: unknown): Task {
    const input = parseOr400(userTaskInputs.create, raw);
    const assignee = input.assigneeId ? this.assignable(input.assigneeId) : null;
    const now = this.core.now();
    const task: Task = {
      id: randomUUID(), title: input.title, description: input.description ?? "", status: input.status ?? (assignee ? "todo" : "backlog"),
      assigneeId: assignee, createdBy: "user", titleUntrusted: false, descriptionUntrusted: false,
      titleMacOnly: false, descriptionMacOnly: false, createdAt: now, updatedAt: now,
    };
    this.core.deps.store.tasks.insertTask(task);
    if (assignee) {
      this.core.userEvent(task.id, "assign", `Assigned to ${this.core.nameOf(assignee)}`);
      this.core.runTask(assignee, task.id, USER_TRIGGER);
    } else this.core.deps.emit(task.id);
    return task;
  }

  update(id: string, raw: unknown): Task {
    const task = this.core.userTask(id);
    const input = parseOr400(userTaskInputs.update, raw);
    const assignee = input.assigneeId ? this.assignable(input.assigneeId) : null;
    const changed = input.assigneeId !== undefined && assignee !== task.assigneeId;
    const title = input.title !== undefined && input.title !== task.title ? input.title : undefined;
    const description = input.description !== undefined && input.description !== task.description ? input.description : undefined;
    const hidden: MacField[] = [];
    if (title === undefined && task.titleMacOnly) hidden.push("title");
    if (description === undefined && task.descriptionMacOnly) hidden.push("description");
    const shown = changed && this.core.isVirtual(assignee) ? hidden : [];
    for (const field of shown) {
      if (input.showMacText?.[field] !== task[field]) throw new HttpError(409, MAC_TEXT_CHANGED, "mac-text");
    }
    const reveal = (field: MacField, value: string | undefined) => (value !== undefined || shown.includes(field) ? false : undefined);
    this.core.deps.store.tasks.updateTask(id, {
      title, titleUntrusted: title === undefined ? undefined : false, titleMacOnly: reveal("title", title),
      description, descriptionUntrusted: description === undefined ? undefined : false,
      descriptionMacOnly: reveal("description", description),
      status: input.status, assigneeId: changed ? assignee : undefined,
    }, this.core.now());
    if (input.status !== undefined && input.status !== task.status) this.core.userEvent(id, "status", `Status: ${task.status} → ${input.status}`);
    if (changed) this.core.userEvent(id, "assign", assignee ? `Assigned to ${this.core.nameOf(assignee)}` : "Unassigned");
    if (assignee && shown.length > 0) {
      this.core.userEvent(id, "assign", `Showed the Mac-written ${shown.join(" and ")} to virtual agents, starting with ${this.core.nameOf(assignee)}`);
    }
    this.core.deps.emit(id);
    if (changed && assignee) this.core.runTask(assignee, id, USER_TRIGGER);
    return this.core.userTask(id);
  }

  comment(id: string, raw: unknown): TaskEvent {
    const task = this.core.userTask(id);
    const { text } = parseOr400(userTaskInputs.comment, raw);
    const event = this.core.deps.store.tasks.addEvent({ taskId: id, author: "user", kind: "comment", text, untrusted: false, authorMac: false, gate: null }, this.core.now());
    this.core.deps.emit(id);
    if (task.assigneeId) this.core.runTask(task.assigneeId, id, USER_TRIGGER);
    return event;
  }

  agentRemoved(agentId: string, name: string): void {
    this.denyReaching(agentId);
    const { tasks } = this.core.deps.store;
    for (const task of tasks.tasksAssignedTo(agentId)) {
      tasks.updateTask(task.id, { assigneeId: null }, this.core.now());
      this.core.system(task.id, `${name} was deleted, so this task has no assignee now.`);
    }
  }

  modeChanged(agentId: string, name: string, interrupted: RunEntry | null): void {
    const { store, approvals } = this.core.deps;
    approvals.denyInvolving(agentId, TASK_TOOLS);
    this.denyReaching(agentId);
    const affected = new Set(store.tasks.sessionsOf(agentId).map((session) => session.taskId));
    if (interrupted?.kind === "task") affected.add(interrupted.taskId);
    store.tasks.deleteSessionsOf(agentId);
    for (const entry of this.core.deps.dropQueued(agentId, (queued) => queued.context.origin !== "user")) {
      if (entry.kind === "task") affected.add(entry.taskId);
      else this.core.deps.jobs.notice(agentId, entry, `A message from ${this.core.nameOf(entry.context.origin)} was dropped, because ${name} changed where it works.`);
    }
    for (const taskId of affected) {
      if (store.tasks.getTask(taskId)) this.core.system(taskId, `${name} changed where it works, so its current run was stopped, runs queued by other agents were dropped, and its next run on this task starts a new session.`);
    }
  }

  expiredAtStartup(stale: readonly Approval[]): void {
    for (const approval of stale) {
      const taskId = taskIdOf(approval);
      if (!TASK_TOOLS.has(approval.toolName) || taskId === null || !this.core.deps.store.tasks.getTask(taskId)) continue;
      this.core.system(taskId, `Hive restarted, so ${this.core.nameOf(approval.agentId)}'s ${labelOf(approval.toolName)} request expired. Nothing changed.`);
    }
  }

  private denyReaching(agentId: string): void {
    const reaching = [...this.actions.gates.pending.keys()].filter((id) => this.actions.gates.partiesOf(id).includes(agentId));
    for (const id of reaching) this.core.deps.approvals.deny(id);
  }

  private settled(approval: Approval): void {
    const pending = this.actions.gates.pending.get(approval.id);
    if (!pending) return;
    this.actions.gates.pending.delete(approval.id);
    const taskId = taskIdOf(approval);
    const who = this.core.nameOf(approval.agentId);
    const label = LABELS[pending.action];
    if (approval.status !== "allowed") {
      if (taskId && this.core.deps.store.tasks.getTask(taskId)) this.core.system(taskId, `The user didn't allow ${who}'s ${label} (${approval.status}). Nothing changed.`);
      this.remember(approval, {});
      return;
    }
    try {
      this.remember(approval, { result: this.actions.perform(this.core.caller(pending.context), pending.action, pending.input, pending) });
    } catch (error) {
      const refusedByGuard = error instanceof HttpError && error.status === 429;
      if (taskId && !refusedByGuard && this.core.deps.store.tasks.getTask(taskId)) {
        const why = error instanceof TaskChangedError ? `${TASK_CHANGED}.` : "things changed after the request.";
        this.core.system(taskId, `${who}'s approved ${label} wasn't done: ${why}`);
      }
      this.remember(approval, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private remember(approval: Approval, body: Record<string, unknown>): void {
    if (this.outcomes.size >= OUTCOME_LIMIT) {
      const oldest = this.outcomes.keys().next();
      if (!oldest.done) this.outcomes.delete(oldest.value);
    }
    this.outcomes.set(approval.id, { agentId: approval.agentId, body });
  }

  private assignable(agentId: string): string {
    if (!this.core.deps.store.getAgent(agentId)) throw new HttpError(400, "assigneeId isn't an agent");
    return agentId;
  }
}
