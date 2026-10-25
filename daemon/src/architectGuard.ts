import { z } from "zod";

export const ARCHITECT_MODEL = "haiku";
export const TOOL_MESSAGE = "The Architect tried to use a tool.";
export const UNSAFE_START = "The Architect didn't start without tools, so Hive stopped it.";
export const UNCHECKED_OUTPUT = "The Architect sent something Hive couldn't check, so Hive stopped it.";

const INSTRUCTION_FILES_PLUGIN = "cc-plugin-agents-md@builtin";
const BUILT_IN = "builtin";

export const ARCHITECT_SETTINGS = {
  disableAllHooks: true,
  enabledPlugins: { [INSTRUCTION_FILES_PLUGIN]: false },
  pluginConfigs: { [INSTRUCTION_FILES_PLUGIN]: { instructionFiles: "managed-only" } },
} as const;

export const ARCHITECT_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" } as const;

export function architectArguments(systemPrompt: string): string[] {
  return [
    "-p", "--output-format", "stream-json", "--verbose",
    "--restricted", "--tools", "", "--disallowedTools", "*",
    "--strict-mcp-config", "--setting-sources", "",
    "--disable-slash-commands", "--no-chrome", "--no-session-persistence", "--max-turns", "1",
    "--settings", JSON.stringify(ARCHITECT_SETTINGS),
    "--system-prompt", systemPrompt,
    "--model", ARCHITECT_MODEL,
  ];
}

const eventKind = z.object({ type: z.string() });
const systemKind = z.object({ subtype: z.string().optional() });
const initEvent = z.object({
  tools: z.array(z.unknown()),
  mcp_servers: z.array(z.unknown()),
  plugins: z.array(z.object({ name: z.string(), path: z.string(), source: z.string() })),
});
const assistantEvent = z.object({ message: z.object({ content: z.array(z.object({ type: z.string() })) }) });
const ALLOWED_BLOCKS: ReadonlySet<string> = new Set(["text", "thinking"]);

export class ArchitectGuard {
  verified = false;
  violation: string | null = null;
  plugins: string[] = [];

  inspect(raw: unknown): string | null {
    if (this.violation !== null) return null;
    const kind = eventKind.safeParse(raw);
    if (!kind.success) return this.trip(UNCHECKED_OUTPUT);
    if (kind.data.type === "system") return this.system(raw);
    if (kind.data.type === "assistant") return this.assistant(raw);
    return null;
  }

  private system(raw: unknown): string | null {
    const system = systemKind.safeParse(raw);
    if (!system.success) return this.trip(UNCHECKED_OUTPUT);
    return system.data.subtype === "init" ? this.init(raw) : null;
  }

  private init(raw: unknown): string | null {
    const init = initEvent.safeParse(raw);
    if (!init.success) return this.trip(UNSAFE_START);
    this.plugins = init.data.plugins.map((plugin) => plugin.name);
    const builtIn = init.data.plugins.every((plugin) => plugin.path === BUILT_IN && plugin.source === `${plugin.name}@${BUILT_IN}`);
    if (init.data.tools.length > 0 || init.data.mcp_servers.length > 0 || !builtIn) return this.trip(UNSAFE_START);
    this.verified = true;
    return null;
  }

  private assistant(raw: unknown): string | null {
    if (!this.verified) return this.trip(UNSAFE_START);
    const event = assistantEvent.safeParse(raw);
    if (!event.success) return this.trip(UNCHECKED_OUTPUT);
    if (event.data.message.content.some((block) => !ALLOWED_BLOCKS.has(block.type))) return this.trip(TOOL_MESSAGE);
    return null;
  }

  private trip(reason: string): string {
    this.violation = reason;
    this.verified = false;
    return reason;
  }
}
