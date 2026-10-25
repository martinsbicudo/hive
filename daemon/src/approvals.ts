import { randomUUID } from "node:crypto";
import type { Store } from "./db.ts";
import { homedir } from "node:os";
import { KNOWN_RULE_TOOLS, shortenPaths, summarizeTool } from "./engines.ts";
import { agentWorkspacePath } from "./paths.ts";
import type { Approval, ApprovalDisplay, ApprovalStatus } from "./types.ts";

export const APPROVAL_TTL_MS = 30 * 60 * 1000;

export const REMEMBERABLE_PROGRAMS: ReadonlySet<string> = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "grep", "which", "echo", "date", "du", "df", "stat", "diff", "jq",
  "basename", "dirname", "realpath",
]);

const REJECTED_FLAG_PREFIXES: readonly string[] = ["--pre", "--compress-program", "-o", "--output", "--exec", "-exec", "--files-from"];

export { KNOWN_RULE_TOOLS } from "./engines.ts";

const SHORT_FLAG_CLUSTER = /^-[A-Za-z0-9]+$/;
const SCOPED_RULE = /^(\w+)\((.+):\*\)$/;

const SAFE_COMMAND = /^[A-Za-z0-9_./:=,@+ -]+$/;

function isRememberableProgram(program: string): boolean {
  return !program.includes("/") && !program.includes("=") && REMEMBERABLE_PROGRAMS.has(program);
}

function safeProgram(command: unknown): string | null {
  if (typeof command !== "string" || !SAFE_COMMAND.test(command)) return null;
  const [program, ...args] = command.split(" ").filter(Boolean);
  if (!program || !isRememberableProgram(program)) return null;
  if (args.some((arg) => REJECTED_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix)))) return null;
  if (args.some((arg) => SHORT_FLAG_CLUSTER.test(arg) && arg.includes("o"))) return null;
  return program;
}

export function ruleFor(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === "Bash") {
    const program = safeProgram(input.command);
    return program ? `Bash(${program}:*)` : null;
  }
  return KNOWN_RULE_TOOLS.has(toolName) ? toolName : null;
}

function scopedProgram(rule: string): string | null {
  const scoped = SCOPED_RULE.exec(rule);
  return scoped?.[1] === "Bash" && scoped[2] !== undefined && isRememberableProgram(scoped[2]) ? scoped[2] : null;
}

export function isUsableRule(rule: string): boolean {
  return KNOWN_RULE_TOOLS.has(rule) || scopedProgram(rule) !== null;
}

export function matchesRule(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  if (!isUsableRule(rule)) return false;
  const program = scopedProgram(rule);
  if (program === null) return rule === toolName;
  return toolName === "Bash" && safeProgram(input.command) === program;
}

type Listener = (status: ApprovalStatus) => void;

export interface ApprovalOptions {
  rememberable?: boolean;
  targetAgentId?: string | null;
  summary?: string;
  tainted?: boolean;
  display?: ApprovalDisplay;
}

export class Approvals {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly settledListeners = new Set<(approval: Approval) => void>();
  private readonly createdListeners = new Set<(approval: Approval) => void>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  private readonly store: Store;
  private readonly onChange: () => void;
  private readonly now: () => string;
  private readonly ttlMs: number;

  constructor(store: Store, onChange: () => void, now: () => string = () => new Date().toISOString(), ttlMs: number = APPROVAL_TTL_MS) {
    this.store = store;
    this.onChange = onChange;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  onSettled(listener: (approval: Approval) => void): void {
    this.settledListeners.add(listener);
  }

  onCreated(listener: (approval: Approval) => void): void {
    this.createdListeners.add(listener);
  }

  create(agentId: string, toolName: string, input: Record<string, unknown>, options: ApprovalOptions = {}): Approval {
    const approval: Approval = {
      id: randomUUID(),
      agentId,
      toolName,
      input,
      summary: options.summary ?? shortenPaths(summarizeTool(toolName, input), agentWorkspacePath(agentId), homedir()),
      status: "pending",
      rememberable: (options.rememberable ?? true) && ruleFor(toolName, input) !== null,
      targetAgentId: options.targetAgentId ?? null,
      tainted: options.tainted ?? false,
      display: options.display ?? null,
      createdAt: this.now(),
      decidedAt: null,
    };
    this.store.insertApproval(approval);
    this.timers.set(approval.id, setTimeout(() => this.settle(approval.id, "expired"), this.ttlMs).unref());
    this.onChange();
    for (const listener of this.createdListeners) listener(approval);
    return approval;
  }

  decide(id: string, allow: boolean): Approval | null {
    const approval = this.store.getApproval(id);
    if (!approval || approval.status !== "pending") return approval;
    this.settle(id, allow ? "allowed" : "denied");
    return this.store.getApproval(id);
  }

  wait(id: string, timeoutMs: number): Promise<ApprovalStatus> {
    const current = this.store.getApproval(id);
    if (!current || current.status !== "pending") return Promise.resolve(current?.status ?? "expired");
    return new Promise((resolve) => {
      const listeners = this.listeners.get(id) ?? new Set<Listener>();
      const timer = setTimeout(() => {
        listeners.delete(listener);
        resolve("pending");
      }, timeoutMs);
      const listener: Listener = (status) => {
        clearTimeout(timer);
        resolve(status);
      };
      listeners.add(listener);
      this.listeners.set(id, listeners);
    });
  }

  deny(id: string): void {
    this.settle(id, "denied");
  }

  denyAllFor(agentId: string, toolName?: string): void {
    for (const approval of this.store.pendingApprovals()) {
      if (approval.agentId === agentId && (toolName === undefined || approval.toolName === toolName)) this.settle(approval.id, "denied");
    }
  }

  denyInvolving(agentId: string, toolNames?: ReadonlySet<string>): void {
    for (const approval of this.store.pendingApprovals()) {
      const involved = approval.agentId === agentId || approval.targetAgentId === agentId;
      if (involved && (toolNames === undefined || toolNames.has(approval.toolName))) this.settle(approval.id, "denied");
    }
  }

  denyPending(): void {
    for (const approval of this.store.pendingApprovals()) this.settle(approval.id, "denied");
  }

  private settle(id: string, status: ApprovalStatus): void {
    if (this.store.getApproval(id)?.status !== "pending") return;
    this.store.decideApproval(id, status, this.now());
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const settled = this.store.getApproval(id);
    if (settled) for (const listener of this.settledListeners) listener(settled);
    for (const listener of this.listeners.get(id) ?? []) listener(status);
    this.listeners.delete(id);
    this.onChange();
  }
}
