import { useSyncExternalStore } from "react";
import { z } from "zod";
import * as shape from "./schemas.ts";
import { approval, budgets, type BudgetLimits } from "./schemasState.ts";
import { task, taskEvent, taskThread, type TaskStatus } from "./schemasTasks.ts";
import type { Agent, ScheduleKind } from "./schemas.ts";
import { runtimeCapabilities as runtimeCapabilitiesSchema } from "./runtimeCapabilities.ts";

export type { Agent, AgentTemplate, ArchitectProposal, ArchitectReply, Connector, Engine, HubOptions, Message, ProposedSchedule, Schedule, ScheduleKind, ScreenSecrets } from "./schemas.ts";
export type { Activity, AgentBudget, Approval, ApprovalDisplay, ArchitectUsage, BudgetLimits, Budgets, EngineUsage, HubState } from "./schemasState.ts";
export type { Task, TaskEvent, TaskStatus } from "./schemasTasks.ts";
export type ComputerStatus = z.infer<typeof shape.computerStatus>;
export type ComputerState = ComputerStatus["state"];
export type ComputerResource = z.infer<typeof shape.computerResource>;
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>;

const TOKEN_KEY = "hive-token";
const BRIDGE_RETRY_MS = 1500;

type TokenBridge = { postMessage(message: unknown): Promise<unknown> };

function appBridge(): TokenBridge | null {
  return window.webkit?.messageHandlers?.hiveToken ?? null;
}

const inApp = appBridge() !== null;
const pasteListeners = new Set<() => void>();
let waitingForPaste = false;
let providePasted: ((token: string) => void) | null = null;
let currentToken = "";

function setWaiting(waiting: boolean): void {
  waitingForPaste = waiting;
  for (const listener of pasteListeners) listener();
}

function savedToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

async function askApp(bridge: TokenBridge): Promise<string> {
  for (;;) {
    const reply = await bridge.postMessage({ type: "token" }).catch(() => null);
    if (typeof reply === "string" && reply) return reply;
    await new Promise((resolve) => window.setTimeout(resolve, BRIDGE_RETRY_MS));
  }
}

function waitForPaste(): Promise<string> {
  setWaiting(true);
  return new Promise((resolve) => {
    providePasted = resolve;
  });
}

function nextToken(): Promise<string> {
  const bridge = appBridge();
  const saved = bridge ? "" : savedToken();
  const next = bridge ? askApp(bridge) : saved ? Promise.resolve(saved) : waitForPaste();
  return next.then((token) => (currentToken = token));
}

let tokenReady: Promise<string> = nextToken();

export function readyToken(): Promise<string> {
  return tokenReady;
}

function rememberInTab(token: string | null): void {
  if (inApp) return;
  try {
    if (token === null) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    return;
  }
}

function rejectToken(used: string): void {
  if (used !== currentToken) return;
  currentToken = "";
  rememberInTab(null);
  tokenReady = nextToken();
}

export function submitToken(value: string): void {
  const token = value.trim();
  if (inApp || !token || !providePasted) return;
  rememberInTab(token);
  providePasted(token);
  providePasted = null;
  setWaiting(false);
}

export function useNeedsToken(): boolean {
  return useSyncExternalStore((listener) => {
    pasteListeners.add(listener);
    return () => pasteListeners.delete(listener);
  }, () => waitingForPaste);
}

export class ApiError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.code = code;
  }
}

export async function request<S extends z.ZodType>(schema: S, path: string, init: RequestInit = {}): Promise<z.output<S>> {
  const token = await tokenReady;
  const response = await fetch(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (response.status === 401) rejectToken(token);
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body ? String(body.error) : `HTTP ${response.status}`;
    const code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : null;
    throw new ApiError(message, code);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join(".") || "response";
    throw new ApiError(`Hive sent an answer the board doesn't understand (${init.method ?? "GET"} ${path}, at ${where}). Update the board or the app.`, "invalid-response");
  }
  return parsed.data;
}

export interface AgentForm {
  name: string;
  role: string;
  engine: Agent["engine"];
  model: string;
  instructions: string;
  avatarStyle: string;
  useMySetup: boolean;
  permissionMode: Agent["permissionMode"];
  folders: string[];
  computer: Agent["computer"];
  connectors: Agent["connectors"];
}

export interface TaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  assigneeId?: string | null;
}

export interface TaskPatch extends Partial<TaskInput> {
  showMacText?: { title?: string; description?: string };
}

export interface ScheduleInput {
  kind: ScheduleKind;
  at: string | null;
  everyMinutes: number | null;
  prompt: string;
  enabled?: boolean;
}

export interface ArchitectMessage {
  role: "user" | "assistant";
  text: string;
}

