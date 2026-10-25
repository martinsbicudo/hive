import { matchesRule, ruleFor, type Approvals } from "./approvals.ts";
import type { ComputerService } from "./computerService.ts";
import type { Store } from "./db.ts";
import { exportSnapshotSchema, type ExportSnapshot } from "./exportStaging.ts";
import { CONNECTOR_BLOCKED_RULE } from "./engines.ts";
import { AUTO_ALLOWED_COMPUTER_TOOLS, EXPORT_TOOL, TASK_TOOLS } from "./hiveTools.ts";
import { NotFoundError } from "./httpError.ts";
import { ValidationError } from "./agentFields.ts";
import { readExternalOnMac, type RunContext } from "./runTokens.ts";
import { visibleEscapes } from "./trust.ts";
import type { Approval, ApprovalStatus, StoredAgent } from "./types.ts";

export interface ApprovalDeskDeps {
  store: Store;
  approvals: Approvals;
  computers: Pick<ComputerService, "noteExportAllowed" | "noteExportClosed">;
  routeGated: ReadonlySet<string>;
  changed: () => void;
}

function fetchBlocked(agent: StoredAgent, toolName: string): boolean {
  return agent.connectors.length > 0 && toolName === CONNECTOR_BLOCKED_RULE;
}

export class ApprovalDesk {
  private readonly deps: ApprovalDeskDeps;

  constructor(deps: ApprovalDeskDeps) {
    this.deps = deps;
    deps.approvals.onSettled((approval) => deps.computers.noteExportClosed(approval));
  }

  wait(agentId: string, id: string, timeoutMs: number): Promise<ApprovalStatus> {
    if (this.deps.store.getApproval(id)?.agentId !== agentId) throw new NotFoundError("approval not found");
    return this.deps.approvals.wait(id, timeoutMs);
  }

  request(agentId: string, toolName: string, input: Record<string, unknown>, context: RunContext | null): { id: string; autoAllowed: boolean } {
    const agent = this.deps.store.getAgent(agentId);
    if (!agent) throw new NotFoundError("agent not found");
    if (TASK_TOOLS.has(toolName) || this.deps.routeGated.has(toolName)) return { id: "", autoAllowed: true };
    // A staged-export snapshot only becomes a card through askToExport, which shows its name, size and hash.
    if (toolName === EXPORT_TOOL && exportSnapshotSchema.safeParse(input).success) throw new ValidationError("export approvals come from the export tool only");
    const tainted = readExternalOnMac(context);
    if (agent.computer === "virtual") {
      if (AUTO_ALLOWED_COMPUTER_TOOLS.has(toolName)) return { id: "", autoAllowed: true };
      return { id: this.deps.approvals.create(agentId, toolName, input, { rememberable: false, tainted }).id, autoAllowed: false };
    }
    const blocked = fetchBlocked(agent, toolName);
    if (!blocked && agent.allowedTools.some((rule) => matchesRule(rule, toolName, input))) return { id: "", autoAllowed: true };
    return { id: this.deps.approvals.create(agentId, toolName, input, { rememberable: !blocked, tainted }).id, autoAllowed: false };
  }

  askToExport(agentId: string, snapshot: ExportSnapshot): string {
    const summary = `Export ${visibleEscapes(snapshot.filename)} (${snapshot.size} bytes, SHA-256 ${snapshot.sha256}) from ${visibleEscapes(snapshot.path)}`;
    return this.deps.approvals.create(agentId, EXPORT_TOOL, snapshot, { rememberable: false, summary }).id;
  }

  decide(id: string, allow: unknown, remember: unknown): Approval {
    if (typeof allow !== "boolean") throw new ValidationError("allow must be true or false");
    const { store, approvals, computers } = this.deps;
    const wasPending = store.getApproval(id)?.status === "pending";
    const approval = approvals.decide(id, allow);
    if (!approval) throw new NotFoundError("approval not found");
    const allowedNow = wasPending && approval.status === "allowed";
    const agent = store.getAgent(approval.agentId);
    if (allowedNow && agent?.computer === "virtual") computers.noteExportAllowed(approval);
    if (allowedNow && remember === true && approval.rememberable && agent?.computer === "mac") {
      const rule = ruleFor(approval.toolName, approval.input);
      if (rule !== null && !agent.allowedTools.includes(rule)) {
        store.updateAgent(agent.id, { allowedTools: [...agent.allowedTools, rule] }, new Date().toISOString());
      }
    }
    this.deps.changed();
    return approval;
  }
}
