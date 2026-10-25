import type { z } from "zod";
import { computerInputs, computerResourceInputs, DEFAULT_TIMEOUT_S, isComputerRoute, xdotoolKeys } from "./computerInput.ts";
import { ComputerError } from "./computers.ts";
import { ComputerToolError } from "./computerService.ts";
import { ExportError, type ExportFailure } from "./export.ts";
import { HttpError } from "./httpError.ts";
import { NotVirtualError, type Hub } from "./hub.ts";
import type { RunContext } from "./runTokens.ts";

const EXPORT_STATUS: Record<ExportFailure, number> = {
  "invalid-path": 400, "too-large": 413, "not-a-file": 422, docker: 422, destination: 409,
  quota: 413, expired: 410, stale: 409,
};

function parse<T extends z.ZodType>(schema: T, body: Record<string, unknown>): z.output<T> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new HttpError(400, issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "invalid input");
}

function asHttpError(error: unknown): unknown {
  if (error instanceof NotVirtualError) return new HttpError(403, error.message);
  if (error instanceof ExportError) return new HttpError(EXPORT_STATUS[error.reason], error.message);
  if (error instanceof ComputerToolError) return new HttpError(422, error.message);
  if (error instanceof ComputerError) return new HttpError(409, error.message);
  return error;
}

function withoutAgentId(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== "agentId"));
}

async function dispatch(hub: Hub, context: RunContext, route: string | undefined, raw: Record<string, unknown>): Promise<unknown> {
  if (!isComputerRoute(route)) throw new HttpError(404, "not found");
  const { agentId, computerId, computerRevision, computerLeaseId } = context;
  hub.virtualAgent(agentId);
  if (!context.launchedVirtual || !computerId || computerRevision === null || !computerLeaseId || !hub.computerManagement.isCurrent(context)) {
    throw new HttpError(409, "this run no longer has access to its assigned computer");
  }
  const lease = { computerId, computerRevision, computerLeaseId };
  const body = withoutAgentId(raw);
  const guest = hub.computers.guest;
  switch (route) {
    case "run": {
      const input = parse(computerInputs.run, body);
      return guest.run(agentId, lease, input.command, input.timeout_s ?? DEFAULT_TIMEOUT_S);
    }
    case "screenshot":
      parse(computerInputs.screenshot, body);
      return { data: await guest.screenshot(agentId, lease), mimeType: "image/png" };
    case "click": {
      const input = parse(computerInputs.click, body);
      await guest.click(agentId, lease, input.x, input.y, input.button ?? "left");
      return { ok: true };
    }
    case "type":
      await guest.type(agentId, lease, parse(computerInputs.type, body).text);
      return { ok: true };
    case "key":
      await guest.key(agentId, lease, xdotoolKeys(parse(computerInputs.key, body).keys));
      return { ok: true };
    case "open":
      await guest.open(agentId, lease, parse(computerInputs.open, body).url);
      return { ok: true };
    case "read":
      return guest.readFile(agentId, lease, parse(computerInputs.read, body).path);
    case "write": {
      const input = parse(computerInputs.write, body);
      return guest.writeFile(agentId, lease, input.path, input.content);
    }
    case "export":
      return guest.exportFile(agentId, parse(computerInputs.export, body).path, lease, (snapshot) => hub.askToExport(agentId, snapshot));
  }
}

export async function internalComputer(hub: Hub, context: RunContext, route: string | undefined, body: Record<string, unknown>): Promise<unknown> {
  try {
    return await dispatch(hub, context, route, body);
  } catch (error) {
    throw asHttpError(error);
  }
}

export async function computerApi(hub: Hub, id: string, detail: string | undefined, method: string): Promise<{ status: number; body: unknown }> {
  try {
    if (detail === undefined && method === "GET") return { status: 200, body: hub.computerStatus(id) };
    if (detail === "start" && method === "POST") return { status: 202, body: hub.startComputer(id) };
    if (detail === "stop" && method === "POST") return { status: 200, body: await hub.stopComputer(id) };
    if (detail === "screen" && method === "GET") {
      const screen = hub.screen(id);
      if (!screen) throw new HttpError(409, "the virtual computer isn't running");
      return { status: 200, body: { port: screen.port, token: screen.token, password: screen.password } };
    }
  } catch (error) {
    throw asHttpError(error);
  }
  throw new HttpError(404, "not found");
}

export async function computerCollectionApi(hub: Hub, method: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  try {
    if (method === "GET") return { status: 200, body: hub.computerManagement.list() };
    if (method === "POST") {
      const input = parse(computerResourceInputs.create, body);
      return { status: 201, body: await hub.computerManagement.create(input.name, input.runtime, input.profile) };
    }
  } catch (error) {
    throw asHttpError(error);
  }
  throw new HttpError(404, "not found");
}

export async function computerResourceApi(hub: Hub, id: string, method: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  try {
    if (method === "GET") return { status: 200, body: hub.computerManagement.get(id) };
    if (method === "PATCH") {
      const input = parse(computerResourceInputs.update, body);
      return { status: 200, body: await hub.computerManagement.update(id, input) };
    }
    if (method === "DELETE") return { status: 200, body: await hub.computerManagement.delete(id) };
  } catch (error) {
    throw asHttpError(error);
  }
  throw new HttpError(404, "not found");
}

export async function computerMoveEngineApi(hub: Hub, id: string, body: Record<string, unknown>): Promise<unknown> {
  parse(computerResourceInputs.moveEngine, body);
  try {
    return await hub.computerManagement.moveEngine(id);
  } catch (error) {
    throw asHttpError(error);
  }
}

export function computerRuntimesApi(hub: Hub): Promise<unknown> {
  return hub.computerManagement.runtimeInfo();
}

export async function computerAssignmentApi(hub: Hub, agentId: string, method: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (method === "PUT") {
    const input = parse(computerResourceInputs.assignment, body);
    await hub.computerManagement.attach(agentId, input.computerId);
    return { status: 200, body: hub.agent(agentId) };
  }
  if (method === "DELETE") {
    await hub.computerManagement.detach(agentId);
    return { status: 200, body: { ok: true } };
  }
  throw new HttpError(404, "not found");
}