export const api = {
  options: () => request(shape.hubOptions, "/api/options"),
  templates: () => request(z.array(shape.template), "/api/templates"),
  messages: (id: string) => request(z.array(shape.message), `/api/agents/${id}/messages`),
  createAgent: (form: AgentForm, avatarSeed?: string) =>
    request(shape.agent, "/api/agents", { method: "POST", body: JSON.stringify(avatarSeed === undefined ? form : { ...form, avatarSeed }) }),
  updateAgent: (id: string, form: Partial<AgentForm>) => request(shape.agent, `/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(form) }),
  deleteAgent: (id: string) => request(shape.ok, `/api/agents/${id}`, { method: "DELETE" }),
  shuffleAvatar: (id: string) => request(shape.agent, `/api/agents/${id}/avatar`, { method: "POST" }),
  send: (id: string, text: string) => request(shape.ok, `/api/agents/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  stop: (id: string) => request(shape.ok, `/api/agents/${id}/stop`, { method: "POST" }),
  decide: (id: string, allow: boolean, remember = false) =>
    request(approval, `/api/approvals/${id}`, { method: "POST", body: JSON.stringify({ allow, remember }) }),
  startComputer: (id: string) => request(shape.computerStatus, `/api/agents/${id}/computer/start`, { method: "POST" }),
  stopComputer: (id: string) => request(shape.computerStatus, `/api/agents/${id}/computer/stop`, { method: "POST" }),
  screen: (id: string) => request(shape.screenSecrets, `/api/agents/${id}/computer/screen`),
  computers: () => request(z.array(shape.computerResource), "/api/computers"),
  createComputer: (input: { name: string; runtime: "docker"; profile: "terminal" | "browser" | "desktop" }) =>
    request(shape.computerResource, "/api/computers", { method: "POST", body: JSON.stringify(input) }),
  updateComputer: (id: string, patch: { name?: string; runtime?: "docker"; profile?: "terminal" | "browser" | "desktop"; managed?: boolean }) =>
    request(shape.computerResource, `/api/computers/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteComputer: (id: string) => request(shape.ok, `/api/computers/${id}`, { method: "DELETE" }),
  moveComputerEngine: (id: string) => request(shape.computerResource, `/api/computers/${id}/move-engine`, { method: "POST", body: "{}" }),
  attachComputer: (agentId: string, computerId: string) =>
    request(shape.agent, `/api/agents/${agentId}/computer`, { method: "PUT", body: JSON.stringify({ computerId }) }),
  detachComputer: (agentId: string) => request(shape.ok, `/api/agents/${agentId}/computer`, { method: "DELETE" }),
  runtimeCapabilities: () => request(runtimeCapabilitiesSchema, "/api/computer-runtimes"),
  pause: () => request(shape.paused, "/api/pause", { method: "POST", body: "{}" }),
  resume: () => request(shape.paused, "/api/resume", { method: "POST", body: "{}" }),
  setBudgets: (limits: Partial<BudgetLimits>) => request(budgets, "/api/budgets", { method: "PUT", body: JSON.stringify(limits) }),
  setDailyBudget: (id: string, dailyBudget: number | null) => request(shape.agent, `/api/agents/${id}`, { method: "PATCH", body: JSON.stringify({ dailyBudget }) }),
  removeRule: (id: string, rule: string) => request(shape.rules, `/api/agents/${id}/rules`, { method: "DELETE", body: JSON.stringify({ rule }) }),
  schedules: (id: string) => request(z.array(shape.schedule), `/api/agents/${id}/schedules`),
  addSchedule: (id: string, input: ScheduleInput) => request(shape.schedule, `/api/agents/${id}/schedules`, { method: "POST", body: JSON.stringify(input) }),
  updateSchedule: (id: string, scheduleId: string, patch: Partial<ScheduleInput>) =>
    request(shape.schedule, `/api/agents/${id}/schedules/${scheduleId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSchedule: (id: string, scheduleId: string) => request(shape.ok, `/api/agents/${id}/schedules/${scheduleId}`, { method: "DELETE" }),
  architect: (messages: readonly ArchitectMessage[]) => request(shape.architectReply, "/api/architect", { method: "POST", body: JSON.stringify({ messages }) }),
  stopArchitect: () => request(shape.ok, "/api/architect/stop", { method: "POST", body: "{}" }),
  tasks: () => request(z.array(task), "/api/tasks"),
  task: (id: string) => request(taskThread, `/api/tasks/${id}`),
  createTask: (input: TaskInput) => request(task, "/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  updateTask: (id: string, patch: TaskPatch) => request(task, `/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  comment: (id: string, text: string) => request(taskEvent, `/api/tasks/${id}/comments`, { method: "POST", body: JSON.stringify({ text }) }),
};

export function avatarUrl(agent: Pick<Agent, "id" | "avatarSeed">): string {
  return `/avatars/${agent.id}.svg?v=${encodeURIComponent(agent.avatarSeed)}`;
}

export function previewAvatarUrl(style: string, seed: string): string {
  return `/avatars/preview.svg?style=${encodeURIComponent(style)}&seed=${encodeURIComponent(seed || "Hive")}`;
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

export const ENGINE_NAMES: Record<Agent["engine"], string> = { "claude-code": "Claude Code", codex: "Codex" };

export const STATUS_LABELS: Record<Agent["status"], string> = {
  sleeping: "Sleeping",
  working: "Working",
  "waiting-approval": "Needs approval",
  error: "Error",
};
