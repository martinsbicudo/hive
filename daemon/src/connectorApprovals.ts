import type { Approvals } from "./approvals.ts";
import type { CommandRunner } from "./commandRunner.ts";
import { connectorAllowed, connectorContext, connectorToolName, type ConnectorTool, type PreparedCall } from "./connectorTools.ts";
import type { Store } from "./db.ts";
import { HttpError } from "./httpError.ts";
import { readExternalOnMac, type RunContext } from "./runTokens.ts";
import type { Approval, ApprovalStatus } from "./types.ts";

export const ONE_SEND_AT_A_TIME = "one send at a time: the user hasn't answered this agent's last request yet";
const OUTCOME_LIMIT = 500;

interface PendingSend {
  agentId: string;
  tool: ConnectorTool;
  call: PreparedCall;
  context: RunContext;
}

interface Outcome {
  agentId: string;
  done: Promise<Record<string, unknown>>;
}

export interface ConnectorApprovalDeps {
  approvals: Approvals;
  store: Store;
  commands: CommandRunner;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ConnectorApprovals {
  private readonly pending = new Map<string, PendingSend>();
  private readonly outcomes = new Map<string, Outcome>();
  private readonly deps: ConnectorApprovalDeps;

  constructor(deps: ConnectorApprovalDeps) {
    this.deps = deps;
    deps.approvals.onSettled((approval) => this.settled(approval));
  }

  ask(context: RunContext, tool: ConnectorTool, call: PreparedCall): { approvalId: string } {
    if (this.pendingFor(context.agentId).length > 0) throw new HttpError(409, ONE_SEND_AT_A_TIME);
    const approval = this.deps.approvals.create(context.agentId, connectorToolName(tool.tool), { ...call.payload }, {
      rememberable: false,
      tainted: readExternalOnMac(context),
      ...(call.summary === undefined ? {} : { summary: call.summary }),
      ...(call.display === undefined ? {} : { display: call.display }),
    });
    this.pending.set(approval.id, { agentId: context.agentId, tool, call, context });
    return { approvalId: approval.id };
  }

  denyFor(agentId: string): void {
    for (const id of this.pendingFor(agentId)) this.deps.approvals.deny(id);
  }

  async outcome(agentId: string, approvalId: string, status: ApprovalStatus): Promise<Record<string, unknown>> {
    if (status === "pending") return { status };
    const outcome = this.outcomes.get(approvalId);
    if (!outcome || outcome.agentId !== agentId) return { status };
    this.outcomes.delete(approvalId);
    return { status, ...(await outcome.done) };
  }

  private pendingFor(agentId: string): string[] {
    return [...this.pending].filter(([, send]) => send.agentId === agentId).map(([id]) => id);
  }

  private settled(approval: Approval): void {
    const send = this.pending.get(approval.id);
    if (!send) return;
    this.pending.delete(approval.id);
    const runs = approval.status === "allowed" && approval.agentId === send.agentId;
    this.remember(approval, runs ? this.execute(send) : Promise.resolve({}));
  }

  private async execute(send: PendingSend): Promise<Record<string, unknown>> {
    if (!connectorAllowed(this.deps.store.getAgent(send.agentId), send.tool.connector)) {
      return { error: `this agent can't use the ${send.tool.connector} connector any more, so Hive didn't do it` };
    }
    try {
      return { result: await send.call.execute(connectorContext(send.context, this.deps.commands)) };
    } catch (error) {
      return { error: messageOf(error) };
    }
  }

  private remember(approval: Approval, done: Promise<Record<string, unknown>>): void {
    if (this.outcomes.size >= OUTCOME_LIMIT) {
      const oldest = this.outcomes.keys().next();
      if (!oldest.done) this.outcomes.delete(oldest.value);
    }
    this.outcomes.set(approval.id, { agentId: approval.agentId, done });
  }
}
