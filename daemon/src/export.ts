import { execFile } from "node:child_process";
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";

export type ExportFailure = "invalid-path" | "docker" | "too-large" | "not-a-file" | "destination" | "quota" | "expired" | "stale";

export class ExportError extends Error {
  readonly reason: ExportFailure;

  constructor(reason: ExportFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface ExportResult {
  path: string;
  bytes: number;
}

const HOME = "/home/agent";
const WORKSPACE = "/home/agent/workspace";
const MAX_NAME_CHARS = 120;
const MAX_NAME_BYTES = 200;
const MAX_COPIES = 99;
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩/:]/g;

const execFileAsync = promisify(execFile);

export function containerPath(input: string): string {
  if (!input || /[\u0000-\u001f\u007f]/.test(input)) throw new ExportError("invalid-path", "the path is empty or has control characters");
  const resolved = posix.normalize(input.startsWith("/") ? input : posix.join(WORKSPACE, input));
  if (!resolved.startsWith(`${HOME}/`) || resolved.endsWith("/")) {
    throw new ExportError("invalid-path", `only files under ${HOME}/ can be exported`);
  }
  return resolved;
}

export function sanitizedName(entryName: string): string {
  const base = entryName.split("/").filter(Boolean).pop() ?? "";
  const cleaned = base.replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim().replace(/^[.\s-]+/, "");
  const chars = Array.from(cleaned).slice(0, MAX_NAME_CHARS);
  while (Buffer.byteLength(chars.join("")) > MAX_NAME_BYTES) chars.pop();
  const name = chars.join("").trim();
  return name || "export";
}

function candidateName(name: string, copy: number): string {
  if (copy === 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${copy})${name.slice(dot)}` : `${name} (${copy})`;
}

function ensureRealDirectory(directory: string): void {
  try {
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ExportError("destination", `${directory} is not a plain folder, so nothing was written`);
  }
}

function writeExclusive(directory: string, name: string, data: Buffer): string {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  for (let copy = 1; copy <= MAX_COPIES; copy++) {
    const path = join(directory, candidateName(name, copy));
    let fd: number;
    try {
      fd = openSync(path, flags, 0o644);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
    try {
      fchmodSync(fd, 0o644);
      let written = 0;
      while (written < data.length) written += writeSync(fd, data, written);
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      unlinkSync(path);
      throw error;
    }
    closeSync(fd);
    return path;
  }
  throw new ExportError("destination", `too many files named ${name} already exist`);
}

async function quarantine(path: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};Hive;`;
  await execFileAsync("/usr/bin/xattr", ["-w", "com.apple.quarantine", value, path]);
}

export async function writeExportData(agentId: string, entryName: string, data: Buffer, downloadsRoot?: string): Promise<ExportResult> {
  const root = downloadsRoot ?? join(homedir(), "Downloads", "Hive");
  mkdirSync(dirname(root), { recursive: true });
  ensureRealDirectory(root);
  const directory = join(root, agentId);
  ensureRealDirectory(directory);
  const written = writeExclusive(directory, sanitizedName(entryName), data);
  try {
    await quarantine(written);
  } catch (error) {
    unlinkSync(written);
    throw error;
  }
  return { path: written, bytes: data.length };
}
