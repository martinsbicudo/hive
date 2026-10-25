import { z } from "zod";
import { AVATAR_STYLES } from "./avatars.ts";
import { dailyBudgetInput } from "./budgets.ts";
import { MODEL_CHOICES } from "./models.ts";
import { CONNECTORS, ENGINES, type ComputerMode, type Connector, type Engine, type PermissionMode } from "./types.ts";

export const MAX_NAME = 40;
export const MAX_ROLE = 60;
export const MAX_INSTRUCTIONS = 8000;

export class ValidationError extends Error {}

export function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${field} is longer than ${max} characters`);
  return trimmed;
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ValidationError(`${field} must be true or false`);
  return value;
}

export function parseEngine(value: unknown): Engine | undefined {
  if (value === undefined) return undefined;
  if (value === "claude-code" || value === "codex") return value;
  throw new ValidationError("engine must be claude-code or codex");
}

export function parsePermissionMode(value: unknown): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (value === "ask" || value === "accept-edits") return value;
  throw new ValidationError("permissionMode must be ask or accept-edits");
}

export function parseModel(value: unknown, engine: Engine): string | undefined {
  const model = optionalString(value, "model", 60);
  if (model === undefined || model === "") return undefined;
  if (!MODEL_CHOICES[engine].includes(model)) throw new ValidationError(`model ${model} isn't available for ${engine}`);
  return model;
}

export function parseAvatarStyle(value: unknown): string | undefined {
  const style = optionalString(value, "avatarStyle", 40);
  if (style === undefined || style === "") return undefined;
  if (!AVATAR_STYLES.includes(style)) throw new ValidationError(`unknown avatar style ${style}`);
  return style;
}

const AVATAR_SEED = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,79}$/u;

export function parseAvatarSeed(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !AVATAR_SEED.test(value)) throw new ValidationError("avatarSeed must be 1 to 80 letters, digits, spaces or . _ ' -");
  return value;
}

export function parseFolders(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.startsWith("/"))) {
    throw new ValidationError("folders must be a list of absolute paths");
  }
  return value.filter((item): item is string => typeof item === "string");
}

export const COMPUTER_MODES = ["mac", "virtual"] as const;

const placement = z
  .object({ engine: z.enum(ENGINES), computer: z.enum(COMPUTER_MODES), connectors: z.array(z.enum(CONNECTORS)) })
  .refine((value) => value.computer === "mac" || value.engine === "claude-code", { message: "a virtual computer works with Claude Code only" })
  .refine((value) => value.computer === "mac" || value.connectors.length === 0, { message: "connectors aren't available on a virtual computer; clear them first" })
  .refine((value) => value.engine === "claude-code" || value.connectors.length === 0, { message: "connectors work with Claude Code only; clear them first" });

const connectorsInput = z.array(z.enum(CONNECTORS)).max(CONNECTORS.length * 4);

export function parseConnectors(value: unknown): Connector[] | undefined {
  if (value === undefined) return undefined;
  const parsed = connectorsInput.safeParse(value);
  if (!parsed.success) throw new ValidationError(`connectors must be a list of ${CONNECTORS.join(", ")}`);
  return CONNECTORS.filter((connector) => parsed.data.includes(connector));
}

export function parseComputer(value: unknown): ComputerMode | undefined {
  if (value === undefined) return undefined;
  const parsed = z.enum(COMPUTER_MODES).safeParse(value);
  if (!parsed.success) throw new ValidationError("computer must be mac or virtual");
  return parsed.data;
}

export function parseDailyBudget(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  const parsed = dailyBudgetInput.safeParse(value);
  if (!parsed.success) throw new ValidationError("dailyBudget must be a whole number of USD cents (tokens for Codex) or null");
  return parsed.data;
}

export function checkPlacement(engine: Engine, computer: ComputerMode, connectors: readonly Connector[]): void {
  const result = placement.safeParse({ engine, computer, connectors });
  if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? "invalid computer setting");
}
