import { z } from "zod";
import type { EngineVerdict } from "./engineAttest.ts";

export const COMPUTER_RUNTIMES = ["docker"] as const;
export const COMPUTER_PROFILES = ["terminal", "browser", "desktop"] as const;

export const computerRuntimeSchema = z.enum(COMPUTER_RUNTIMES);
export const computerProfileSchema = z.enum(COMPUTER_PROFILES);

export const computerProfileSchemaInfo = z.object({
  id: computerProfileSchema,
  name: z.string(),
  description: z.string(),
  browser: z.boolean(),
  hasScreen: z.boolean(),
  fullDesktop: z.boolean(),
}).strict();

export const COMPUTER_PROFILE_INFO = [
  { id: "terminal", name: "Terminal", description: "A small Linux shell for command-line work.", browser: false, hasScreen: false, fullDesktop: false },
  { id: "browser", name: "Browser", description: "Chromium in an Openbox desktop with a screen you can watch.", browser: true, hasScreen: true, fullDesktop: false },
  { id: "desktop", name: "Desktop", description: "Chromium in a full XFCE desktop with a screen you can watch.", browser: true, hasScreen: true, fullDesktop: true },
] as const satisfies readonly z.infer<typeof computerProfileSchemaInfo>[];

export const runtimeStatusSchema = z.enum(["missing", "stopped", "unsupported", "ready", "check-failed"]);

export const runtimeCapabilitySchema = z.object({
  runtime: computerRuntimeSchema,
  provider: z.string(),
  status: runtimeStatusSchema,
  version: z.string().nullable(),
  detail: z.string(),
  capabilities: z.object({
  profiles: z.array(computerProfileSchema).max(COMPUTER_PROFILES.length),
    persistentHome: z.boolean(),
    networkGuard: z.enum(["attested", "not-attested", "not-supported"]),
  }).strict(),
}).strict();

export const runtimeGuideSchema = z.object({
  runtime: computerRuntimeSchema,
  provider: z.string(),
  installUrl: z.string().url(),
  setupUrl: z.string().url(),
  host: z.enum(["macos"]),
  requirement: z.string(),
  maturity: z.enum(["supported", "candidate", "blocked"]),
}).strict();

export const runtimeInfoSchema = z.object({
  runtimes: z.array(runtimeCapabilitySchema),
  profiles: z.array(computerProfileSchemaInfo),
  guides: z.array(runtimeGuideSchema),
}).strict();

export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>;

export const RUNTIME_INSTALL_GUIDES = [
  { runtime: "docker", provider: "OrbStack", installUrl: "https://orbstack.dev/download", setupUrl: "https://docs.orbstack.dev/quick-start", host: "macos", requirement: "OrbStack 2.2.5 or newer, from Orbital Labs. Light on memory and battery.", maturity: "supported" },
  { runtime: "docker", provider: "Docker Desktop", installUrl: "https://docs.docker.com/desktop/setup/install/mac-install/", setupUrl: "https://docs.docker.com/desktop/setup/install/mac-install/", host: "macos", requirement: "Docker Desktop 4.44.3 or newer, from Docker Inc.", maturity: "supported" },
] as const satisfies readonly z.infer<typeof runtimeGuideSchema>[];

export interface RuntimeDiscoveryOptions {
  active: () => Promise<EngineVerdict>;
}

function runtimeCapability(
  provider: string,
  status: z.infer<typeof runtimeStatusSchema>,
  version: string | null,
  detail: string,
  persistentHome = false,
  networkGuard: "attested" | "not-attested" | "not-supported" = "not-supported",
  supportedProfiles: readonly ("terminal" | "browser" | "desktop")[] = [],
): z.infer<typeof runtimeCapabilitySchema> {
  return runtimeCapabilitySchema.parse({
    runtime: "docker", provider, status, version, detail,
    capabilities: { profiles: supportedProfiles, persistentHome, networkGuard },
  });
}

export function runtimeFromVerdict(verdict: EngineVerdict): z.infer<typeof runtimeCapabilitySchema> {
  if (verdict.status === "ready") {
    const { name, version } = verdict.engine;
    return runtimeCapability(name, "ready", version, `${name} is running and verified; each computer checks its firewall before the guest starts.`, true, "attested", COMPUTER_PROFILES);
  }
  const known = verdict.status === "stopped" || verdict.status === "unsupported";
  return runtimeCapability(verdict.provider, verdict.status, verdict.version, verdict.detail, known, known ? "not-attested" : "not-supported");
}

export async function discoverComputerRuntimes(options: RuntimeDiscoveryOptions): Promise<z.infer<typeof runtimeCapabilitySchema>[]> {
  return [runtimeFromVerdict(await options.active())];
}

export function runtimeGuidesForHost(hostPlatform: NodeJS.Platform = process.platform): z.infer<typeof runtimeGuideSchema>[] {
  if (hostPlatform !== "darwin") return [];
  return RUNTIME_INSTALL_GUIDES.map((guide) => runtimeGuideSchema.parse(guide));
}
