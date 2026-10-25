import { z } from "zod";
import { HttpError } from "./httpError.ts";
import type { Hub } from "./hub.ts";
import { log } from "./log.ts";
import { parseOr400 } from "./taskCore.ts";
import type { Reply } from "./taskRoutes.ts";

const emptyBody = z.object({}).strict();

type Body = () => Promise<Record<string, unknown>>;

async function schedules(hub: Hub, method: string, agentId: string, scheduleId: string | undefined, body: Body): Promise<Reply> {
  if (scheduleId === undefined && method === "GET") return { status: 200, body: hub.schedules.list(agentId) };
  if (scheduleId === undefined && method === "POST") return { status: 201, body: hub.schedules.add(agentId, await body()) };
  if (scheduleId !== undefined && method === "PATCH") return { status: 200, body: hub.schedules.update(agentId, scheduleId, await body()) };
  if (scheduleId !== undefined && method === "DELETE") {
    hub.schedules.remove(agentId, scheduleId);
    return { status: 200, body: { ok: true } };
  }
  throw new HttpError(404, "not found");
}

export async function controlApi(hub: Hub, method: string, parts: readonly string[], body: Body): Promise<Reply | null> {
  const [, resource, id, action, detail] = parts;
  if (resource === "pause" && method === "POST" && parts.length === 2) {
    parseOr400(emptyBody, await body());
    hub.control.pause().catch((error: unknown) => log(`stopping computers for the pause failed: ${String(error)}`));
    return { status: 200, body: { ok: true, paused: true } };
  }
  if (resource === "resume" && method === "POST" && parts.length === 2) {
    parseOr400(emptyBody, await body());
    hub.control.resume();
    return { status: 200, body: { ok: true, paused: false } };
  }
  if (resource === "budgets" && parts.length === 2) {
    if (method === "GET") return { status: 200, body: hub.control.budgets() };
    if (method === "PUT") return { status: 200, body: hub.control.setBudgets(await body()) };
  }
  if (resource === "agents" && id && action === "schedules" && parts.length <= 5) return schedules(hub, method, id, detail, body);
  return null;
}
