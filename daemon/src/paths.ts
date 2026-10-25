import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UUID } from "./computerArgs.ts";

export const DEFAULT_PORT = 47321;

export const dataDir = process.env.HIVE_HOME ?? join(homedir(), ".hive");
export const agentsDir = join(dataDir, "agents");
export const runtimeDir = join(dataDir, "runtime");
export const dbPath = join(dataDir, "hive.db");
export const tokenPath = join(dataDir, "token");
export const logPath = join(dataDir, "hive.log");
export const instanceIdPath = join(dataDir, "instance-id");

export function ensureDirs(): void {
  for (const dir of [dataDir, agentsDir, runtimeDir]) mkdirSync(dir, { recursive: true });
}

export function agentWorkspacePath(agentId: string): string {
  return join(agentsDir, agentId, "workspace");
}

export function agentWorkspace(agentId: string): string {
  const dir = agentWorkspacePath(agentId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadOrCreateToken(): string {
  ensureDirs();
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return token;
}

export function loadOrCreateInstanceId(path: string = instanceIdPath): string {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (UUID.test(existing)) return existing;
    throw new Error(`${path} doesn't hold a Hive instance id, so Hive won't guess which computers are its own`);
  }
  const id = randomUUID();
  try {
    writeFileSync(path, id + "\n", { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return loadOrCreateInstanceId(path);
    throw error;
  }
  chmodSync(path, 0o600);
  return id;
}

export function removeMcpConfig(agentId: string): void {
  rmSync(join(runtimeDir, `${agentId}.mcp.json`), { force: true });
}
