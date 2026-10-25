import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join, posix } from "node:path";
import type { ComputerExportContext } from "./computerService.ts";
import type { CommandResult, RunOptions } from "./docker.ts";
import { containerPath, ExportError, writeExportData } from "./export.ts";
import {
  blobPath, clearStageDirectory, exportSnapshotSchema, parseArchive, privateDirectory, readRecord, recordPath, replaceRecord, STAGE_SCHEMA,
  writeExclusive, type ExportSnapshot, type StageRecord,
} from "./exportStagingFiles.ts";
import { dataDir } from "./paths.ts";

export { exportSnapshotSchema, type ExportSnapshot } from "./exportStagingFiles.ts";

export type GuestExec = (command: readonly string[], options: Pick<RunOptions, "maxStdoutBytes" | "timeoutMs">) => Promise<CommandResult>;

export interface ExportStagingOptions {
  stageRoot?: string;
  downloadsRoot?: string;
  now?: () => number;
  pendingTtlMs?: number;
  allowedTtlMs?: number;
  fileLimitBytes?: number;
  agentLimitBytes?: number;
  totalLimitBytes?: number;
}

const PENDING_TTL_MS = 30 * 60_000;
const ALLOWED_TTL_MS = 5 * 60_000;
const FILE_LIMIT_BYTES = 100 * 1024 * 1024;
const AGENT_LIMIT_BYTES = FILE_LIMIT_BYTES;
const TOTAL_LIMIT_BYTES = 200 * 1024 * 1024;
const TAR_OVERHEAD_BYTES = 1024 * 1024;
const STAGE_DIRECTORY = ".computer-exports";

function snapshotOf(record: StageRecord): ExportSnapshot {
  return exportSnapshotSchema.parse({
    stagedExportId: record.stagedExportId,
    computerId: record.computerId,
    computerRevision: record.computerRevision,
    computerLeaseId: record.computerLeaseId,
    path: record.path,
    filename: record.filename,
    size: record.size,
    sha256: record.sha256,
  });
}

function matches(record: StageRecord, snapshot: ExportSnapshot): boolean {
  return record.stagedExportId === snapshot.stagedExportId && record.computerId === snapshot.computerId &&
    record.computerRevision === snapshot.computerRevision && record.computerLeaseId === snapshot.computerLeaseId &&
    record.path === snapshot.path && record.filename === snapshot.filename && record.size === snapshot.size && record.sha256 === snapshot.sha256;
}

export class ExportStaging {
  private readonly options: ExportStagingOptions;
  private readonly now: () => number;
  private readonly reservations = new Map<string, { agentId: string; bytes: number }>();

