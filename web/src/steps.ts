const COMPUTER_STEP = /^mcp__hive__computer_([a-z_]+)(?::\s*(.*))?$/s;
const COMPUTER_VERBS: Record<string, string> = { read_file: "read", write_file: "write" };

function stepInput(detail: string): Record<string, unknown> | null {
  if (!detail.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : null;
  } catch {
    return null;
  }
}

function stepDetail(action: string, detail: string): string {
  const input = stepInput(detail);
  if (!input) return detail;
  if (action === "click") return `${String(input.x)}, ${String(input.y)}${input.button && input.button !== "left" ? ` (${String(input.button)})` : ""}`;
  if (action === "type" && typeof input.text === "string") return `“${input.text}”`;
  if (action === "key" && typeof input.keys === "string") return input.keys;
  return detail;
}

export function stepLabel(text: string): string {
  const match = COMPUTER_STEP.exec(text);
  if (!match) return text;
  const [, action = "", detail = ""] = match;
  if (action === "run") return `Computer: ${detail}`;
  const verb = COMPUTER_VERBS[action] ?? action.replace("_", " ");
  const shown = stepDetail(action, detail);
  return shown ? `Computer: ${verb} ${shown}` : `Computer: ${verb}`;
}
