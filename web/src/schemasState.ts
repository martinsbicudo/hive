import { z } from "zod";
import { agent, computerStatus, engine } from "./schemas.ts";

const mailDisplay = z
  .object({
    action: z.string(),
    to: z.array(z.string()),
    fields: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
    body: z.string().nullable(),
  })
  .strict();

const ghDisplay = z
  .object({
    kind: z.literal("gh"),
    command: z.string(),
    targets: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
    flags: z.array(z.object({ label: z.string(), value: z.string().nullable() }).strict()),
    body: z.object({ label: z.string(), text: z.string(), lines: z.number(), chars: z.number() }).strict().nullable(),
  })
  .strict();

const approvalDisplay = z.union([ghDisplay, mailDisplay]);

export const approval = z
  .object({
    id: z.string(),
    agentId: z.string(),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
    summary: z.string(),
    status: z.enum(["pending", "allowed", "denied", "expired"]),
    rememberable: z.boolean(),
    targetAgentId: z.string().nullable(),
    tainted: z.boolean(),
    display: approvalDisplay.nullable(),
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
  })
  .strict();

const budgetLimits = z
  .object({ globalDailyUsdCents: z.number().nullable(), globalDailyTokens: z.number().nullable(), globalMonthlyUsdCents: z.number().nullable() })
  .strict();

export const budgets = z
  .object({
    limits: budgetLimits,
    spent: z.object({ todayUsd: z.number(), todayTokens: z.number(), monthUsd: z.number() }).strict(),
    agents: z.array(z.object({ agentId: z.string(), unit: z.enum(["usd-cents", "tokens"]), limit: z.number().nullable(), spent: z.number() }).strict()),
  })
  .strict();

const engineUsage = z
  .object({
    engine,
    agents: z.number(),
    activeRuns: z.number(),
    todayUsd: z.number(),
    weekUsd: z.number(),
    monthUsd: z.number(),
    todayTokens: z.number(),
  })
  .strict();

const architectUsage = z.object({ todayUsd: z.number(), weekUsd: z.number(), monthUsd: z.number() }).strict();

const activity = z
  .object({
    agentId: z.string(),
    name: z.string(),
    role: z.string(),
    detail: z.string(),
    since: z.string(),
    queued: z.number(),
    taskId: z.string().optional(),
    taskTitle: z.string().optional(),
  })
  .strict();

const hubState = z
  .object({
    agents: z.array(agent),
    computers: z.array(computerStatus.extend({ agentId: z.string() })),
    approvals: z.array(approval.extend({ agentName: z.string() })),
    usage: z.array(engineUsage),
    architectUsage: architectUsage.nullable(),
    activity: z.array(activity),
    paused: z.boolean(),
    pausedAt: z.string().nullable(),
    budgets,
  })
  .strict();

export const hubEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), state: hubState }).strict(),
  z.object({ type: z.literal("delta"), agentId: z.string(), text: z.string() }).strict(),
  z.object({ type: z.literal("message"), agentId: z.string() }).strict(),
  z.object({ type: z.literal("task"), taskId: z.string() }).strict(),
  z.object({
    type: z.literal("notify"),
    kind: z.enum(["approval", "budget", "failed", "paused"]),
    text: z.string(),
    agentId: z.string().optional(),
    taskId: z.string().optional(),
  }).strict(),
]);

export type Approval = z.infer<typeof approval>;
export type ApprovalDisplay = z.infer<typeof approvalDisplay>;
export type MailDisplay = z.infer<typeof mailDisplay>;
export type GhDisplay = z.infer<typeof ghDisplay>;
export type Budgets = z.infer<typeof budgets>;
export type BudgetLimits = z.infer<typeof budgetLimits>;
export type AgentBudget = Budgets["agents"][number];
export type EngineUsage = z.infer<typeof engineUsage>;
export type ArchitectUsage = z.infer<typeof architectUsage>;
export type Activity = z.infer<typeof activity>;
export type HubState = z.infer<typeof hubState>;
export type HubEvent = z.infer<typeof hubEvent>;
