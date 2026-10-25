import { z } from "zod";
import type { PositionalKind } from "./githubFlags.ts";
import { GH_MAX_ARG_LENGTH, GH_MAX_ARGS, type GhCall } from "./githubPolicy.ts";
import { HttpError } from "./httpError.ts";
import type { CalendarCreateInput, MailSendInput, MessagesSendInput } from "./macInput.ts";
import { visibleBodyEscapes, visibleEscapes } from "./trust.ts";
import type { ApprovalDisplay, ApprovalDisplayField, GhDisplay, GhDisplayBody, MailDisplay } from "./types.ts";

const DISPLAY_TEXT_MAX = 200_000;
const LABEL_MAX = 40;
// The widest escape, "[U+XXXXX]", is 9 characters, so no escaped gh value can outgrow this.
export const GH_SHOWN_MAX = GH_MAX_ARG_LENGTH * 9;

const mailDisplaySchema = z
  .object({
    action: z.string().max(100),
    to: z.array(z.string().max(254)).max(10),
    fields: z.array(z.object({ label: z.string().max(LABEL_MAX), value: z.string().max(4000) }).strict()).max(8),
    body: z.string().max(DISPLAY_TEXT_MAX).nullable(),
  })
  .strict();

const ghBodySchema = z
  .object({
    label: z.string().max(LABEL_MAX),
    text: z.string().max(GH_SHOWN_MAX),
    lines: z.number().int().min(1).max(GH_MAX_ARG_LENGTH + 1),
    chars: z.number().int().min(0).max(GH_MAX_ARG_LENGTH),
  })
  .strict();

const ghDisplaySchema = z
  .object({
    kind: z.literal("gh"),
    command: z.string().max(100),
    targets: z.array(z.object({ label: z.string().max(LABEL_MAX), value: z.string().max(GH_SHOWN_MAX) }).strict()).max(GH_MAX_ARGS),
    flags: z.array(z.object({ label: z.string().max(LABEL_MAX), value: z.string().max(GH_SHOWN_MAX).nullable() }).strict()).max(GH_MAX_ARGS),
    body: ghBodySchema.nullable(),
  })
  .strict();

export const approvalDisplaySchema = z.union([ghDisplaySchema, mailDisplaySchema]);

export function storedDisplay(raw: string | null): ApprovalDisplay | null {
  if (raw === null) return null;
  try {
    const parsed = approvalDisplaySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function checkedDisplay<T extends ApprovalDisplay>(display: T): T {
  if (!approvalDisplaySchema.safeParse(display).success) throw new HttpError(400, "Hive refused this call: it doesn't fit on an approval card");
  return display;
}

function field(label: string, value: string): ApprovalDisplayField {
  return { label, value: visibleEscapes(value) };
}

function localTime(iso: string): string {
  const when = new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  return `${when} (${iso})`;
}

function display(action: string, to: readonly string[], fields: ApprovalDisplayField[], body: string | null): MailDisplay {
  return { action, to: to.map(visibleEscapes), fields, body: body === null ? null : visibleBodyEscapes(body) };
}

export function mailSendDisplay(input: MailSendInput): MailDisplay {
  return display("Send an email", input.to, [field("Subject", input.subject)], input.body);
}

export function calendarCreateDisplay(input: CalendarCreateInput): MailDisplay {
  return display("Create a calendar event", [], [
    field("Title", input.title),
    field("Calendar", input.calendar ?? "not named: the first calendar you can write to"),
    field("Starts", localTime(input.start)),
    field("Ends", localTime(input.end)),
  ], input.notes ?? null);
}

export function messagesSendDisplay(input: MessagesSendInput): MailDisplay {
  return display("Send an iMessage", [input.to], [], input.text);
}

const TARGET_LABELS: Readonly<Record<PositionalKind, string>> = {
  pr: "Pull request",
  issue: "Issue",
  run: "Run",
  repo: "Repository",
  query: "Search query",
  endpoint: "Endpoint",
};

function ghBody(call: GhCall): GhDisplayBody | null {
  for (const use of call.flags) {
    if (use.spec.value !== "body" || use.value === null) continue;
    const text = use.value;
    return { label: `--${use.spec.long}`, text: visibleBodyEscapes(text), lines: text.split("\n").length, chars: [...text].length };
  }
  return null;
}

export function ghDisplay(call: GhCall): GhDisplay {
  const repos = call.flags.filter((use) => use.spec.long === "repo").map((use) => field("Repository", use.value ?? ""));
  const label = call.positional === null ? null : TARGET_LABELS[call.positional];
  const positionals = label === null ? [] : call.positionals.map((value) => field(label, value));
  const rows = call.flags.filter((use) => use.spec.long !== "repo" && use.spec.value !== "body");
  return {
    kind: "gh",
    command: visibleEscapes(`gh ${call.command}`),
    targets: [...repos, ...positionals],
    flags: rows.map((use) => ({ label: `--${use.spec.long}`, value: use.value === null ? null : visibleEscapes(use.value) })),
    body: ghBody(call),
  };
}

function short(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function displaySummary(tool: string, shown: ApprovalDisplay): string {
  if ("kind" in shown) return short(`${tool}: ${shown.command}`, 160);
  const to = shown.to.length === 0 ? "" : ` to ${shown.to[0] ?? ""}${shown.to.length > 1 ? ` +${shown.to.length - 1}` : ""}`;
  const first = shown.fields[0];
  return short(`${tool}${to}${first ? `: ${first.value}` : ""}`, 160);
}
