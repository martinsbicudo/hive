import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { field, writeWhole } from "./fixtures.ts";

const dir = process.env.HIVE_FAKE_DIR ?? "";
const args = process.argv.slice(2);
const codex = args[0] === "exec";
const TASK_ID = /Task ([0-9a-f-]{36})/;
const DEFAULT_TOOLS = [
  "WebSearch", "mcp__hive__approve", "mcp__hive__list_agents", "mcp__hive__list_tasks", "mcp__hive__create_task",
  "mcp__hive__update_task", "mcp__hive__comment_task", "mcp__hive__handoff_task", "mcp__hive__message_agent",
];

interface Step {
  call?: string;
  body?: Record<string, unknown>;
  say?: string;
  sleepMs?: number;
  ignoreTerm?: boolean;
}

function after(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

function json(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function emit(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return vars[value] ?? value;
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, vars)]));
  return value;
}

async function post(url: string, token: string, route: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${url}/internal/tasks/${route}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function call(url: string, token: string, route: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const first = await post(url, token, route, body);
  const approvalId = field(first.body, "approvalId");
  if (first.status !== 200 || typeof approvalId !== "string") return first;
  for (;;) {
    const waited = await post(url, token, "wait", { approvalId });
    if (field(waited.body, "status") !== "pending") return { status: waited.status, body: { approvalId, ...Object(waited.body) } };
  }
}

const stdin = await readStdin();
const system = codex ? stdin : after("--append-system-prompt") ?? "";
const agent = /You are (.+?), a /.exec(system)?.[1] ?? "unknown";
const id = `${process.hrtime.bigint()}-${process.pid}`;
const index = readdirSync(dir).filter((name) => name.startsWith("start-") && json(join(dir, name)) === agent).length;
writeWhole(join(dir, `start-${id}.json`), JSON.stringify(agent));
const script = json(join(dir, "script.json"));
const runs = field(script, agent);
const steps: Step[] = Array.isArray(runs) && Array.isArray(runs[index]) ? runs[index] : [{ say: `${agent} done` }];
const config = json(after("--mcp-config") ?? "");
const env = field(field(field(config, "mcpServers"), "hive"), "env");
const url = String(field(env, "HIVE_URL") ?? "");
const token = String(field(env, "HIVE_TOKEN") ?? "");
const session = after("--resume") ?? after("--session-id") ?? (codex ? args.at(-2) ?? "" : "");
const vars: Record<string, string> = { $TASK: TASK_ID.exec(stdin)?.[1] ?? "" };

if (codex) emit({ type: "thread.started", thread_id: args[1] === "resume" ? session : randomUUID() });
else emit({ type: "system", subtype: "init", session_id: session, tools: DEFAULT_TOOLS });
const calls: { route: string; status: number; body: unknown }[] = [];
for (const step of steps) {
  if (step.ignoreTerm) {
    process.on("SIGTERM", () => undefined);
    writeFileSync(join(dir, `armed-${id}`), "");
  }
  if (step.sleepMs) await new Promise((resolve) => setTimeout(resolve, step.sleepMs));
  if (step.call) {
    const reply = await call(url, token, step.call, substitute(step.body ?? {}, vars));
    calls.push({ route: step.call, ...reply });
    const created = field(reply.body, "taskId");
    if (typeof created === "string") vars.$LAST = created;
  }
  if (step.say) {
    if (codex) emit({ type: "item.completed", item: { type: "agent_message", text: step.say } });
    else emit({ type: "assistant", message: { content: [{ type: "text", text: step.say }] } });
  }
}
writeWhole(join(dir, `run-${id}.json`), JSON.stringify({ agent, index, args, stdin, codex, hasToken: token !== "", calls }));
if (codex) emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
else emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0, usage: {} });
