export const APPROVAL_TOOL = "mcp__hive__approve";

export const COMPUTER_ACTIONS = ["run", "screenshot", "click", "type", "key", "open", "read_file", "write_file", "export"] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

export function computerToolName(action: ComputerAction): string {
  return `mcp__hive__computer_${action}`;
}

export const EXPORT_TOOL = computerToolName("export");

export const COMPUTER_TOOLS: ReadonlySet<string> = new Set(COMPUTER_ACTIONS.map(computerToolName));

export const AUTO_ALLOWED_COMPUTER_TOOLS: ReadonlySet<string> = new Set(
  COMPUTER_ACTIONS.filter((action) => action !== "export").map(computerToolName),
);

export const TASK_ACTIONS = ["list_agents", "list_tasks", "create_task", "update_task", "comment_task", "handoff_task", "message_agent"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

export function taskToolName(action: TaskAction): string {
  return `mcp__hive__${action}`;
}

export const TASK_TOOLS: ReadonlySet<string> = new Set(TASK_ACTIONS.map(taskToolName));
