import { randomUUID } from "node:crypto";
import type { TaskAction } from "./hiveTools.ts";
import { HttpError } from "./httpError.ts";
import { TaskApprovals, type Approved, type Delivered, type GateRequest } from "./taskApprovals.ts";
import { parseOr400, type Caller, type TaskCore } from "./taskCore.ts";
import { eventGate, gateFor, type GateReason } from "./taskGate.ts";
import { taskInputs, type TaskInputs } from "./taskInput.ts";
import { authorName, renderEvent, renderTaskFields, visibleEvents } from "./taskPrompt.ts";
import { UnsafeContentError } from "./trust.ts";
import type { Task } from "./types.ts";

export class TaskActions {
  readonly gates: TaskApprovals;
  private readonly core: TaskCore;

  constructor(core: TaskCore) {
    this.core = core;
    this.gates = new TaskApprovals(core.deps.approvals);
  }

  perform(caller: Caller, action: TaskAction, raw: unknown, approved: Approved | null): unknown {
    switch (action) {
      case "list_agents":
        parseOr400(taskInputs.list_agents, raw);
        return this.listAgents(caller);
      case "list_tasks":
        return this.listTasks(caller, parseOr400(taskInputs.list_tasks, raw));
      case "create_task":
        return this.createTask(caller, parseOr400(taskInputs.create_task, raw), approved);
      case "update_task":
        return this.updateTask(caller, parseOr400(taskInputs.update_task, raw), approved);
      case "comment_task":
        return this.commentTask(caller, parseOr400(taskInputs.comment_task, raw), approved);
      case "handoff_task":
        return this.handoffTask(caller, parseOr400(taskInputs.handoff_task, raw), approved);
      case "message_agent":
        return this.messageAgent(caller, parseOr400(taskInputs.message_agent, raw), approved);
    }
  }

  private gate(caller: Caller, action: TaskAction, input: object, approved: Approved | null, request: GateRequest) {
    return this.gates.gate(caller, action, input, approved, request);
  }

  private listAgents(caller: Caller) {
    const agents = this.core.deps.store.listAgents().map((agent) => ({
      id: agent.id, name: agent.name, role: agent.role, computer: agent.computer, you: agent.id === caller.agent.id,
    }));
    return { agents };
  }

  private listTasks(caller: Caller, input: TaskInputs["list_tasks"]) {
    const { store } = this.core.deps;
    const nonce = caller.context.nonce;
    const name = (id: string) => this.core.nameOf(id);
    let wrapped = false;
    const view = (task: Task) => {
      const fields = renderTaskFields(task, nonce, name, caller.virtual);
      wrapped ||= fields.title.wrapped || fields.description.wrapped;
      return {
        id: task.id, title: fields.title.text, description: fields.description.text, status: task.status,
        assignee: task.assigneeId ? name(task.assigneeId) : null, assigneeId: task.assigneeId, createdBy: authorName(task.createdBy, name),
      };
    };
    try {
      if (input.taskId === undefined) {
        const tasks = store.tasks.listTasks().filter((task) => this.core.canSee(caller, task)).map(view);
        if (wrapped) caller.context.tainted = true;
        return { tasks };
      }
      const task = this.core.scopedTask(caller, input.taskId);
      const thread = visibleEvents(store.tasks.listEvents(task.id), caller.virtual).map((event) => {
        const shown = renderEvent(event, nonce, name);
        wrapped ||= shown.wrapped;
        return { author: authorName(event.author, name), kind: event.kind, text: shown.text, at: event.createdAt };
      });
      const result = { task: view(task), thread };
      if (wrapped) caller.context.tainted = true;
      return result;
    } catch (error) {
      if (error instanceof UnsafeContentError) throw new HttpError(422, error.message);
      throw error;
    }
  }

