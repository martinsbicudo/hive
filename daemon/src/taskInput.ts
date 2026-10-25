import { z } from "zod";
import { TASK_ACTIONS, type TaskAction } from "./hiveTools.ts";
import { TASK_STATUSES } from "./types.ts";

export const MAX_TITLE = 200;
export const MAX_TEXT = 8000;
const MAX_REF = 80;

const title = z.string().trim().min(1).max(MAX_TITLE);
const body = z.string().max(MAX_TEXT);
const status = z.enum(TASK_STATUSES);
const taskId = z.string().min(1).max(MAX_REF).describe("The task id from list_tasks");
const agentRef = z.string().trim().min(1).max(MAX_REF).describe("An agent's id or exact name, from list_agents");

export const taskShapes = {
  list_agents: {},
  list_tasks: { taskId: taskId.optional().describe("Give a task id to also get its thread") },
  create_task: {
    title,
    description: body.optional(),
    status: status.optional(),
    assignee: agentRef.optional().describe("Who should work on it; leave out to keep it unassigned"),
  },
  update_task: {
    taskId,
    title: title.optional(),
    description: body.optional(),
    status: status.optional(),
    assignee: agentRef.nullable().optional().describe("A new assignee, or null to unassign"),
  },
  comment_task: { taskId, text: body.min(1) },
  handoff_task: { taskId, to: agentRef, note: body.optional().describe("What the next agent should know") },
  message_agent: { to: agentRef, text: body.min(1) },
} as const satisfies Record<TaskAction, z.ZodRawShape>;

export const taskInputs = {
  list_agents: z.object(taskShapes.list_agents).strict(),
  list_tasks: z.object(taskShapes.list_tasks).strict(),
  create_task: z.object(taskShapes.create_task).strict(),
  update_task: z.object(taskShapes.update_task).strict(),
  comment_task: z.object(taskShapes.comment_task).strict(),
  handoff_task: z.object(taskShapes.handoff_task).strict(),
  message_agent: z.object(taskShapes.message_agent).strict(),
};

export type TaskInputs = { [Action in TaskAction]: z.output<(typeof taskInputs)[Action]> };

export function isTaskAction(value: string | undefined): value is TaskAction {
  return TASK_ACTIONS.some((action) => action === value);
}

export const waitInput = z.object({ approvalId: z.string().min(1).max(MAX_REF) }).strict();

const assigneeId = z.string().min(1).max(MAX_REF).nullable();

export const userTaskInputs = {
  create: z.object({ title, description: body.optional(), status: status.optional(), assigneeId: assigneeId.optional() }).strict(),
  update: z.object({
    title: title.optional(), description: body.optional(), status: status.optional(), assigneeId: assigneeId.optional(),
    showMacText: z.object({ title: z.string().max(MAX_TITLE).optional(), description: body.optional() }).strict().optional(),
  }).strict(),
  comment: z.object({ text: body.trim().min(1) }).strict(),
};

export type UserTaskCreate = z.output<typeof userTaskInputs.create>;
export type UserTaskUpdate = z.output<typeof userTaskInputs.update>;
