import type { ComputerMode, ComputerStatus } from "./computerTypes.ts";
export type { Computer, ComputerMember, ComputerMode, ComputerProfile, ComputerResource, ComputerRuntime, ComputerState, ComputerStatus } from "./computerTypes.ts";

export type Engine = "claude-code" | "codex";
export const ENGINES: readonly Engine[] = ["claude-code", "codex"];

export type PermissionMode = "ask" | "accept-edits";
export const CONNECTORS = ["mail", "calendar", "messages", "github"] as const;
export type Connector = (typeof CONNECTORS)[number];
export type AgentStatus = "sleeping" | "working" | "waiting-approval" | "error";

export interface Agent {
  id: string;
  name: string;
  role: string;
  engine: Engine;
  model: string;
  instructions: string;
  avatarStyle: string;
  avatarSeed: string;
  useMySetup: boolean;
  permissionMode: PermissionMode;
  folders: string[];
  allowedTools: string[];
  computer: ComputerMode;
  computerId: string | null;
  dailyBudget: number | null;
  connectors: Connector[];
  sessionId: string | null;
  status: AgentStatus;
  activity: string | null;
  nextWake: string | null;
  createdAt: string;
  updatedAt: string;
}

export type StoredAgent = Omit<Agent, "status" | "activity" | "nextWake">;

export const SCHEDULE_KINDS = ["daily", "weekdays", "interval"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export interface Schedule {
  id: string;
  agentId: string;
  kind: ScheduleKind;
  at: string | null;
  everyMinutes: number | null;
  prompt: string;
  enabled: boolean;
  lastFiredAt: string | null;
  lastRanAt: string | null;
  createdAt: string;
}

export interface BudgetLimits {
  globalDailyUsdCents: number | null;
  globalDailyTokens: number | null;
  globalMonthlyUsdCents: number | null;
}

export interface AgentBudget {
  agentId: string;
  unit: "usd-cents" | "tokens";
  limit: number | null;
  spent: number;
}

export interface Budgets {
  limits: BudgetLimits;
  spent: { todayUsd: number; todayTokens: number; monthUsd: number };
  agents: AgentBudget[];
}

export type MessageRole = "user" | "assistant" | "tool" | "error";

export interface Message {
  id: number;
  agentId: string;
  role: MessageRole;
  text: string;
  createdAt: string;
}

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";

export interface ApprovalDisplayField {
  label: string;
  value: string;
}

export interface MailDisplay {
  action: string;
  to: string[];
  fields: ApprovalDisplayField[];
  body: string | null;
}

export interface GhDisplayFlag {
  label: string;
  value: string | null;
}

export interface GhDisplayBody {
  label: string;
  text: string;
  lines: number;
  chars: number;
}

export interface GhDisplay {
  kind: "gh";
  command: string;
  targets: ApprovalDisplayField[];
  flags: GhDisplayFlag[];
  body: GhDisplayBody | null;
}

export type ApprovalDisplay = MailDisplay | GhDisplay;

export interface Approval {
  id: string;
  agentId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  status: ApprovalStatus;
  rememberable: boolean;
  targetAgentId: string | null;
  tainted: boolean;
  display: ApprovalDisplay | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface Run {
  id: string;
  agentId: string;
  engine: Engine;
  model: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "done" | "failed" | "stopped";
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

export interface EngineUsage {
  engine: Engine;
  agents: number;
  activeRuns: number;
  todayUsd: number;
  weekUsd: number;
  monthUsd: number;
  todayTokens: number;
}

export const ARCHITECT_ID = "architect";

export interface ArchitectUsage {
  todayUsd: number;
  weekUsd: number;
  monthUsd: number;
}

export interface ProposedSchedule {
  kind: ScheduleKind;
  at: string | null;
  everyMinutes: number | null;
  prompt: string;
}

export interface ArchitectProposal {
  name: string;
  role: string;
  engine: Engine;
  model: string;
  instructions: string;
  computer: ComputerMode;
  permissionMode: "ask";
  avatarStyle?: string;
  folders: string[];
  schedules: ProposedSchedule[];
}

export interface AgentTemplate {
  name: string;
  role: string;
  instructions: string;
  engine: Engine;
  computer: ComputerMode;
  permissionMode: "ask";
  connectors: Connector[];
  schedules: ProposedSchedule[];
  avatar: { style: string; seed: string };
  notes: string[];
}

export interface ArchitectReply {
  reply: string;
  proposal: ArchitectProposal | null;
  error?: string;
}

export interface Activity {
  agentId: string;
  name: string;
  role: string;
  detail: string;
  since: string;
  queued: number;
  taskId?: string;
  taskTitle?: string;
}

export interface HubState {
  agents: Agent[];
  computers: (ComputerStatus & { agentId: string })[];
  approvals: (Approval & { agentName: string })[];
  usage: EngineUsage[];
  architectUsage: ArchitectUsage | null;
  activity: Activity[];
  paused: boolean;
  pausedAt: string | null;
  budgets: Budgets;
}

export type NotifyKind = "approval" | "budget" | "failed" | "paused";

export type HubEvent =
  | { type: "state"; state: HubState }
  | { type: "delta"; agentId: string; text: string }
  | { type: "message"; agentId: string }
  | { type: "task"; taskId: string }
  | { type: "notify"; kind: NotifyKind; text: string; agentId?: string; taskId?: string };

export const TASK_STATUSES = ["backlog", "todo", "doing", "review", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_GATES = ["mac-to-virtual", "tainted-to-mac"] as const;
export type TaskGate = (typeof TASK_GATES)[number];

export type TaskEventKind = "comment" | "status" | "assign" | "handoff";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assigneeId: string | null;
  createdBy: string;
  titleUntrusted: boolean;
  descriptionUntrusted: boolean;
  titleMacOnly: boolean;
  descriptionMacOnly: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  author: string;
  kind: TaskEventKind;
  text: string;
  untrusted: boolean;
  authorMac: boolean;
  gate: TaskGate | null;
  createdAt: string;
}

export interface HubOptions {
  names: readonly string[];
  roles: readonly string[];
  models: Record<Engine, readonly string[]>;
  avatarStyles: readonly string[];
  engines: Record<Engine, boolean>;
}
