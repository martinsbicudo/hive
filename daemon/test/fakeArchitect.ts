import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { field, writeWhole } from "./fixtures.ts";

const dir = process.env.HIVE_FAKE_DIR ?? "";
const id = `${process.hrtime.bigint()}-${process.pid}`;

export const BUILT_IN_PLUGINS = [
  { name: "cc-plugin-agents-md", path: "builtin", source: "cc-plugin-agents-md@builtin" },
  { name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" },
  { name: "cc-plugin-plugin-authoring", path: "builtin", source: "cc-plugin-plugin-authoring@builtin" },
];

export function probeInit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system", subtype: "init", cwd: process.cwd(), session_id: "2d5459a4-3e4a-4faa-950d-d230d4bbae78", tools: [], mcp_servers: [],
    model: "claude-haiku-5-5", permissionMode: "default", slash_commands: [], claude_code_version: "2.1.308",
    agents: ["claude", "Explore", "general-purpose", "Plan", "statusline-setup"], skills: [], plugins: BUILT_IN_PLUGINS, ...overrides,
  };
}

export interface ArchitectStep {
  emit?: unknown;
  say?: string;
  sleepMs?: number;
  writeFile?: string;
  ignoreTerm?: boolean;
}

export interface ArchitectRun {
  init?: unknown;
  steps?: ArchitectStep[];
  cost?: number;
}

function emit(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function script(): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, "script.json"), "utf8"));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  let stdin = "";
  for await (const chunk of process.stdin) stdin += String(chunk);
  const index = readdirSync(dir).filter((name) => name.startsWith("start-")).length;
  writeWhole(join(dir, `start-${id}.json`), JSON.stringify({
    index, args: process.argv.slice(2), stdin, cwd: process.cwd(),
    env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, ENABLE_CLAUDEAI_MCP_SERVERS: process.env.ENABLE_CLAUDEAI_MCP_SERVERS },
  }));
  const runs = script();
  const run = Array.isArray(runs) ? runs[index] : undefined;
  const init = field(run, "init");
  const steps = field(run, "steps");
  const cost = field(run, "cost");
  if (init !== null) emit(init === undefined ? probeInit() : init);
  const said: string[] = [];
  for (const step of Array.isArray(steps) ? steps : [{ say: "What should the agent do?" }]) {
    if (field(step, "ignoreTerm") === true) {
      process.on("SIGTERM", () => undefined);
      writeFileSync(join(dir, `armed-${id}`), "");
    }
    const file = field(step, "writeFile");
    if (typeof file === "string") writeFileSync(join(process.cwd(), file), "scratch");
    const sleepMs = field(step, "sleepMs");
    if (typeof sleepMs === "number") await new Promise((resolve) => setTimeout(resolve, sleepMs));
    const event = field(step, "emit");
    if (event !== undefined) emit(event);
    const say = field(step, "say");
    if (typeof say === "string") {
      said.push(say);
      emit({ type: "assistant", message: { model: "claude-haiku-5-5", role: "assistant", content: [{ type: "text", text: say }] } });
    }
  }
  emit({
    type: "result", subtype: "success", is_error: false, total_cost_usd: typeof cost === "number" ? cost : 0.001,
    usage: { input_tokens: 2, output_tokens: 4 }, modelUsage: { "claude-haiku-5-5": {} }, result: said.join("\n"),
  });
  writeWhole(join(dir, `done-${id}.json`), "true");
}

if (dir) await main();
