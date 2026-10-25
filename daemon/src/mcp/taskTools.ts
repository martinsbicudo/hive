import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TASK_ACTIONS, type TaskAction } from "../hiveTools.ts";
import { taskShapes } from "../taskInput.ts";

export interface TaskLink {
  url: string;
  token: string;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const DESCRIPTIONS: Record<TaskAction, string> = {
  list_agents: "Lists the agents in this Hive (id, name, role, and whether they work on the Mac or a virtual computer).",
  list_tasks: "Lists the Hive tasks you can see. Give taskId to get one task with its thread.",
  create_task: "Creates a Hive task. Give an assignee to have that agent start on it.",
  update_task: "Changes a task's title, description, status (backlog, todo, doing, review, done, blocked) or assignee.",
  comment_task: "Adds a comment to a task's thread. It doesn't wake anyone up.",
  handoff_task: "Hands a task to another agent with a note; that agent starts working on it.",
  message_agent: "Sends a direct message to another agent; it arrives in that agent's chat and starts a run.",
};

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Object.entries(value).find(([name]) => name === key)?.[1] : undefined;
}

function text(value: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text: value }], isError } : { content: [{ type: "text", text: value }] };
}

async function post(link: TaskLink, route: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL(`/internal/tasks/${route}`, link.url), {
    method: "POST",
    headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

async function waitFor(link: TaskLink, approvalId: string): Promise<ToolResult> {
  for (;;) {
    const reply = await post(link, "wait", { approvalId });
    if (reply.status !== 200) return text(`Hive refused this (${reply.status}): ${String(field(reply.body, "error") ?? "unknown error")}`, true);
    const status = field(reply.body, "status");
    if (status === "pending") continue;
    if (status !== "allowed") return text("The user didn't allow this, so nothing changed. Don't retry it unless they ask.", true);
    const error = field(reply.body, "error");
    if (typeof error === "string") return text(`The user allowed it, but Hive couldn't do it: ${error}`, true);
    return text(`The user allowed it. ${JSON.stringify(field(reply.body, "result") ?? {})}`);
  }
}

async function run(link: TaskLink, action: TaskAction, input: unknown): Promise<ToolResult> {
  try {
    const reply = await post(link, action, input);
    if (reply.status !== 200) return text(`Hive refused this (${reply.status}): ${String(field(reply.body, "error") ?? "unknown error")}`, true);
    const approvalId = field(reply.body, "approvalId");
    if (typeof approvalId === "string") return await waitFor(link, approvalId);
    return text(JSON.stringify(reply.body));
  } catch (error) {
    return text(`Hive isn't reachable (${String(error)}).`, true);
  }
}

export function registerTaskTools(server: McpServer, link: TaskLink): void {
  for (const action of TASK_ACTIONS) {
    server.registerTool(action, { description: DESCRIPTIONS[action], inputSchema: taskShapes[action] }, (input: unknown) => run(link, action, input));
  }
}
