import { z } from "zod";

const taskStatus = z.enum(["backlog", "todo", "doing", "review", "done", "blocked"]);

export const task = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    status: taskStatus,
    assigneeId: z.string().nullable(),
    createdBy: z.string(),
    titleUntrusted: z.boolean(),
    descriptionUntrusted: z.boolean(),
    titleMacOnly: z.boolean(),
    descriptionMacOnly: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const taskEvent = z
  .object({
    id: z.number(),
    taskId: z.string(),
    author: z.string(),
    kind: z.enum(["comment", "status", "assign", "handoff"]),
    text: z.string(),
    untrusted: z.boolean(),
    authorMac: z.boolean(),
    gate: z.enum(["mac-to-virtual", "tainted-to-mac"]).nullable(),
    createdAt: z.string(),
  })
  .strict();

export const taskThread = z.object({ task, events: z.array(taskEvent) }).strict();

export type TaskStatus = z.infer<typeof taskStatus>;
export type Task = z.infer<typeof task>;
export type TaskEvent = z.infer<typeof taskEvent>;
