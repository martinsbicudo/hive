import { z } from "zod";
import { HttpError } from "./httpError.ts";
import type { Hub } from "./hub.ts";
import { parseOr400 } from "./taskCore.ts";
import type { Reply } from "./taskRoutes.ts";

const emptyBody = z.object({}).strict();

type Body = () => Promise<Record<string, unknown>>;

export async function architectApi(hub: Hub, method: string, parts: readonly string[], body: Body): Promise<Reply | null> {
  const [, resource, action] = parts;
  if (resource !== "architect") return null;
  if (action === undefined && method === "POST") return { status: 200, body: await hub.architect.turn(await body()) };
  if (action === "stop" && method === "POST" && parts.length === 3) {
    parseOr400(emptyBody, await body());
    return { status: 200, body: { ok: true, stopped: hub.architect.stop() } };
  }
  throw new HttpError(404, "not found");
}