  private createTask(caller: Caller, input: TaskInputs["create_task"], approved: Approved | null) {
    const assignee = input.assignee === undefined ? null : this.core.agent(input.assignee);
    const runs = assignee !== null && assignee.id !== caller.agent.id;
    if (runs) this.core.checkLoop(caller, assignee, null);
    const effects = gateFor(caller, runs ? assignee : null, assignee ? [assignee] : []);
    const delivered = { title: input.title, description: input.description ?? "" };
    const gated = this.gate(caller, "create_task", input, approved, { effects, task: null, delivered, what: `take on a new task ${carried(delivered)}` });
    if (gated) return gated;
    const gate = approved === null ? null : eventGate(effects);
    const macOnly = macOnlyWrite(caller, gate);
    const now = this.core.now();
    const task: Task = {
      id: randomUUID(), title: input.title, description: input.description ?? "", status: input.status ?? (assignee ? "todo" : "backlog"),
      assigneeId: assignee?.id ?? null, createdBy: caller.agent.id, titleUntrusted: caller.tainted, descriptionUntrusted: caller.tainted,
      titleMacOnly: macOnly, descriptionMacOnly: macOnly, createdAt: now, updatedAt: now,
    };
    this.core.deps.store.tasks.insertTask(task);
    if (assignee) this.core.agentEvent(caller, task.id, "assign", `Assigned to ${assignee.name}`, gate);
    else this.core.deps.emit(task.id);
    if (runs) this.core.runTask(assignee.id, task.id, this.core.nextTrigger(caller));
    return { taskId: task.id };
  }

  private updateTask(caller: Caller, input: TaskInputs["update_task"], approved: Approved | null) {
    const task = this.core.scopedTask(caller, input.taskId);
    if (approved === null) this.gates.holdChanges(task.id);
    const { title, description, status } = input;
    if (title === undefined && description === undefined && status === undefined && input.assignee === undefined) {
      throw new HttpError(400, "nothing to change");
    }
    const newAssignee = input.assignee === undefined || input.assignee === null ? null : this.core.agent(input.assignee);
    const changed = input.assignee !== undefined && (newAssignee?.id ?? null) !== task.assigneeId;
    const runTarget = changed && newAssignee !== null && newAssignee.id !== caller.agent.id ? newAssignee : null;
    if (runTarget) this.core.checkLoop(caller, runTarget, task.id);
    const viewers = [...(changed && newAssignee ? [newAssignee] : []), ...this.core.virtualParties(task)];
    const effects = gateFor(caller, runTarget, viewers);
    const delivered = { title: title ?? task.title, description: description ?? task.description };
    const what = `change task ${carried(delivered)} (${describeUpdate(input)})`;
    const gated = this.gate(caller, "update_task", input, approved, { effects, task, delivered, what });
    if (gated) return gated;
    const gate = approved === null ? null : eventGate(effects);
    const tainted = caller.tainted;
    const macOnly = macOnlyWrite(caller, gate);
    const shown = gate === "mac-to-virtual" ? false : undefined;
    this.core.deps.store.tasks.updateTask(task.id, {
      title, titleUntrusted: title === undefined ? undefined : tainted, titleMacOnly: title === undefined ? shown : macOnly,
      description, descriptionUntrusted: description === undefined ? undefined : tainted,
      descriptionMacOnly: description === undefined ? shown : macOnly,
      status, assigneeId: changed ? (newAssignee?.id ?? null) : undefined,
    }, this.core.now());
    if (status !== undefined && status !== task.status) this.core.agentEvent(caller, task.id, "status", `Status: ${task.status} → ${status}`, gate);
    if (changed) this.core.agentEvent(caller, task.id, "assign", newAssignee ? `Assigned to ${newAssignee.name}` : "Unassigned", gate);
    this.core.deps.emit(task.id);
    if (runTarget) this.core.runTask(runTarget.id, task.id, this.core.nextTrigger(caller));
    return { taskId: task.id, status: status ?? task.status };
  }

