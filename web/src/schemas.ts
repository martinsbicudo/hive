import { z } from "zod";

export const engine = z.enum(["claude-code", "codex"]);
export const connector = z.enum(["mail", "calendar", "messages", "github"]);
export const computerMode = z.enum(["mac", "virtual"]);
export const scheduleKind = z.enum(["daily", "weekdays", "interval"]);

export const agent = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    engine,
    model: z.string(),
    instructions: z.string(),
    avatarStyle: z.string(),
    avatarSeed: z.string(),
    useMySetup: z.boolean(),
    permissionMode: z.enum(["ask", "accept-edits"]),
    folders: z.array(z.string()),
    allowedTools: z.array(z.string()),
    computer: computerMode,
    computerId: z.string().nullable(),
    dailyBudget: z.number().nullable(),
    connectors: z.array(connector),
    sessionId: z.string().nullable(),
    status: z.enum(["sleeping", "working", "waiting-approval", "error"]),
    activity: z.string().nullable(),
    nextWake: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const proposedSchedule = z
  .object({ kind: scheduleKind, at: z.string().nullable(), everyMinutes: z.number().nullable(), prompt: z.string() })
  .strict();

export const schedule = z
  .object({
    id: z.string(),
    agentId: z.string(),
    kind: scheduleKind,
    at: z.string().nullable(),
    everyMinutes: z.number().nullable(),
    prompt: z.string(),
    enabled: z.boolean(),
    lastFiredAt: z.string().nullable(),
    lastRanAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

export const message = z
  .object({ id: z.number(), agentId: z.string(), role: z.enum(["user", "assistant", "tool", "error"]), text: z.string(), createdAt: z.string() })
  .strict();

export const computerStatus = z.object({
  state: z.enum(["missing", "building", "stopped", "starting", "running", "error"]),
  detail: z.string().optional(),
  computerId: z.string().optional(),
  profile: z.enum(["terminal", "browser", "desktop"]).optional(),
  hasScreen: z.boolean().optional(),
}).strict();

export const computerResource = z.object({
  id: z.string(),
  name: z.string(),
  runtime: z.enum(["docker"]),
  profile: z.enum(["terminal", "browser", "desktop"]),
  engine: z.enum(["docker-desktop", "orbstack"]).nullable(),
  revision: z.number(),
  managed: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  members: z.array(z.object({ agentId: z.string(), name: z.string() }).strict()),
}).strict();

export const template = z
  .object({
    name: z.string(),
    role: z.string(),
    instructions: z.string(),
    engine,
    computer: computerMode,
    permissionMode: z.literal("ask"),
    connectors: z.array(connector),
    schedules: z.array(proposedSchedule),
    avatar: z.object({ style: z.string(), seed: z.string() }).strict(),
    notes: z.array(z.string()),
  })
  .strict();

export const architectProposal = z
  .object({
    name: z.string(),
    role: z.string(),
    engine,
    model: z.string(),
    instructions: z.string(),
    computer: computerMode,
    permissionMode: z.literal("ask"),
    avatarStyle: z.string().optional(),
    folders: z.array(z.string()),
    schedules: z.array(proposedSchedule),
  })
  .strict();

export const architectReply = z.object({ reply: z.string(), proposal: architectProposal.nullable(), error: z.string().optional() }).strict();

export const hubOptions = z
  .object({
    names: z.array(z.string()),
    roles: z.array(z.string()),
    models: z.object({ "claude-code": z.array(z.string()), codex: z.array(z.string()) }).strict(),
    avatarStyles: z.array(z.string()),
    engines: z.object({ "claude-code": z.boolean(), codex: z.boolean() }).strict(),
  })
  .strict();

export const screenSecrets = z.object({ port: z.number(), token: z.string(), password: z.string() }).strict();
export const ok = z.object({ ok: z.literal(true) }).strict();
export const paused = z.object({ ok: z.literal(true), paused: z.boolean() }).strict();
export const rules = z.object({ ok: z.literal(true), allowedTools: z.array(z.string()) }).strict();

export type Engine = z.infer<typeof engine>;
export type Connector = z.infer<typeof connector>;
export type ScheduleKind = z.infer<typeof scheduleKind>;
export type Agent = z.infer<typeof agent>;
export type ProposedSchedule = z.infer<typeof proposedSchedule>;
export type Schedule = z.infer<typeof schedule>;
export type Message = z.infer<typeof message>;
export type ComputerStatus = z.infer<typeof computerStatus>;
export type ComputerResource = z.infer<typeof computerResource>;
export type AgentTemplate = z.infer<typeof template>;
export type ArchitectProposal = z.infer<typeof architectProposal>;
export type ArchitectReply = z.infer<typeof architectReply>;
export type HubOptions = z.infer<typeof hubOptions>;
export type ScreenSecrets = z.infer<typeof screenSecrets>;
