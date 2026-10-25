import { HttpError } from "./httpError.ts";
import type { Hub } from "./hub.ts";
import type { RunContext } from "./runTokens.ts";
import { parseOr400 } from "./taskCore.ts";
import { isTaskAction, waitInput } from "./taskInput.ts";

const WAIT_POLL_MS = 25_000;

export interface Reply {
  status: number;
  body: unknown;
}

function withoutAgentId(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== "agentId"));
}

export async function taskApi(hub: Hub, method: string, id: string | undefined, action: string | undefined, body: () => Promise<Record<string, unknown>>): Promise<Reply> {
  if (id === undefined && method === "GET") return { status: 200, body: hub.tasks.list() };
  if (id === undefined && method === "POST") return { status: 201, body: hub.tasks.create(await body()) };
  if (id !== undefined && action === undefined && method === "GET") return { status: 200, body: hub.tasks.get(id) };
  if (id !== undefined && action === undefined && method === "PATCH") return { status: 200, body: hub.tasks.update(id, await body()) };
  if (id !== undefined && action === "comments" && method === "POST") return { status: 201, body: hub.tasks.comment(id, await body()) };
  throw new HttpError(404, "not found");
}

export async function internalTasks(hub: Hub, context: RunContext, route: string | undefined, raw: Record<string, unknown>): Promise<unknown> {
  const body = withoutAgentId(raw);
  if (route === "wait") {
    const { approvalId } = parseOr400(waitInput, body);
    const status = await hub.waitForApproval(context.agentId, approvalId, WAIT_POLL_MS);
    return hub.tasks.outcome(context.agentId, approvalId, status);
  }
  if (!isTaskAction(route)) throw new HttpError(404, "not found");
  return hub.tasks.act(context, route, body);
}
