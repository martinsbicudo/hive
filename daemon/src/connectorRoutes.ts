import { z } from "zod";
import type { ConnectorApprovals } from "./connectorApprovals.ts";
import type { CommandRunner } from "./commandRunner.ts";
import { connectorAllowed, connectorContext, type ConnectorTool } from "./connectorTools.ts";
import type { Store } from "./db.ts";
import { HttpError } from "./httpError.ts";
import type { RunContext } from "./runTokens.ts";
import { parseOr400 } from "./taskCore.ts";
import type { ApprovalStatus } from "./types.ts";

const WAIT_POLL_MS = 25_000;
const waitInput = z.object({ approvalId: z.string().min(1).max(100) }).strict();

export interface ConnectorRouteDeps {
  store: Store;
  tools: ReadonlyMap<string, ConnectorTool>;
  gate: ConnectorApprovals;
  commands: CommandRunner;
  waitForApproval(agentId: string, id: string, timeoutMs: number): Promise<ApprovalStatus>;
}

export async function internalConnectors(deps: ConnectorRouteDeps, context: RunContext, route: string | undefined, body: Record<string, unknown>): Promise<unknown> {
  if (route === "wait") {
    const { approvalId } = parseOr400(waitInput, body);
    const status = await deps.waitForApproval(context.agentId, approvalId, WAIT_POLL_MS);
    return deps.gate.outcome(context.agentId, approvalId, status);
  }
  const tool = route === undefined ? undefined : deps.tools.get(route);
  if (!tool) throw new HttpError(404, "not found");
  if (context.launchedVirtual || !connectorAllowed(deps.store.getAgent(context.agentId), tool.connector)) {
    throw new HttpError(403, `this agent can't use the ${tool.connector} connector; it needs a Mac agent on Claude Code with ${tool.connector} turned on`);
  }
  if (!context.launchedConnectors.includes(tool.connector)) {
    throw new HttpError(403, `${tool.connector} was turned on after this run started; the agent can use it from its next run`);
  }
  const call = tool.prepare(body);
  if (call.kind === "outward") return deps.gate.ask(context, tool, call);
  try {
    return { result: await call.execute(connectorContext(context, deps.commands)) };
  } finally {
    context.tainted = true;
  }
}
