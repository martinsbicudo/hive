import { join } from "node:path";
import { z } from "zod";
import type { EngineBindings } from "./computerEngines.ts";
import type { ProviderId } from "./engineSocket.ts";
import { DETAIL_LIMIT, pinFor, SETUP_ORDER } from "./engineSetupPins.ts";
import { isRealDirectory } from "./engineVerify.ts";

export const SETUP_STATES = ["idle", "running", "done", "failed", "cancelled"] as const;
export const SETUP_PROVIDERS = ["orbstack", "docker-desktop"] as const;
export const SETUP_ACTIONS = ["install", "start"] as const;
export const SETUP_STEPS = ["check", "download", "verify", "install", "start", "images", "ready"] as const;

export const setupProviderSchema = z.enum(SETUP_PROVIDERS);
export type SetupAction = (typeof SETUP_ACTIONS)[number];
export type SetupStep = (typeof SETUP_STEPS)[number];

export const setupStatusSchema = z.object({
  state: z.enum(SETUP_STATES),
  provider: setupProviderSchema.nullable(),
  action: z.enum(SETUP_ACTIONS).nullable(),
  step: z.enum(SETUP_STEPS).nullable(),
  progress: z.number().min(0).max(1),
  detail: z.string().max(DETAIL_LIMIT),
  cancellable: z.boolean(),
  providers: z.array(z.object({
    id: setupProviderSchema,
    name: z.string(),
    installed: z.boolean(),
    running: z.boolean(),
    active: z.boolean(),
    recommended: z.boolean(),
  }).strict()),
}).strict();

export type SetupStatus = z.infer<typeof setupStatusSchema>;
export type SetupProviderStatus = SetupStatus["providers"][number];

export const setupRequestSchema = z.object({ provider: setupProviderSchema }).strict();

type WorkStep = Exclude<SetupStep, "ready">;

const WEIGHTS: Readonly<Record<WorkStep, number>> = { check: 0.02, download: 0.6, verify: 0.08, install: 0.05, start: 0.1, images: 0.15 };

const STEPS_FOR: Readonly<Record<SetupAction, readonly WorkStep[]>> = {
  install: ["check", "download", "verify", "install", "start", "images"],
  start: ["check", "start", "images"],
};

/** Overall progress over the action's own steps, so Start fills the bar too without skipped steps. */
export function overallProgress(action: SetupAction, step: SetupStep, fraction: number): number {
  if (step === "ready") return 1;
  const steps = STEPS_FOR[action];
  const total = steps.reduce((sum, item) => sum + WEIGHTS[item], 0);
  const index = steps.indexOf(step);
  if (index < 0) return 0;
  const before = steps.slice(0, index).reduce((sum, item) => sum + WEIGHTS[item], 0);
  const within = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return Math.min(1, (before + WEIGHTS[step] * within) / total);
}

export type ProviderChecks = Pick<EngineBindings, "active" | "present">;

/** Installed is a real app directory; running is an attested engine; active is the selected context's verdict. */
export async function providerStatuses(engines: ProviderChecks, applicationsDir: string): Promise<SetupProviderStatus[]> {
  const [active, present] = await Promise.all([
    engines.active().catch(() => null),
    engines.present().catch(() => []),
  ]);
  return SETUP_ORDER.map((id: ProviderId) => {
    const pin = pinFor(id);
    return {
      id,
      name: pin.spec.name,
      installed: isRealDirectory(join(applicationsDir, pin.appName)),
      running: present.some((engine) => engine.provider === id),
      active: active?.status === "ready" && active.engine.provider === id,
      recommended: id === "orbstack",
    };
  });
}
