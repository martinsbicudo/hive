import { execFileSync } from "node:child_process";
import { linkSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HomeLockDeps {
  pid: number;
  alive: (pid: number) => boolean;
  /** When the process started, or null when that can't be read. */
  startOf: (pid: number) => string | null;
  sleep: (ms: number) => Promise<void>;
  waitMs: number;
}

type Holder = { pid: number; start: string } | "unreadable" | null;

const POLL_MS = 250;
const LOCK_FILE = "daemon.lock";

const UNKNOWN = "unknown";
// ps prints the start in the caller's time zone and language; fixing both makes every daemon read the same string.
const PS_ENV = { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" };

const codeOf = (error: unknown): unknown => error instanceof Error && "code" in error ? error.code : undefined;

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === "EPERM";
  }
}

export function processStart(pid: number): string | null {
  try {
    const start = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: PS_ENV, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return start || null;
  } catch {
    return null;
  }
}

function holderOf(path: string): Holder {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
  const [pidText = "", start = ""] = text.split("\n");
  const pid = Number(pidText);
  return Number.isInteger(pid) && pid > 0 && start ? { pid, start } : "unreadable";
}

// The lock is written to a private file first and then linked into place, so a reader never sees a half-written lock.
function tryClaim(path: string, content: string, pid: number): boolean {
  const temp = `${path}.${pid}`;
  writeFileSync(temp, content, { mode: 0o600 });
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if (codeOf(error) === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

// Stale only when the holder is surely gone: its pid is free, or that pid now started at another time. An unknown start
// (ps failed on either side) keeps the lock, so a live daemon is never taken over by mistake.
function isStale(holder: Holder, deps: HomeLockDeps): boolean {
  if (holder === null) return false;
  if (holder === "unreadable" || !deps.alive(holder.pid)) return true;
  const start = holder.start === UNKNOWN ? null : deps.startOf(holder.pid);
  return start !== null && start !== holder.start;
}

const sameHolder = (a: Holder, b: Holder): boolean =>
  a === b || (typeof a === "object" && a !== null && typeof b === "object" && b !== null && a.pid === b.pid && a.start === b.start);

function removeStale(path: string, stale: Holder): void {
  if (!sameHolder(holderOf(path), stale)) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}

/**
 * Claims the data folder for this daemon before it cleans up anything there. Start-up cleanup stops and removes
 * this Hive's containers, so a second daemon on the same folder would otherwise break the first one's computers.
 * A daemon still shutting down is waited for. The holder counts as alive only while its pid still has the start time
 * it recorded, so a lock left by a daemon that died is taken over even after its pid was reused.
 */
export async function claimHome(dir: string, deps: HomeLockDeps): Promise<boolean> {
  const path = join(dir, LOCK_FILE);
  const content = `${deps.pid}\n${deps.startOf(deps.pid) ?? UNKNOWN}`;
  for (let waited = 0; ; waited += POLL_MS) {
    if (tryClaim(path, content, deps.pid)) return true;
    const holder = holderOf(path);
    if (holder === null) continue;
    if (holder !== "unreadable" && holder.pid === deps.pid) return true;
    if (isStale(holder, deps)) {
      removeStale(path, holder);
      continue;
    }
    if (waited >= deps.waitMs) return false;
    await deps.sleep(POLL_MS);
  }
}

export function releaseHome(dir: string, pid: number): void {
  const path = join(dir, LOCK_FILE);
  const holder = holderOf(path);
  if (holder !== null && holder !== "unreadable" && holder.pid === pid) removeStale(path, holder);
}
