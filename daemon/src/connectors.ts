import { z } from "zod";
import { connectorTool, type ConnectorContext, type ConnectorTool } from "./connectorTools.ts";
import { JxaFailed, runJxa, type JxaCall } from "./jxa.ts";
import {
  BODY_MAX_BYTES, calendarCreateInput, calendarEventsInput, mailReadInput, mailSendInput, mailUnreadInput, messagesSendInput,
} from "./macInput.ts";
import { calendarCreateDisplay, mailSendDisplay, messagesSendDisplay } from "./outwardDisplay.ts";
import { UnsafeContentError, wrapUntrusted } from "./trust.ts";

export const MAIL_SOURCE = "From Mail (external)";
export const CALENDAR_SOURCE = "From Calendar (external)";
export const EVENTS_MAX = 200;
export const READ_OUTPUT_BYTES = 30 * 1024;

const FIELD_MAX = 500;
const NOTES_MAX = 2000;
const LINE_NOISE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

const text = z.string().max(BODY_MAX_BYTES * 4);
const unreadOutput = z.object({ messages: z.array(z.object({ id: z.number().int(), from: text, subject: text, date: text }).strict()).max(20) }).strict();
const readOutput = z.union([
  z.object({ found: z.literal(false) }).strict(),
  z.object({ found: z.literal(true), id: z.number().int(), from: text, to: z.array(text).max(200), subject: text, date: text, body: text }).strict(),
]);
const eventsOutput = z
  .object({
    events: z.array(z.object({ calendar: text, title: text, start: text, end: text, allDay: z.boolean(), location: text, notes: text }).strict()).max(EVENTS_MAX),
    truncated: z.boolean(),
  })
  .strict();
const sentOutput = z.object({ sent: z.literal(true) }).strict();
const createdOutput = z.object({ created: z.literal(true), calendar: text }).strict();

function line(value: string, max = FIELD_MAX): string {
  const flat = value.replace(LINE_NOISE, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function capBytes(value: string, bytes: number): { text: string; cut: boolean } {
  const encoded = Buffer.from(value, "utf8");
  return encoded.length <= bytes ? { text: value, cut: false } : { text: encoded.subarray(0, bytes).toString("utf8"), cut: true };
}

function wrapped(content: string, ctx: ConnectorContext, source: string): string {
  try {
    return wrapUntrusted(capBytes(content, READ_OUTPUT_BYTES).text, ctx.nonce, { source });
  } catch (error) {
    if (!(error instanceof UnsafeContentError)) throw error;
    return "Hive withheld this content: it holds this run's untrusted-content marker.";
  }
}

async function read<T>(call: JxaCall<T>, ctx: ConnectorContext, format: (data: T) => string): Promise<string> {
  try {
    return wrapped(format(await runJxa(call, ctx)), ctx, call.source);
  } catch (error) {
    if (error instanceof JxaFailed) return error.message;
    throw error;
  } finally {
    ctx.markTainted();
  }
}

const mailUnread = connectorTool({
  tool: "mail_unread",
  connector: "mail",
  kind: "read",
  input: mailUnreadInput,
  run: (input, ctx) =>
    read({ script: "mail-unread", app: "Mail", source: MAIL_SOURCE, input, output: unreadOutput }, ctx, ({ messages }) => {
      if (messages.length === 0) return "No unread messages in the inbox.";
      const rows = messages.map((message) => `- id ${message.id} | ${line(message.date)} | From: ${line(message.from)} | Subject: ${line(message.subject)}`);
      return [`${messages.length} unread in the inbox, newest first. Read one with mail_read and its id.`, ...rows].join("\n");
    }),
});

const mailRead = connectorTool({
  tool: "mail_read",
  connector: "mail",
  kind: "read",
  input: mailReadInput,
  run: (input, ctx) =>
    read({ script: "mail-read", app: "Mail", source: MAIL_SOURCE, input, output: readOutput }, ctx, (message) => {
      if (!message.found) return `No message with id ${input.id} in the inbox.`;
      const body = capBytes(message.body, BODY_MAX_BYTES);
      return [
        `From: ${line(message.from)}`,
        `To: ${line(message.to.join(", "))}`,
        `Date: ${line(message.date)}`,
        `Subject: ${line(message.subject)}`,
        "",
        body.text,
        ...(body.cut ? [`[Hive cut the body at ${BODY_MAX_BYTES / 1024} kB]`] : []),
      ].join("\n");
    }),
});

const calendarEvents = connectorTool({
  tool: "calendar_events",
  connector: "calendar",
  kind: "read",
  input: calendarEventsInput,
  run: (input, ctx) =>
    read({ script: "calendar-events", app: "Calendar", source: CALENDAR_SOURCE, input, output: eventsOutput }, ctx, ({ events, truncated }) => {
      if (events.length === 0) return `No events between ${input.from} and ${input.to}.`;
      const rows = events.map((event) => {
        const when = event.allDay ? `${line(event.start)} (all day)` : `${line(event.start)} to ${line(event.end)}`;
        const where = event.location ? ` | At: ${line(event.location)}` : "";
        const notes = event.notes ? `\n  Notes: ${line(event.notes, NOTES_MAX)}` : "";
        return `- ${when} | ${line(event.title)} | Calendar: ${line(event.calendar)}${where}${notes}`;
      });
      return [`${events.length} events${truncated ? ` (the first ${EVENTS_MAX}; narrow the range for the rest)` : ""}:`, ...rows].join("\n");
    }),
});

async function send<T>(call: JxaCall<T>, ctx: ConnectorContext, done: string): Promise<string> {
  await runJxa(call, ctx);
  return done;
}

const mailSend = connectorTool({
  tool: "mail_send",
  connector: "mail",
  kind: "outward",
  input: mailSendInput,
  display: mailSendDisplay,
  run: (input, ctx) =>
    send({ script: "mail-send", app: "Mail", source: MAIL_SOURCE, input, output: sentOutput }, ctx, `Mail sent the email to ${input.to.length} recipient${input.to.length === 1 ? "" : "s"}.`),
});

const calendarCreate = connectorTool({
  tool: "calendar_create",
  connector: "calendar",
  kind: "outward",
  input: calendarCreateInput,
  display: calendarCreateDisplay,
  run: async (input, ctx) => {
    const created = await runJxa({ script: "calendar-create", app: "Calendar", source: CALENDAR_SOURCE, input, output: createdOutput }, ctx);
    return `Calendar created "${line(input.title)}" in ${line(created.calendar, 100)}.`;
  },
});

const messagesSend = connectorTool({
  tool: "messages_send",
  connector: "messages",
  kind: "outward",
  input: messagesSendInput,
  display: messagesSendDisplay,
  run: (input, ctx) => send({ script: "messages-send", app: "Messages", source: "From Messages (external)", input, output: sentOutput }, ctx, "Messages sent the iMessage."),
});

export const MAC_CONNECTOR_TOOLS: readonly ConnectorTool[] = [mailUnread, mailRead, mailSend, calendarEvents, calendarCreate, messagesSend];
