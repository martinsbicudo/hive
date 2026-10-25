import { statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { normalize } from "node:path";
import { z } from "zod";
import {
  checkPlacement, COMPUTER_MODES, MAX_INSTRUCTIONS, MAX_NAME, MAX_ROLE, optionalString, parseAvatarStyle, parseModel,
} from "./agentFields.ts";
import { checkShape, createInput } from "./scheduleInput.ts";
import { ENGINES, type ArchitectProposal, type ProposedSchedule } from "./types.ts";

const MAX_SCHEDULES = 5;
const MAX_FOLDERS = 10;
const OPENING = /```json/gi;
const BLOCK = /```json[^\S\n]*\n([\s\S]*?)```/gi;
const PATH_CHAR = /[\w.~/-]/;
const PATH_END = /^\/?(?:[.,;:!?'")\]]*(?:\s|$)|[^\w.~/-])/;

const proposalShape = z
  .object({
    name: z.string(), role: z.string(), engine: z.enum(ENGINES), model: z.string(), instructions: z.string(),
    computer: z.enum(COMPUTER_MODES), permissionMode: z.literal("ask"), avatarStyle: z.string().optional(),
    folders: z.array(z.string()).max(MAX_FOLDERS), schedules: z.array(createInput.omit({ enabled: true }).strict()).max(MAX_SCHEDULES),
  })
  .strict();

type ProposalShape = z.output<typeof proposalShape>;

export type ProposalResult = { kind: "none" } | { kind: "valid"; proposal: ArchitectProposal } | { kind: "invalid"; issues: string };

function invalid(issues: string): ProposalResult {
  return { kind: "invalid", issues };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join(".") || "proposal";
  return issue.code === "unrecognized_keys" ? `${path}: has keys a proposal can't have` : `${path}: ${issue.message}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mentions(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at >= 0; at = text.indexOf(path, at + 1)) {
    const before = text[at - 1];
    if ((before === undefined || !PATH_CHAR.test(before)) && PATH_END.test(text.slice(at + path.length))) return true;
  }
  return false;
}

function statOf(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

const sameEntry = (a: Stats, b: Stats | null): boolean => b !== null && a.dev === b.dev && a.ino === b.ino;

function checkFolder(folder: string, field: string, userTexts: readonly string[], home: string): string {
  if (!folder.startsWith("/")) throw new Error(`${field} must be an absolute path`);
  const path = normalize(folder).replace(/(.)\/+$/, "$1");
  const stats = statOf(path);
  if (stats === null || !stats.isDirectory()) throw new Error(`${field} doesn't exist`);
  if (path === "/" || sameEntry(stats, statOf("/")) || sameEntry(stats, statOf(home))) {
    throw new Error(`${field} is the whole disk or home folder; ask for a project folder`);
  }
  if (!userTexts.some((text) => mentions(text, path))) throw new Error(`${field} isn't one the user wrote; ask for it`);
  return path;
}

function checkSchedule(schedule: ProposalShape["schedules"][number]): ProposedSchedule {
  const at = schedule.at ?? null;
  const everyMinutes = schedule.everyMinutes ?? null;
  checkShape(schedule.kind, at, everyMinutes);
  return { kind: schedule.kind, at, everyMinutes, prompt: schedule.prompt };
}

function checkFields(shape: ProposalShape, userTexts: readonly string[], home: string): ArchitectProposal | string {
  const issues: string[] = [];
  const checked = <T>(check: () => T, fallback: T, issue?: string): T => {
    try {
      return check();
    } catch (error) {
      issues.push(issue ?? messageOf(error));
      return fallback;
    }
  };
  checked(() => checkPlacement(shape.engine, shape.computer, []), undefined);
  const avatarStyle = checked(() => parseAvatarStyle(shape.avatarStyle), undefined, "avatarStyle isn't a known style");
  const proposal: ArchitectProposal = {
    name: checked(() => optionalString(shape.name, "name", MAX_NAME) ?? "", ""),
    role: checked(() => optionalString(shape.role, "role", MAX_ROLE) ?? "", ""),
    engine: shape.engine,
    model: checked(() => parseModel(shape.model, shape.engine) ?? "auto", "auto", `model isn't available for ${shape.engine}`),
    instructions: checked(() => optionalString(shape.instructions, "instructions", MAX_INSTRUCTIONS) ?? "", ""),
    computer: shape.computer,
    permissionMode: "ask",
    ...(avatarStyle === undefined ? {} : { avatarStyle }),
    folders: [...new Set(shape.folders.map((folder, index) => checked(() => checkFolder(folder, `folders.${index}`, userTexts, home), folder)))],
    schedules: shape.schedules.map((schedule) => checked(() => checkSchedule(schedule), { kind: schedule.kind, at: null, everyMinutes: null, prompt: "" })),
  };
  return issues.length > 0 ? issues.join("; ") : proposal;
}

export function parseProposal(reply: string, userTexts: readonly string[], home: string = homedir()): ProposalResult {
  const opened = reply.match(OPENING)?.length ?? 0;
  if (opened === 0) return { kind: "none" };
  if (opened > 1) return invalid("send exactly one ```json block, not several");
  const body = [...reply.matchAll(BLOCK)][0]?.[1];
  if (body === undefined) return invalid("the ```json block isn't closed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return invalid("the ```json block isn't valid JSON");
  }
  const shape = proposalShape.safeParse(parsed);
  if (!shape.success) return invalid(shape.error.issues.map(describeIssue).join("; "));
  const checked = checkFields(shape.data, userTexts, home);
  return typeof checked === "string" ? invalid(checked) : { kind: "valid", proposal: checked };
}
