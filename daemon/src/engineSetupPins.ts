import { basename } from "node:path";
import { PROVIDERS, type ProviderId, type ProviderSpec } from "./engineSocket.ts";

export type Arch = "arm64" | "amd64";

export interface SetupPin {
  spec: ProviderSpec;
  appName: string;
  urls: Readonly<Record<Arch, string>>;
  hosts: readonly string[];
}

// Download origins were measured against the vendors' real downloads (docs/PLAN.md, Engines, "Facts measured").
const RAW_PINS: Readonly<Record<ProviderId, Omit<SetupPin, "spec">>> = {
  orbstack: {
    appName: "OrbStack.app",
    urls: { arm64: "https://orbstack.dev/download/stable/latest/arm64", amd64: "https://orbstack.dev/download/stable/latest/amd64" },
    hosts: ["orbstack.dev", "cdn-updates.orbstack.dev"],
  },
  "docker-desktop": {
    appName: "Docker.app",
    urls: { arm64: "https://desktop.docker.com/mac/main/arm64/Docker.dmg", amd64: "https://desktop.docker.com/mac/main/amd64/Docker.dmg" },
    hosts: ["desktop.docker.com"],
  },
};

export const SETUP_ORDER: readonly ProviderId[] = ["orbstack", "docker-desktop"];

export const LIMITS = {
  maxRedirects: 3,
  maxDownloadBytes: 1.5 * 1024 ** 3,
  idleMs: 60_000,
  totalMs: 45 * 60_000,
  minFreeBytes: 15 * 1024 ** 3,
  maxBundleBytes: 4 * 1024 ** 3,
  startWaitMs: 10 * 60_000,
  pollMs: 3000,
  minMacos: [14] as const,
};

export const TOOLS = {
  hdiutil: "/usr/bin/hdiutil", codesign: "/usr/bin/codesign", spctl: "/usr/sbin/spctl", ditto: "/usr/bin/ditto",
  xattr: "/usr/bin/xattr", plutil: "/usr/bin/plutil", open: "/usr/bin/open", swVers: "/usr/bin/sw_vers", sysctl: "/usr/sbin/sysctl",
} as const;

/** A failure the owner can read; its message becomes the status detail. */
export class SetupError extends Error {}

export class SetupCancelled extends Error {}

export class SetupRefused extends Error {}

/** The pin for a provider; an inconsistent pin is refused rather than used. */
export function pinFor(id: ProviderId): SetupPin {
  const spec = PROVIDERS[id];
  const raw = RAW_PINS[id];
  const consistent = basename(spec.appPath) === raw.appName && Object.values(raw.urls).every((url) => {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.port === "" && raw.hosts.includes(parsed.hostname);
  });
  if (!consistent) throw new SetupError(`Hive's download pins for ${spec.name} don't agree with each other, so it won't set it up.`);
  return { spec, ...raw };
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
export const DETAIL_LIMIT = 300;

export function cleanDetail(text: string): string {
  return text.replace(ANSI, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, DETAIL_LIMIT);
}

// Setup folders carry this Hive's instance tag, so a second daemon's start-up cleanup never removes a running setup's files.
export const tempPrefix = (tag: string): string => `run-${tag}-`;
export const stagingPrefix = (tag: string): string => `.hive-setup-${tag}-`;
