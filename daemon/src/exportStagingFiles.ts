import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ExportError } from "./export.ts";
import { singleFileFromTar, TarError, TarTooLargeError } from "./tar.ts";

export const STAGE_SCHEMA = z.object({
  stagedExportId: z.string().uuid(),
  agentId: z.string().uuid(),
  computerId: z.string().uuid(),
  computerRevision: z.number().int().positive(),
  computerLeaseId: z.string().uuid(),
  path: z.string().min(1).max(1024),
  filename: z.string().min(1).max(200),
  size: z.number().int().nonnegative().max(100 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  status: z.enum(["pending", "allowed"]),
  approvalId: z.string().uuid().nullable(),
  allowedUntil: z.number().int().positive().nullable(),
}).strict();

export const exportSnapshotSchema = STAGE_SCHEMA.pick({
  stagedExportId: true,
  computerId: true,
  computerRevision: true,
  computerLeaseId: true,
  path: true,
  filename: true,
  size: true,
  sha256: true,
}).strict();

export type ExportSnapshot = z.infer<typeof exportSnapshotSchema>;
export type StageRecord = z.infer<typeof STAGE_SCHEMA>;

const STAGED_FILE = /^[0-9a-f-]{36}(?:\.json|\.blob|\.[0-9a-f-]{36}\.(?:tmp|claimed|claimed\.json))$/;

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new ExportError("destination", "the private export folder isn't a plain directory");
  chmodSync(path, 0o700);
}

export function recordPath(root: string, id: string): string {
  return join(root, `${id}.json`);
}

export function blobPath(root: string, id: string): string {
  return join(root, `${id}.blob`);
}

export function writeExclusive(path: string, data: Buffer, mode: number): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const fd = openSync(path, flags, mode);
  try {
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function replaceRecord(root: string, record: StageRecord): void {
  const temp = join(root, `${record.stagedExportId}.${randomUUID()}.tmp`);
  try {
    writeExclusive(temp, Buffer.from(JSON.stringify(record)), 0o600);
    renameSync(temp, recordPath(root, record.stagedExportId));
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

export function readRecord(path: string): StageRecord | null {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) return null;
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const result = STAGE_SCHEMA.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseArchive(bytes: Buffer, limit: number): { filename: string; data: Buffer } {
  try {
    const parsed = singleFileFromTar(bytes, limit);
    return { filename: parsed.name, data: parsed.data };
  } catch (error) {
    if (error instanceof TarTooLargeError) throw new ExportError("too-large", "the file is larger than the export limit");
    if (error instanceof TarError) throw new ExportError("not-a-file", `only a single regular file can be exported (${error.message})`);
    throw error;
  }
}

export function clearStageDirectory(root: string): void {
  for (const name of readdirSync(root)) {
    if (!STAGED_FILE.test(name)) continue;
    const path = join(root, name);
    const stats = lstatSync(path);
    if (stats.isFile() || stats.isSymbolicLink()) unlinkSync(path);
  }
}
