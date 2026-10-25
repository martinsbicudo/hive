import { APPROVAL_TOOL } from "./hiveTools.ts";
import type { ComputerMode, Engine, PermissionMode } from "./types.ts";
import { virtualClaudeArguments } from "./virtualClaude.ts";

export { APPROVAL_TOOL } from "./hiveTools.ts";

export type EngineEvent =
  | { kind: "session"; id: string }
  | { kind: "init"; tools: string[] | null }
  | { kind: "delta"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "usage"; costUsd: number; inputTokens: number; outputTokens: number; model: string | null }
  | { kind: "error"; message: string };

export interface RunPlan {
  engine: Engine;
  model: string | null;
  sessionId: string | null;
  newSessionId: string;
  systemPrompt: string;
  workspace: string;
  folders: string[];
  allowedTools: string[];
  permissionMode: PermissionMode;
  useMySetup: boolean;
  mcpConfigPath: string;
  computer: ComputerMode;
  tainted: boolean;
}

export const TAINTED_MAC_DISALLOWED_TOOLS = [
  "SendMessage", "ListAgents", "RemoteTrigger", "Workflow", "CronCreate", "CronDelete", "ScheduleWakeup", "PushNotification", "DesignSync",
] as const;

export const CONNECTOR_BLOCKED_RULE = "WebFetch";

export const KNOWN_RULE_TOOLS: ReadonlySet<string> = new Set([
  "Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite",
]);

export const BINARIES: Record<Engine, string> = { "claude-code": "claude", codex: "codex" };

export function claudeArguments(plan: RunPlan): string[] {
  if (plan.computer === "virtual") return virtualClaudeArguments(plan);
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-prompt-tool", APPROVAL_TOOL,
    "--permission-mode", plan.permissionMode === "accept-edits" ? "acceptEdits" : "manual",
    "--mcp-config", plan.mcpConfigPath,
    "--append-system-prompt", plan.systemPrompt,
  ];
  if (!plan.useMySetup) args.push("--strict-mcp-config", "--setting-sources", "project");
  if (plan.model) args.push("--model", plan.model);
  if (plan.sessionId) args.push("--resume", plan.sessionId);
  else args.push("--session-id", plan.newSessionId);
  const preAllowed = plan.allowedTools.filter((rule) => KNOWN_RULE_TOOLS.has(rule));
  if (preAllowed.length > 0) args.push("--allowedTools", ...preAllowed);
  for (const folder of plan.folders) args.push("--add-dir", folder);
  if (plan.tainted) args.push("--disallowedTools", TAINTED_MAC_DISALLOWED_TOOLS.join(","));
  return args;
}

export function codexArguments(plan: RunPlan): string[] {
  const shared = ["--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"'];
  if (plan.folders.length > 0) shared.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(plan.folders)}`);
  if (!plan.useMySetup) shared.push("--ignore-user-config");
  if (plan.model) shared.push("-m", plan.model);
  if (plan.sessionId) return ["exec", "resume", ...shared, plan.sessionId, "-"];
  return ["exec", ...shared, "-C", plan.workspace, "-"];
}

export function codexPrompt(systemPrompt: string, message: string, isNewSession: boolean): string {
  return isNewSession ? `${systemPrompt}\n\n---\n\n${message}` : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const DETAIL_LIMIT = 160;

export function summarizeTool(name: string, input: unknown): string {
  const pick = ["command", "file_path", "path", "url", "pattern", "query", "description"]
    .map((key) => str(field(input, key)))
    .find((value) => value !== undefined && value.length > 0);
  const detail = pick ?? (isRecord(input) && Object.keys(input).length > 0 ? JSON.stringify(input) : "");
  const short = detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT - 1)}…` : detail;
  return short ? `${name}: ${short}` : name;
}

export function shortenPaths(detail: string, workspace: string, home: string): string {
  return detail.split(workspace).join("workspace").split(home).join("~");
}

export function parseLine(engine: Engine, line: string): EngineEvent[] {
  if (!line.trim()) return [];
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  return engine === "claude-code" ? parseClaudeEvent(event) : parseCodexEvent(event);
}

