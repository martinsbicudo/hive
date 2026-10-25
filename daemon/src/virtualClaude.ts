import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { namesFor } from "./computerArgs.ts";
import type { RunPlan } from "./engines.ts";
import { APPROVAL_TOOL, COMPUTER_TOOLS, TASK_TOOLS } from "./hiveTools.ts";

export const VIRTUAL_BUILT_IN_TOOLS = ["WebSearch"] as const;

export const VIRTUAL_DISALLOWED_TOOLS = [
  "Bash", "Monitor", "Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", "NotebookEdit", "WebFetch", "Agent",
  "Workflow", "Skill", "SendMessage", "ListAgents", "RemoteTrigger", "Artifact", "PushNotification", "CronCreate",
  "EnterWorktree", "LSP", "PowerShell",
] as const;

export const VIRTUAL_SETTINGS = {
  disableAllHooks: true,
  crossSessionInbound: "refuse",
  permissions: { deny: [...VIRTUAL_DISALLOWED_TOOLS] },
} as const;

const ALLOWED_INIT_TOOLS: ReadonlySet<string> = new Set([...VIRTUAL_BUILT_IN_TOOLS, ...COMPUTER_TOOLS, ...TASK_TOOLS, APPROVAL_TOOL]);

export function virtualClaudeArguments(plan: RunPlan): string[] {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--restricted",
    "--permission-prompt-tool", APPROVAL_TOOL,
    "--permission-mode", "manual",
    "--tools", VIRTUAL_BUILT_IN_TOOLS.join(","),
    "--disallowedTools", VIRTUAL_DISALLOWED_TOOLS.join(","),
    "--mcp-config", plan.mcpConfigPath, "--strict-mcp-config",
    "--setting-sources", "project",
    "--disable-slash-commands", "--no-chrome",
    "--settings", JSON.stringify(VIRTUAL_SETTINGS),
    "--append-system-prompt", plan.systemPrompt,
  ];
  if (plan.model) args.push("--model", plan.model);
  if (plan.sessionId) args.push("--resume", plan.sessionId);
  else args.push("--session-id", plan.newSessionId);
  return args;
}

export function toolsOutsideAllowlist(tools: unknown): string[] {
  if (!Array.isArray(tools)) return ["(no tool list)"];
  return tools.map((tool) => (typeof tool === "string" ? tool : JSON.stringify(tool))).filter((tool) => !ALLOWED_INIT_TOOLS.has(tool));
}

export function freshVirtualCwd(agentId: string, root: string = tmpdir()): string {
  const base = join(root, namesFor(agentId).agent);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const stats = lstatSync(base);
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== process.getuid?.()) {
    throw new Error(`${base} is not a private folder, so the run didn't start`);
  }
  const cwd = join(base, "cwd");
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { mode: 0o700 });
  return cwd;
}

export function removeVirtualCwd(agentId: string, root: string = tmpdir()): void {
  rmSync(join(root, namesFor(agentId).agent), { recursive: true, force: true });
}
