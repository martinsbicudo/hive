import { readdirSync, statSync } from "node:fs";
import { githubTool } from "../src/githubTool.ts";
import type { AgentInput } from "../src/agents.ts";
import type { RunContext } from "../src/runTokens.ts";
import { call, fakeCommands, field, tempDir, type CommandCall } from "./fixtures.ts";
import { context, hubHarness } from "./taskFixtures.ts";

export const GH = "/test/bin/gh";
export const ALLOWED_ENV = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "GH_HOST", "GH_PROMPT_DISABLED", "GH_NO_UPDATE_NOTIFIER", "GH_NO_EXTENSION_UPDATE_NOTIFIER", "NO_COLOR"]);
export const COMMENT = ["pr", "comment", "7", "-R", "o/r", "-b", "Looks good to me"];

interface Seen {
  cwd: string;
  mode: number;
  entries: number;
}

export async function ghHarness(reply: (call: CommandCall) => { stdout?: string; stderr?: string } = () => ({ stdout: "#7 Fix the thing" })) {
  const seen: Seen[] = [];
  const commands = fakeCommands((entry) => {
    const cwd = entry.options.cwd ?? "";
    seen.push({ cwd, mode: statSync(cwd).mode & 0o777, entries: readdirSync(cwd).length });
    return reply(entry);
  });
  const tmp = tempDir("hive-gh-test-");
  const h = await hubHarness(undefined, { commands: commands.runner, connectorTools: [githubTool({ findGh: () => GH, tmpRoot: () => tmp })] });
  const tokenFor = (agentId: string, overrides: Partial<RunContext> = {}) => {
    const ctx = context(agentId, overrides);
    return { ctx, token: h.hub.runTokens.issue(agentId, ctx) };
  };
  const gh = (token: string, args: unknown) => call(h.port, "POST", "/internal/connectors/github", { token, body: { args } });
  const ask = async (token: string, args: readonly string[] = COMMENT) => {
    const reply = await gh(token, args);
    const approvalId = field(reply.body, "approvalId");
    return { reply, approvalId: typeof approvalId === "string" ? approvalId : "" };
  };
  const wait = (token: string, approvalId: string) => call(h.port, "POST", "/internal/connectors/wait", { token, body: { approvalId } });
  const reviewer = (input: AgentInput = {}) => h.agent({ name: "Rita", connectors: ["github"], ...input });
  return { ...h, commands, seen, tmp, tokenFor, gh, ask, wait, reviewer };
}
