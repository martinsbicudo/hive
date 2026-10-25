import { z } from "zod";

export const computerRuntime = z.enum(["docker"]);
export const computerProfile = z.enum(["terminal", "browser", "desktop"]);

const runtimeInfo = z.object({
  runtime: computerRuntime,
  provider: z.string(),
  status: z.enum(["missing", "stopped", "unsupported", "ready", "check-failed"]),
  version: z.string().nullable(),
  detail: z.string(),
  capabilities: z.object({
    profiles: z.array(computerProfile),
    persistentHome: z.boolean(),
    networkGuard: z.enum(["attested", "not-attested", "not-supported"]),
  }).strict(),
}).strict();

const profileInfo = z.object({
  id: computerProfile,
  name: z.string(),
  description: z.string(),
  browser: z.boolean(),
  hasScreen: z.boolean(),
  fullDesktop: z.boolean(),
}).strict();

const guide = z.object({
  runtime: computerRuntime,
  provider: z.string(),
  installUrl: z.string().url(),
  setupUrl: z.string().url(),
  host: z.literal("macos"),
  requirement: z.string(),
  maturity: z.enum(["supported", "candidate", "blocked"]),
}).strict();

export const runtimeCapabilities = z.object({
  runtimes: z.array(runtimeInfo),
  profiles: z.array(profileInfo),
  guides: z.array(guide),
}).strict();

export type ComputerRuntime = z.infer<typeof computerRuntime>;
export type ComputerProfile = z.infer<typeof computerProfile>;
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilities>;
