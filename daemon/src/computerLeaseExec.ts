import { UUID } from "./computerArgs.ts";
import { log } from "./log.ts";

export const LEASE_ENV = "HIVE_LEASE";

// Each lease command gets its own session under setsid, so a release can kill what it left behind.
// timeout(1) moves into its own process group but stays in the session; the environment marker also
// catches children that started a session of their own.
const START_SCRIPT = [
  'd="/tmp/.hive-leases/$1"',
  'mkdir -p /tmp/.hive-leases && mkdir -p -m 700 "$d" || exit 125',
  'export HIVE_LEASE="$1"',
  "shift",
  `exec setsid -w sh -c 'echo "$$" > "$0/$$" || exit 125; exec "$@"' "$d" "$@"`,
].join("\n");

const KILL_SCRIPT = [
  'd="/tmp/.hive-leases/$1"',
  'for f in "$d"/*; do',
  '  [ -f "$f" ] || continue',
  '  s=$(head -c 16 -- "$f")',
  '  case "$s" in ""|0|*[!0-9]*) continue ;; esac',
  '  pkill -KILL -s "$s" 2>/dev/null',
  "done",
  "for p in /proc/[0-9]*; do",
  '  [ "${p#/proc/}" = "$$" ] && continue',
  '  if { tr "\\000" "\\n" < "$p/environ"; } 2>/dev/null | grep -qx "HIVE_LEASE=$1"; then kill -KILL "${p#/proc/}" 2>/dev/null; fi',
  "done",
  'rm -rf -- "$d"',
  "exit 0",
].join("\n");

function checkedLease(leaseId: string): string {
  if (!UUID.test(leaseId)) throw new Error(`not a lease id: ${leaseId}`);
  return leaseId;
}

export function leaseCommand(leaseId: string, command: readonly string[]): string[] {
  return ["sh", "-c", START_SCRIPT, "hive-lease", checkedLease(leaseId), ...command];
}

export function leaseKillCommand(leaseId: string): string[] {
  return ["sh", "-c", KILL_SCRIPT, "hive-lease-kill", checkedLease(leaseId)];
}

export interface LeaseRef {
  id: string;
  computerId: string;
}

export interface LeaseGuest {
  kill(computerId: string, leaseId: string): Promise<boolean>;
  stop(computerId: string): Promise<void>;
}

interface Flight {
  count: number;
  idle: Array<() => void>;
}

const SETTLE_MS = 10_000;

export class GuestLeases {
  private readonly flights = new Map<string, Flight>();
  private readonly used = new Set<string>();
  private readonly kills = new Map<string, Promise<void>>();
  private readonly guest: LeaseGuest;
  private readonly settleMs: number;

  constructor(guest: LeaseGuest, settleMs: number = SETTLE_MS) {
    this.guest = guest;
    this.settleMs = settleMs;
  }

  begin(leaseId: string): () => void {
    this.used.add(leaseId);
    const flight = this.flights.get(leaseId) ?? { count: 0, idle: [] };
    flight.count += 1;
    this.flights.set(leaseId, flight);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      flight.count -= 1;
      if (flight.count > 0) return;
      this.flights.delete(leaseId);
      for (const resolve of flight.idle) resolve();
    };
  }

  revoke(lease: LeaseRef): void {
    if (!this.used.has(lease.id) || this.kills.has(lease.id)) return;
    this.kills.set(lease.id, this.sweep(lease));
  }

  drain(lease: LeaseRef): Promise<void> | null {
    if (!this.used.has(lease.id) && !this.flights.has(lease.id)) return null;
    return this.drainFully(lease).finally(() => {
      this.used.delete(lease.id);
      this.kills.delete(lease.id);
    });
  }

  private async drainFully(lease: LeaseRef): Promise<void> {
    await this.kills.get(lease.id);
    const busy = this.flights.has(lease.id);
    await this.sweep(lease);
    if (!busy) return;
    if (!(await this.settled(lease.id))) {
      log(`computer ${lease.computerId}: calls of an ended lease didn't settle, so the computer is stopped`);
      await this.stopQuietly(lease.computerId);
      await this.settled(lease.id);
    }
    await this.sweep(lease);
  }

  private async sweep(lease: LeaseRef): Promise<void> {
    const killed = await this.guest.kill(lease.computerId, lease.id).catch(() => false);
    if (killed) return;
    log(`computer ${lease.computerId}: an ended lease's commands couldn't be killed, so the computer is stopped`);
    await this.stopQuietly(lease.computerId);
  }

  private async stopQuietly(computerId: string): Promise<void> {
    try {
      await this.guest.stop(computerId);
    } catch (error) {
      log(`computer ${computerId} didn't stop after a lease ended: ${String(error)}`);
    }
  }

  private settled(leaseId: string): Promise<boolean> {
    const flight = this.flights.get(leaseId);
    if (!flight) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), this.settleMs).unref();
      flight.idle.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
