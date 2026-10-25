import { containerPath, ExportError, type ExportResult } from "./export.ts";
import { ExportStaging, exportSnapshotSchema, type ExportSnapshot, type GuestExec } from "./exportStaging.ts";
import { EXPORT_TOOL } from "./hiveTools.ts";
import { log } from "./log.ts";
import type { Approval } from "./types.ts";
import type { ComputerExportContext, ComputerServiceOptions } from "./computerService.ts";
import type { LeaseRef } from "./computerLeaseExec.ts";

export interface ExportScope {
  current: () => boolean;
  exec: GuestExec;
}

export class ComputerServiceExports {
  private readonly staging: ExportStaging;

  constructor(options: ComputerServiceOptions) {
    this.staging = new ExportStaging({ stageRoot: options.stageRoot, downloadsRoot: options.downloadsRoot, now: options.now });
  }

  noteAllowed(approval: Approval): void {
    if (approval.toolName !== EXPORT_TOOL || approval.status !== "allowed") return;
    const snapshot = exportSnapshotSchema.safeParse(approval.input);
    if (snapshot.success && !this.staging.markAllowed(snapshot.data, approval.id)) log(`export approval ${approval.id} no longer matches a staged file`);
  }

  noteClosed(approval: Approval): void {
    if (approval.toolName !== EXPORT_TOOL || (approval.status !== "denied" && approval.status !== "expired")) return;
    const snapshot = exportSnapshotSchema.safeParse(approval.input);
    if (snapshot.success) this.quietly(`export approval ${approval.id}`, () => this.staging.revokeStaged(snapshot.data));
  }

  forgetAgent(agentId: string): void {
    this.staging.revokeAgent(agentId);
  }

  forgetLease(lease: LeaseRef): void {
    this.quietly(`lease ${lease.id}`, () => this.staging.revokeLease(lease.computerId, lease.id));
  }

  // These run inside approval and lease hooks, which must finish even when the staging folder is unusable.
  private quietly(what: string, work: () => void): void {
    try {
      work();
    } catch (error) {
      log(`staged exports of ${what} weren't dropped: ${String(error)}`);
    }
  }

  clear(): void {
    this.staging.clear();
  }

  async exportFile(agentId: string, path: string, context: ComputerExportContext, scope: ExportScope, ask: (snapshot: ExportSnapshot) => string): Promise<{ approvalId: string } | ExportResult> {
    const source = containerPath(path);
    try {
      return await this.staging.consume(agentId, context, source, scope.current());
    } catch (error) {
      if (!(error instanceof ExportError) || error.reason !== "stale") throw error;
    }
    const snapshot = await this.staging.stage(agentId, context, source, scope.exec, scope.current);
    return { approvalId: ask(snapshot) };
  }
}
