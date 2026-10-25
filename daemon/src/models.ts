import type { Engine } from "./types.ts";

export const MODEL_CHOICES: Record<Engine, readonly string[]> = {
  "claude-code": ["auto", "haiku", "sonnet", "opus"],
  codex: ["auto"],
};

export type Effort = "light" | "standard" | "deep";

const DEEP_HINTS = [
  "review", "refactor", "architecture", "architect", "design", "plan", "debug", "investigate", "security",
  "migrate", "strategy", "analyze", "analyse", "revis", "arquitet", "planej", "investig", "estratég", "analis",
];
const LIGHT_HINTS = [
  "check", "any new", "status", "list", "remind", "summary of today", "verifica", "tem algo", "lista", "lembr",
];

const LONG_MESSAGE = 1200;
const SHORT_MESSAGE = 80;

export function effortFor(message: string): Effort {
  const lower = message.toLowerCase();
  if (message.length > LONG_MESSAGE || DEEP_HINTS.some((hint) => lower.includes(hint))) return "deep";
  if (message.length < SHORT_MESSAGE && LIGHT_HINTS.some((hint) => lower.includes(hint))) return "light";
  return "standard";
}

const CLAUDE_BY_EFFORT: Record<Effort, string> = { light: "haiku", standard: "sonnet", deep: "opus" };

export function resolveModel(engine: Engine, configured: string, message: string): string | null {
  if (configured !== "auto") return configured;
  if (engine === "claude-code") return CLAUDE_BY_EFFORT[effortFor(message)];
  return null;
}
