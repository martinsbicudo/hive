import { z } from "zod";
import { hasInvisible } from "./trust.ts";

export const MAIL_UNREAD_MAX = 20;
export const MAIL_TO_MAX = 10;
export const SUBJECT_MAX = 200;
export const TITLE_MAX = 200;
export const CALENDAR_NAME_MAX = 100;
export const BODY_MAX_BYTES = 20 * 1024;
export const MESSAGE_MAX = 2000;
export const RANGE_MAX_DAYS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MAIL_ID = /^[1-9]\d{0,15}$/;

export const email = z.string().max(254).regex(EMAIL, "must be a plain ASCII email address like name@example.com");
export const handle = z.string().max(254).refine((value) => EMAIL.test(value) || E164.test(value), "must be a plain ASCII email address or a phone number like +15551234567");

function oneLine(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => value.isWellFormed(), "must be well-formed text, with no lone surrogates")
    .refine((value) => !LINE_CONTROL.test(value), "can't hold line breaks or control characters")
    .refine((value) => !hasInvisible(value), "can't hold invisible characters");
}

function bodyText(maxBytes: number) {
  return z
    .string()
    .refine((value) => value.isWellFormed(), "must be well-formed text, with no lone surrogates")
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, `must be at most ${maxBytes / 1024} kB`)
    .refine((value) => !BODY_CONTROL.test(value), "can't hold control characters other than tabs and line breaks");
}

const instant = z.iso.datetime({ offset: true });

function checkRange(from: string, to: string, path: string, ctx: z.RefinementCtx): void {
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0) ctx.addIssue({ code: "custom", message: "must be after the start", path: [path] });
  if (span > RANGE_MAX_DAYS * DAY_MS) ctx.addIssue({ code: "custom", message: `the range can be at most ${RANGE_MAX_DAYS} days`, path: [path] });
}

export const mailUnreadInput = z.object({ limit: z.number().int().min(1).max(MAIL_UNREAD_MAX).default(10) }).strict();

export const mailReadInput = z
  .object({ id: z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(MAIL_ID, "must be a Mail message id").transform(Number)]) })
  .strict();

export const mailSendInput = z
  .object({
    to: z.array(email).min(1).max(MAIL_TO_MAX).refine((list) => new Set(list.map((address) => address.toLowerCase())).size === list.length, "lists an address twice"),
    subject: oneLine(SUBJECT_MAX),
    body: bodyText(BODY_MAX_BYTES),
  })
  .strict();

export const calendarEventsInput = z
  .object({ from: instant, to: instant })
  .strict()
  .superRefine((value, ctx) => checkRange(value.from, value.to, "to", ctx));

export const calendarCreateInput = z
  .object({
    title: oneLine(TITLE_MAX).refine((value) => value.trim().length > 0, "can't be empty"),
    start: instant,
    end: instant,
    calendar: oneLine(CALENDAR_NAME_MAX).refine((value) => value.trim().length > 0, "can't be empty").optional(),
    notes: bodyText(BODY_MAX_BYTES).optional(),
  })
  .strict()
  .superRefine((value, ctx) => checkRange(value.start, value.end, "end", ctx));

export const messagesSendInput = z
  .object({ to: handle, text: bodyText(MESSAGE_MAX * 4).refine((value) => value.length > 0 && value.length <= MESSAGE_MAX, `must be 1 to ${MESSAGE_MAX} characters`) })
  .strict();

export type MailUnreadInput = z.output<typeof mailUnreadInput>;
export type MailReadInput = z.output<typeof mailReadInput>;
export type MailSendInput = z.output<typeof mailSendInput>;
export type CalendarEventsInput = z.output<typeof calendarEventsInput>;
export type CalendarCreateInput = z.output<typeof calendarCreateInput>;
export type MessagesSendInput = z.output<typeof messagesSendInput>;
