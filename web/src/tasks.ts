import { TASK_STATUSES } from "../../daemon/src/types.ts";
import type { Agent, Approval, Task, TaskEvent, TaskPatch, TaskStatus } from "./api.ts";

export { TASK_STATUSES };

export const STATUS_TITLES: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  doing: "Doing",
  review: "Review",
  done: "Done",
  blocked: "Blocked",
};

export function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.some((status) => status === value);
}

export function groupByStatus(tasks: readonly Task[]): Record<TaskStatus, Task[]> {
  const groups: Record<TaskStatus, Task[]> = { backlog: [], todo: [], doing: [], review: [], done: [], blocked: [] };
  for (const task of [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) groups[task.status].push(task);
  return groups;
}

export function withStatus(tasks: readonly Task[], id: string, status: TaskStatus): Task[] {
  return tasks.map((task) => (task.id === id ? { ...task, status } : task));
}

export function waitingTaskIds(approvals: readonly Pick<Approval, "input">[]): Set<string> {
  const ids = new Set<string>();
  for (const approval of approvals) {
    const id = approval.input["taskId"];
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

export function isFromVirtualAgent(task: Pick<Task, "titleUntrusted" | "descriptionUntrusted">): boolean {
  return task.titleUntrusted || task.descriptionUntrusted;
}

export type MacField = "title" | "description";

export function macOnlyFields(task: Pick<Task, "titleMacOnly" | "descriptionMacOnly">): MacField[] {
  const fields: MacField[] = [];
  if (task.titleMacOnly) fields.push("title");
  if (task.descriptionMacOnly) fields.push("description");
  return fields;
}

export function shownMacText(task: Pick<Task, "title" | "description">, fields: readonly MacField[]): NonNullable<TaskPatch["showMacText"]> {
  const shown: NonNullable<TaskPatch["showMacText"]> = {};
  for (const field of fields) shown[field] = task[field];
  return shown;
}

export function changedDetails(task: Pick<Task, "title" | "description">, title: string, description: string): Pick<TaskPatch, "title" | "description"> {
  const patch: Pick<TaskPatch, "title" | "description"> = {};
  if (title !== task.title) patch.title = title;
  if (description !== task.description) patch.description = description;
  return patch;
}

export interface Author {
  name: string;
  agent: Agent | null;
}

export function authorOf(event: Pick<TaskEvent, "author">, agents: readonly Agent[]): Author {
  if (event.author === "user") return { name: "You", agent: null };
  if (event.author === "system") return { name: "Hive", agent: null };
  const agent = agents.find((item) => item.id === event.author) ?? null;
  return { name: agent?.name ?? "Deleted agent", agent };
}

export function untrustedLabel(event: Pick<TaskEvent, "untrusted" | "authorMac">, author: Author): string | null {
  if (!event.untrusted) return null;
  if (event.authorMac) return `${author.name} (carrying a virtual agent's content)`;
  return `from ${author.name} (virtual)`;
}

export function formatWhen(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
