import type { Approvals } from "./approvals.ts";
import { taskToolName, type TaskAction } from "./hiveTools.ts";
import { HttpError } from "./httpError.ts";
import { readExternalOnMac, type RunContext } from "./runTokens.ts";
import type { Caller } from "./taskCore.ts";
import { effectKey, gateSummary, SUMMARY_CAP, type GateEffect, type GateReason } from "./taskGate.ts";
import type { Task } from "./types.ts";

export interface Delivered {
  title?: string;
  description?: string;
  note?: string;
  text?: string;
}

type TaskSnapshot = Pick<Task, "title" | "description" | "status" | "assigneeId">;

export interface Approved {
  effects: { reason: GateReason; partyId: string }[];
  delivered: Delivered;
  snapshot: TaskSnapshot | null;
}

export interface PendingAction extends Approved {
  action: TaskAction;
  input: unknown;
  context: RunContext;
  taskId: string | null;
}

export interface GateRequest {
  effects: GateEffect[];
  task: Task | null;
  delivered: Delivered;
  what: string;
}

export const TASK_CHANGED = "the task changed after you were asked; ask again";

export class TaskChangedError extends HttpError {
  constructor() {
    super(409, TASK_CHANGED);
  }
}

const DELIVERED_KEYS = ["title", "description", "note", "text"] as const;
const SNAPSHOT_KEYS = ["title", "description", "status", "assigneeId"] as const;

function snapshotOf(task: Task | null): TaskSnapshot | null {
  return task === null ? null : { title: task.title, description: task.description, status: task.status, assigneeId: task.assigneeId };
}

function changed(before: TaskSnapshot | null, now: TaskSnapshot | null): boolean {
  if (before === null || now === null) return before !== now;
  return SNAPSHOT_KEYS.some((key) => before[key] !== now[key]);
}

export class TaskApprovals {
  readonly pending = new Map<string, PendingAction>();
  private readonly approvals: Approvals;

  constructor(approvals: Approvals) {
    this.approvals = approvals;
  }

  gate(caller: Caller, action: TaskAction, input: object, approved: Approved | null, request: GateRequest): { approvalId: string } | null {
    const effects = request.effects.map((effect) => ({ reason: effect.reason, partyId: effect.party.id }));
    const [first] = request.effects;
    if (approved !== null) {
      if (effectKey(approved.effects) !== effectKey(effects)) {
        throw new HttpError(409, "the agents involved changed since the user approved this, so Hive didn't do it");
      }
      if (DELIVERED_KEYS.some((key) => approved.delivered[key] !== request.delivered[key])) throw new TaskChangedError();
      if (changed(approved.snapshot, snapshotOf(request.task))) throw new TaskChangedError();
      return null;
    }
    if (first === undefined) return null;
    const taskId = request.task?.id ?? null;
    const callerName = caller.virtual || !caller.tainted ? caller.agent.name : `${caller.agent.name} (carrying another agent's content)`;
    const summary = gateSummary(request.effects, callerName, request.what);
    if (summary.length > SUMMARY_CAP) {
      const where = request.effects.some((effect) => effect.reason === "mac-to-virtual") ? "send to a virtual agent" : "show the user";
      throw new HttpError(400, `this is too long to ${where} for approval; shorten it`);
    }
    const approval = this.approvals.create(caller.agent.id, taskToolName(action), { ...input, taskId }, {
      rememberable: false,
      targetAgentId: first.party.id,
      summary,
      tainted: readExternalOnMac(caller.context),
    });
    const snapshot = snapshotOf(request.task);
    this.pending.set(approval.id, { action, input, context: caller.context, effects, delivered: request.delivered, snapshot, taskId });
    return { approvalId: approval.id };
  }

  partiesOf(approvalId: string): string[] {
    return this.pending.get(approvalId)?.effects.map((effect) => effect.partyId) ?? [];
  }

  holdChanges(taskId: string): void {
    if ([...this.pending.values()].some((pending) => pending.taskId === taskId)) {
      throw new HttpError(409, "the user hasn't answered a request about this task yet, so it can't change until they do");
    }
  }
}