export function parseClaudeEvent(event: unknown): EngineEvent[] {
  const type = str(field(event, "type"));
  if (type === "system" && field(event, "subtype") === "init") {
    const id = str(field(event, "session_id"));
    const tools = field(event, "tools");
    const init: EngineEvent = { kind: "init", tools: Array.isArray(tools) ? tools.map((tool) => (typeof tool === "string" ? tool : JSON.stringify(tool))) : null };
    return id ? [{ kind: "session", id }, init] : [init];
  }
  if (type === "stream_event") {
    const inner = field(event, "event");
    const delta = field(inner, "delta");
    const text = field(inner, "type") === "content_block_delta" && field(delta, "type") === "text_delta" ? str(field(delta, "text")) : undefined;
    return text ? [{ kind: "delta", text }] : [];
  }
  if (type === "assistant") {
    const content = field(field(event, "message"), "content");
    if (!Array.isArray(content)) return [];
    return content.flatMap((block): EngineEvent[] => {
      const blockType = str(field(block, "type"));
      const text = str(field(block, "text"));
      if (blockType === "text" && text?.trim()) return [{ kind: "text", text }];
      const name = str(field(block, "name"));
      if (blockType === "tool_use" && name && name !== APPROVAL_TOOL) return [{ kind: "tool", name, detail: summarizeTool(name, field(block, "input")) }];
      return [];
    });
  }
  if (type === "result") {
    const usage = field(event, "usage");
    const models = field(event, "modelUsage");
    const events: EngineEvent[] = [{
      kind: "usage",
      costUsd: num(field(event, "total_cost_usd")),
      inputTokens: num(field(usage, "input_tokens")) + num(field(usage, "cache_read_input_tokens")) + num(field(usage, "cache_creation_input_tokens")),
      outputTokens: num(field(usage, "output_tokens")),
      model: isRecord(models) ? Object.keys(models)[0] ?? null : null,
    }];
    const failed = field(event, "is_error") === true || (str(field(event, "subtype")) ?? "success") !== "success";
    if (failed) events.push({ kind: "error", message: str(field(event, "result")) ?? str(field(event, "subtype")) ?? "Claude Code failed" });
    return events;
  }
  return [];
}

export function parseCodexEvent(event: unknown): EngineEvent[] {
  const type = str(field(event, "type"));
  if (type === "thread.started") {
    const id = str(field(event, "thread_id"));
    return id ? [{ kind: "session", id }] : [];
  }
  if (type === "item.started" || type === "item.completed") {
    const item = field(event, "item");
    const itemType = str(field(item, "type"));
    if (type === "item.completed" && itemType === "agent_message") {
      const text = str(field(item, "text"));
      return text?.trim() ? [{ kind: "text", text }] : [];
    }
    if (type === "item.started" && itemType === "command_execution") {
      return [{ kind: "tool", name: "Shell", detail: summarizeTool("Shell", { command: field(item, "command") }) }];
    }
    if (type === "item.completed" && itemType === "file_change") {
      const changes = field(item, "changes");
      const paths = Array.isArray(changes) ? changes.map((change) => str(field(change, "path"))).filter((path) => path !== undefined) : [];
      return [{ kind: "tool", name: "Edit", detail: `Edit: ${paths.join(", ")}` }];
    }
    if (type === "item.started" && itemType === "mcp_tool_call") {
      const name = str(field(item, "tool")) ?? "MCP";
      return [{ kind: "tool", name, detail: name }];
    }
    return [];
  }
  if (type === "turn.completed") {
    const usage = field(event, "usage");
    return [{ kind: "usage", costUsd: 0, inputTokens: num(field(usage, "input_tokens")), outputTokens: num(field(usage, "output_tokens")), model: null }];
  }
  if (type === "turn.failed" || type === "error") {
    const message = str(field(field(event, "error"), "message")) ?? str(field(event, "message")) ?? "Codex failed";
    return [{ kind: "error", message }];
  }
  return [];
}
