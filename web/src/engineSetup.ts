import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { request } from "./api.ts";

export const engineProvider = z.enum(["orbstack", "docker-desktop"]);

export const setupStatus = z.object({
  state: z.enum(["idle", "running", "done", "failed", "cancelled"]),
  provider: engineProvider.nullable(),
  action: z.enum(["install", "start"]).nullable(),
  step: z.enum(["check", "download", "verify", "install", "start", "images", "ready"]).nullable(),
  progress: z.number().min(0).max(1),
  detail: z.string(),
  cancellable: z.boolean(),
  providers: z.array(z.object({
    id: engineProvider,
    name: z.string(),
    installed: z.boolean(),
    running: z.boolean(),
    active: z.boolean(),
    recommended: z.boolean(),
  }).strict()),
}).strict();

export type EngineProvider = z.infer<typeof engineProvider>;
export type SetupStatus = z.infer<typeof setupStatus>;
export type ProviderInfo = SetupStatus["providers"][number];

export const setupApi = {
  status: () => request(setupStatus, "/api/computers/setup"),
  start: (provider: EngineProvider) => request(setupStatus, "/api/computers/setup", { method: "POST", body: JSON.stringify({ provider }) }),
  cancel: () => request(setupStatus, "/api/computers/setup", { method: "DELETE" }),
};

export const STEP_NAMES: Record<NonNullable<SetupStatus["step"]>, string> = {
  check: "Checking this Mac", download: "Downloading", verify: "Verifying the signature", install: "Installing",
  start: "Starting the engine", images: "Preparing Hive's images", ready: "Ready",
};

interface ProviderFacts {
  vendor: string;
  host: string;
  size: string;
  appName: string;
  firstRun: string;
}

// What each engine does on its own first start; Hive never answers these windows for the owner.
export const PROVIDER_FACTS: Record<EngineProvider, ProviderFacts> = {
  orbstack: {
    vendor: "Orbital Labs, LLC", host: "orbstack.dev", size: "about 470 MB", appName: "OrbStack.app",
    firstRun: "OrbStack opens its welcome window with its terms, may ask for your password to install its helper, adds a few lines to ~/.zprofile and ~/.ssh/config, makes itself Docker's selected context and may offer to migrate from Docker Desktop.",
  },
  "docker-desktop": {
    vendor: "Docker Inc", host: "desktop.docker.com", size: "about 600 MB", appName: "Docker.app",
    firstRun: "Docker Desktop shows its subscription terms, may ask for your password to install its helper and makes itself Docker's selected context (desktop-linux).",
  },
};

export function setupSteps(provider: ProviderInfo): string[] {
  const facts = PROVIDER_FACTS[provider.id];
  const prepare = ["Open it and wait for its engine to answer", "Prepare Hive's computer images"];
  if (provider.installed) return [`Check that /Applications/${facts.appName} is signed by ${facts.vendor}`, ...prepare];
  return [
    "Check this Mac: macOS 14 or newer and 15 GB free",
    `Download ${provider.name} (${facts.size}) from ${facts.host}`,
    `Verify it is signed and notarized for ${facts.vendor}`,
    `Copy it to /Applications/${facts.appName} (nothing is overwritten)`,
    ...prepare,
  ];
}

const POLL_MS = 1000;

/** Setup status, polled while a setup runs; `onSettled` fires once when a run ends. */
export function useEngineSetup(onSettled: () => void) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const settled = useRef(onSettled);
  const wasRunning = useRef(false);
  const load = useCallback(async () => {
    try { setStatus(await setupApi.status()); } catch { setStatus(null); }
  }, []);
  const running = status?.state === "running";
  useEffect(() => { settled.current = onSettled; }, [onSettled]);
  useEffect(() => {
    if (wasRunning.current && !running) settled.current();
    wasRunning.current = running;
    if (!running) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);
  return { status, setStatus, load };
}