  constructor(options: ExportStagingOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async stage(agentId: string, context: ComputerExportContext, inputPath: string, exec: GuestExec, isLeaseCurrent: () => boolean): Promise<ExportSnapshot> {
    if (!this.isUuid(agentId) || !this.isUuid(context.computerId) || !this.isUuid(context.computerLeaseId)) throw new ExportError("invalid-path", "export context is invalid");
    if (!isLeaseCurrent()) throw new ExportError("stale", "the computer assignment or run lease changed");
    const source = containerPath(inputPath);
    const root = this.root();
    const existing = this.records(root).find((record) => record.computerId === context.computerId && record.computerLeaseId === context.computerLeaseId);
    if (existing) {
      if (existing.agentId !== agentId || existing.path !== source || existing.computerRevision !== context.computerRevision) throw new ExportError("quota", "this computer lease already has a different pending export");
      if (existing.expiresAt <= this.now()) throw new ExportError("expired", "the staged export has expired");
      return snapshotOf(existing);
    }
    const limit = this.options.fileLimitBytes ?? FILE_LIMIT_BYTES;
    this.reserve(root, agentId, `${context.computerId}:${context.computerLeaseId}`, limit);
    try {
      const result = await exec(["/bin/tar", "-cf", "-", "-C", posix.dirname(source), "--", posix.basename(source)], {
        maxStdoutBytes: limit + TAR_OVERHEAD_BYTES,
        timeoutMs: 300_000,
      });
      if (result.overflowed) throw new ExportError("too-large", "the file is larger than the export limit");
      if (result.code !== 0) throw new ExportError("docker", `copy failed: ${result.stderr.trim().split("\n").pop() ?? "docker failed"}`);
      const file = parseArchive(result.stdout, limit);
      if (!isLeaseCurrent()) throw new ExportError("stale", "the computer assignment or run lease changed while staging");
      const id = randomUUID();
      const now = this.now();
      const record = STAGE_SCHEMA.parse({
        stagedExportId: id, agentId, computerId: context.computerId, computerRevision: context.computerRevision,
        computerLeaseId: context.computerLeaseId, path: source, filename: file.filename, size: file.data.length,
        sha256: createHash("sha256").update(file.data).digest("hex"), createdAt: now,
        expiresAt: now + (this.options.pendingTtlMs ?? PENDING_TTL_MS), status: "pending", approvalId: null, allowedUntil: null,
      });
      writeExclusive(blobPath(root, id), file.data, 0o600);
      try {
        replaceRecord(root, record);
      } catch (error) {
        unlinkSync(blobPath(root, id));
        throw error;
      }
      return snapshotOf(record);
    } finally {
      this.reservations.delete(`${context.computerId}:${context.computerLeaseId}`);
    }
  }

  markAllowed(snapshot: ExportSnapshot, approvalId: string): boolean {
    const root = this.root();
    const record = readRecord(recordPath(root, snapshot.stagedExportId));
    if (!record || record.expiresAt <= this.now() || !matches(record, snapshot) || record.status !== "pending" || !this.isUuid(approvalId)) return false;
    const allowed = STAGE_SCHEMA.parse({
      ...record, status: "allowed", approvalId, allowedUntil: this.now() + (this.options.allowedTtlMs ?? ALLOWED_TTL_MS),
    });
    replaceRecord(root, allowed);
    return true;
  }

  async consume(agentId: string, context: ComputerExportContext, path: string, isLeaseCurrent: boolean): Promise<{ path: string; bytes: number }> {
    if (!isLeaseCurrent) throw new ExportError("stale", "the computer assignment or run lease changed; request a new export approval");
    const source = containerPath(path);
    const root = this.root();
    const record = this.records(root).find((entry) => entry.agentId === agentId && entry.computerId === context.computerId && entry.computerLeaseId === context.computerLeaseId && entry.path === source);
    if (!record || record.status !== "allowed" || record.allowedUntil === null || record.allowedUntil <= this.now()) {
      throw new ExportError("stale", "there is no current approval for this staged file");
    }
    if (record.computerRevision !== context.computerRevision || !existsSync(blobPath(root, record.stagedExportId))) {
      throw new ExportError("stale", "the staged export no longer matches this computer revision");
    }
    const sourceBlob = blobPath(root, record.stagedExportId);
    const blobStats = lstatSync(sourceBlob);
    if (blobStats.isSymbolicLink() || !blobStats.isFile()) throw new ExportError("stale", "the staged file isn't a regular file");
    const fd = openSync(sourceBlob, constants.O_RDONLY | constants.O_NOFOLLOW);
    let blob: Buffer;
    try {
      blob = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    const digest = createHash("sha256").update(blob).digest("hex");
    if (blob.length !== record.size || digest !== record.sha256) throw new ExportError("stale", "the staged file changed after approval");
    const claimedBlob = join(root, `${record.stagedExportId}.${randomUUID()}.claimed`);
    const claimedRecord = join(root, `${record.stagedExportId}.${randomUUID()}.claimed.json`);
    try {
      renameSync(sourceBlob, claimedBlob);
      renameSync(recordPath(root, record.stagedExportId), claimedRecord);
    } catch {
      if (existsSync(claimedBlob)) renameSync(claimedBlob, sourceBlob);
      throw new ExportError("stale", "the staged export was already consumed or revoked");
    }
    try {
      return await writeExportData(agentId, record.filename, blob, this.options.downloadsRoot);
    } finally {
      for (const path of [claimedBlob, claimedRecord]) if (existsSync(path)) unlinkSync(path);
    }
  }

  revoke(approvalId: string): void {
    const root = this.root();
    const record = this.records(root).find((entry) => entry.approvalId === approvalId);
    if (record) this.remove(root, record.stagedExportId);
  }

  revokeAgent(agentId: string): void {
    const root = this.root();
    for (const record of this.records(root)) if (record.agentId === agentId) this.remove(root, record.stagedExportId);
  }

  revokeLease(computerId: string, leaseId: string): void {
    const root = this.root();
    for (const record of this.records(root)) {
      if (record.computerId === computerId && record.computerLeaseId === leaseId) this.remove(root, record.stagedExportId);
    }
  }

  revokeStaged(snapshot: ExportSnapshot): void {
    const root = this.root();
    const record = readRecord(recordPath(root, snapshot.stagedExportId));
    if (record && matches(record, snapshot)) this.remove(root, record.stagedExportId);
  }

  clear(): void {
    clearStageDirectory(this.root());
  }

  private root(): string {
    const root = this.options.stageRoot ?? join(dataDir, STAGE_DIRECTORY);
    privateDirectory(root);
    return root;
  }

  private records(root: string): StageRecord[] {
    const records: StageRecord[] = [];
    for (const file of readdirSync(root)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      const record = readRecord(join(root, file));
      if (record === null) throw new ExportError("destination", "a staged export record is invalid; cleanup was refused");
      if (record.expiresAt <= this.now() || (record.status === "allowed" && (record.allowedUntil ?? 0) <= this.now())) {
        this.remove(root, record.stagedExportId);
      } else records.push(record);
    }
    return records;
  }

  private reserve(root: string, agentId: string, key: string, bytes: number): void {
    if (this.reservations.has(key)) throw new ExportError("quota", "this computer lease already has an export being staged");
    const held = [...this.records(root), ...this.reservations.values()].map((entry) => ({ agentId: entry.agentId, bytes: "size" in entry ? entry.size : entry.bytes }));
    const sum = (entries: typeof held) => entries.reduce((total, entry) => total + entry.bytes, 0);
    if (sum(held.filter((entry) => entry.agentId === agentId)) + bytes > (this.options.agentLimitBytes ?? AGENT_LIMIT_BYTES)) {
      throw new ExportError("quota", "this agent's pending exports have reached its private storage limit");
    }
    if (sum(held) + bytes > (this.options.totalLimitBytes ?? TOTAL_LIMIT_BYTES)) throw new ExportError("quota", "pending exports have reached the private storage limit");
    this.reservations.set(key, { agentId, bytes });
  }

  private remove(root: string, id: string): void {
    for (const path of [blobPath(root, id), recordPath(root, id)]) if (existsSync(path)) unlinkSync(path);
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  }
}
