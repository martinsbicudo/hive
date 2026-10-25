import { posix } from "node:path";
import { z } from "zod";
import { COMMAND_TIMEOUT_MAX_S } from "./computerArgs.ts";

export const SCREEN_WIDTH = 1440;
export const SCREEN_HEIGHT = 900;
export const WORKSPACE = "/home/agent/workspace";
export const READ_LIMIT_BYTES = 200 * 1024;
export const WRITE_LIMIT_BYTES = 200 * 1024;
export const DEFAULT_TIMEOUT_S = 120;

const MAX_COMMAND_CHARS = 32 * 1024;
const MAX_TYPE_CHARS = 4000;
const MAX_KEYS = 16;
const MAX_PATH_CHARS = 1024;
const MAX_URL_CHARS = 2048;
const COMPUTER_NAME_MAX = 100;
const KEY_NAME = /^[A-Za-z0-9_+]{1,40}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function keyNames(value: string): string[] {
  return value.trim().split(/ +/);
}

function isWebUrl(value: string): boolean {
  if (/[\u0000- \u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const path = z.string().min(1).max(MAX_PATH_CHARS).refine((value) => !CONTROL.test(value), "the path has control characters");

export const computerShapes = {
  run: {
    command: z.string().min(1).max(MAX_COMMAND_CHARS).describe("A bash command, run as the agent user in ~/workspace"),
    timeout_s: z.number().int().min(1).max(COMMAND_TIMEOUT_MAX_S).optional().describe(`Seconds before the command is killed (default ${DEFAULT_TIMEOUT_S})`),
  },
  screenshot: {},
  click: {
    x: z.number().int().min(0).max(SCREEN_WIDTH - 1),
    y: z.number().int().min(0).max(SCREEN_HEIGHT - 1),
    button: z.enum(["left", "middle", "right"]).optional(),
  },
  type: { text: z.string().min(1).max(MAX_TYPE_CHARS).describe("Text typed into the focused window") },
  key: {
    keys: z
      .string()
      .min(1)
      .max(400)
      .refine((value) => {
        const names = keyNames(value);
        return names.length <= MAX_KEYS && names.every((name) => KEY_NAME.test(name));
      }, "keys are xdotool key names such as Return, ctrl+l or alt+Tab, separated by spaces")
      .describe("xdotool key names separated by spaces, e.g. 'ctrl+l' or 'Return'"),
  },
  open: { url: z.string().max(MAX_URL_CHARS).refine(isWebUrl, "only http and https URLs can be opened") },
  read: { path: path.describe("File path; relative paths start in ~/workspace") },
  write: {
    path: path.describe("File path; relative paths start in ~/workspace"),
    content: z.string().refine((value) => Buffer.byteLength(value) <= WRITE_LIMIT_BYTES, `content is limited to ${WRITE_LIMIT_BYTES} bytes`),
  },
  export: { path: path.describe("File inside /home/agent to copy to the user's Downloads") },
} as const;

export type ComputerRoute = keyof typeof computerShapes;

export const computerInputs = {
  run: z.object(computerShapes.run).strict(),
  screenshot: z.object(computerShapes.screenshot).strict(),
  click: z.object(computerShapes.click).strict(),
  type: z.object(computerShapes.type).strict(),
  key: z.object(computerShapes.key).strict(),
  open: z.object(computerShapes.open).strict(),
  read: z.object(computerShapes.read).strict(),
  write: z.object(computerShapes.write).strict(),
  export: z.object(computerShapes.export).strict(),
};

export const computerResourceInputs = {
  create: z.object({
    name: z.string().trim().min(1).max(COMPUTER_NAME_MAX),
    runtime: z.enum(["docker"]),
    profile: z.enum(["terminal", "browser", "desktop"]),
  }).strict(),
  assignment: z.object({ computerId: z.string().uuid() }).strict(),
  moveEngine: z.object({}).strict(),
  update: z.object({
    name: z.string().trim().min(1).max(COMPUTER_NAME_MAX).optional(),
    runtime: z.enum(["docker"]).optional(),
    profile: z.enum(["terminal", "browser", "desktop"]).optional(),
    managed: z.literal(true).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "provide a computer change"),
};

export function isComputerRoute(value: string | undefined): value is ComputerRoute {
  return value !== undefined && Object.hasOwn(computerInputs, value);
}

export function agentFilePath(input: string): string {
  return posix.normalize(input.startsWith("/") ? input : posix.join(WORKSPACE, input));
}

export function xdotoolKeys(keys: string): string[] {
  return keyNames(keys);
}