  private commentTask(caller: Caller, input: TaskInputs["comment_task"], approved: Approved | null) {
    const task = this.core.scopedTask(caller, input.taskId);
    const effects = gateFor(caller, null, this.core.virtualParties(task));
    const delivered = { title: task.title, text: input.text };
    const what = `add to task "${task.title}": ${input.text}`;
    const gated = this.gate(caller, "comment_task", input, approved, { effects, task, delivered, what });
    if (gated) return gated;
    const gate = approved === null ? null : eventGate(effects);
    if (gate === "mac-to-virtual") this.core.deps.store.tasks.updateTask(task.id, { titleMacOnly: false }, this.core.now());
    this.core.agentEvent(caller, task.id, "comment", input.text, gate);
    return { taskId: task.id, ok: true };
  }

  private handoffTask(caller: Caller, input: TaskInputs["handoff_task"], approved: Approved | null) {
    const task = this.core.scopedTask(caller, input.taskId);
    if (approved === null) this.gates.holdChanges(task.id);
    const target = this.core.agent(input.to);
    if (target.id === caller.agent.id) throw new HttpError(400, "you can't hand a task to yourself");
    this.core.checkLoop(caller, target, task.id);
    const effects = gateFor(caller, target, [target, ...this.core.virtualParties(task)]);
    const note = input.note?.trim() ?? "";
    const delivered = { title: task.title, description: task.description, note };
    const gated = this.gate(caller, "handoff_task", input, approved, { effects, task, delivered, what: `take over task ${carried(delivered)}` });
    if (gated) return gated;
    const gate = approved === null ? null : eventGate(effects);
    const shown = gate === "mac-to-virtual" ? false : undefined;
    this.core.deps.store.tasks.updateTask(task.id, { assigneeId: target.id, titleMacOnly: shown, descriptionMacOnly: shown }, this.core.now());
    this.core.agentEvent(caller, task.id, "handoff", note ? `Handed to ${target.name}: ${note}` : `Handed to ${target.name}`, gate);
    this.core.runTask(target.id, task.id, this.core.nextTrigger(caller));
    return { taskId: task.id, assignee: target.name };
  }

  private messageAgent(caller: Caller, input: TaskInputs["message_agent"], approved: Approved | null) {
    const target = this.core.agent(input.to);
    if (target.id === caller.agent.id) throw new HttpError(400, "you can't message yourself");
    this.core.checkLoop(caller, target, null);
    const effects = gateFor(caller, target, [target]);
    const delivered = { text: input.text };
    const gated = this.gate(caller, "message_agent", input, approved, { effects, task: null, delivered, what: `read this message: ${input.text}` });
    if (gated) return gated;
    const { store } = this.core.deps;
    store.addMessage(target.id, "user", `From ${caller.agent.name}: ${input.text}`, this.core.now());
    this.core.deps.jobs.chatChanged(target.id);
    this.core.runChat(target.id, input.text, { agentId: caller.agent.id, untrusted: caller.tainted }, this.core.nextTrigger(caller));
    return { delivered: true, to: target.name };
  }

}

function carried({ title = "", description, note }: Delivered): string {
  const parts = [`"${title}"`];
  if (description) parts.push(`description: ${description}`);
  if (note) parts.push(`note: ${note}`);
  return parts.join(", ");
}

function macOnlyWrite(caller: Caller, gate: GateReason | null): boolean {
  return !caller.virtual && gate !== "mac-to-virtual";
}

function describeUpdate(input: TaskInputs["update_task"]): string {
  const parts: string[] = [];
  if (input.status !== undefined) parts.push(`status ${input.status}`);
  if (input.title !== undefined) parts.push("new title");
  if (input.description !== undefined) parts.push("new description");
  if (input.assignee !== undefined) parts.push(input.assignee === null ? "unassign" : `assign to ${input.assignee}`);
  return parts.join(", ");
}
