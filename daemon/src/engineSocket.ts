import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ComputerEngine } from "./computerTypes.ts";

export type ProviderId = ComputerEngine;

export interface ProviderSpec {
  id: ProviderId;
  name: string;
  socket: string;
  appPath: string;
  appId: string;
  listenerId: string;
  team: string;
  floor: readonly [number, number, number];
}

// Team IDs and identifiers were read from the vendors' notarized DMGs and cross-checked (docs/PLAN.md, Engines).
export const PROVIDERS: Readonly<Record<ProviderId, ProviderSpec>> = {
  "docker-desktop": {
    id: "docker-desktop", name: "Docker Desktop", socket: ".docker/run/docker.sock", appPath: "/Applications/Docker.app",
    appId: "com.docker.docker", listenerId: "com.docker.docker", team: "9BNSXJN65R", floor: [4, 44, 3],
  },
  orbstack: {
    id: "orbstack", name: "OrbStack", socket: ".orbstack/run/docker.sock", appPath: "/Applications/OrbStack.app",
    appId: "dev.kdrag0n.MacVirt", listenerId: "dev.kdrag0n.MacVirt.vmgr", team: "HUAQ24HBR6", floor: [2, 2, 5],
  },
};

export type SocketResult =
  | { kind: "socket"; provider: ProviderSpec; path: string }
  | { kind: "absent"; provider: ProviderSpec | null }
  | { kind: "refused"; detail: string };

const SUPPORTED = "Hive supports Docker Desktop and OrbStack on this Mac's own socket; other Docker endpoints are refused.";

/** Resolves the endpoint's symlinks; only the current user's Docker Desktop or OrbStack socket is accepted. */
export function socketFor(endpoint: string, home = homedir(), uid = process.getuid?.() ?? -1): SocketResult {
  if (!endpoint.startsWith("unix:///")) return { kind: "refused", detail: SUPPORTED };
  const given = endpoint.slice("unix://".length);
  const known = Object.values(PROVIDERS).map((provider) => ({ provider, path: join(home, provider.socket) }));
  let real: string;
  try {
    real = realpathSync(given);
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    const direct = known.find((entry) => entry.path === given);
    return missing && (direct || given === "/var/run/docker.sock") ? { kind: "absent", provider: direct?.provider ?? null } : { kind: "refused", detail: SUPPORTED };
  }
  const match = known.find((entry) => entry.path === real);
  if (!match) return { kind: "refused", detail: SUPPORTED };
  const socket = lstatSync(real);
  const parent = lstatSync(dirname(real));
  if (!socket.isSocket() || socket.uid !== uid || parent.uid !== uid || (parent.mode & 0o022) !== 0) {
    return { kind: "refused", detail: `${match.provider.name}'s socket isn't owned and guarded by your user, so Hive won't use it.` };
  }
  return { kind: "socket", provider: match.provider, path: real };
}

export function atLeast(version: string, floor: readonly number[]): boolean {
  const parts = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!parts) return false;
  const numbers = parts.slice(1).map((part) => Number(part ?? 0));
  for (const [index, minimum] of floor.entries()) {
    const part = numbers[index] ?? 0;
    if (part !== minimum) return part > minimum;
  }
  return true;
}

/** The outermost `.app` bundle that contains a path, or null. */
export function outerApp(path: string): string | null {
  const index = path.indexOf(".app/");
  return index > 0 ? path.slice(0, index + 4) : path.endsWith(".app") ? path : null;
}
