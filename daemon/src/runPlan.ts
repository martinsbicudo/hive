import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { identityPrompt } from "./agents.ts";
import { isUsableRule } from "./approvals.ts";
import { CONNECTOR_BLOCKED_RULE, type RunPlan } from "./engines.ts";
import { resolveModel } from "./models.ts";
import { agentWorkspace, removeMcpConfig, runtimeDir } from "./paths.ts";
import type { StoredAgent } from "./types.ts";
import { freshVirtualCwd } from "./virtualClaude.ts";

export interface McpLaunch {
  command: string;
  args: string[];
  url: string;
}

export type { StoredAgent } from "./types.ts";

export function buildRunPlan(
  agent: StoredAgent, text: string, token: string | null, mcp: McpLaunch, sessionId: string | null, tainted: boolean, sharedWith: readonly string[] = [],
): RunPlan {
  const virtual = agent.computer === "virtual";
  const workspace = virtual ? freshVirtualCwd(agent.id) : agentWorkspace(agent.id);
  const mcpConfigPath = join(runtimeDir, `${agent.id}.mcp.json`);
  const reachesOutside = agent.connectors.length > 0;
  if (token === null) removeMcpConfig(agent.id);
  else writeMcpConfig(mcpConfigPath, agent, token, mcp);
  return {
    engine: agent.engine,
    model: resolveModel(agent.engine, agent.model, text),
    sessionId,
    newSessionId: randomUUID(),
    systemPrompt: identityPrompt(agent, sharedWith),
    workspace,
    folders: agent.folders,
    allowedTools: agent.allowedTools.filter((rule) => isUsableRule(rule) && !(reachesOutside && rule === CONNECTOR_BLOCKED_RULE)),
    permissionMode: agent.permissionMode,
    useMySetup: agent.useMySetup && !reachesOutside,
    mcpConfigPath,
    computer: agent.computer,
    tainted: tainted || reachesOutside,
  };
}

function writeMcpConfig(path: string, agent: StoredAgent, token: string, mcp: McpLaunch): void {
  const env = {
    HIVE_URL: mcp.url, HIVE_TOKEN: token, HIVE_AGENT_ID: agent.id, HIVE_COMPUTER: agent.computer === "virtual" ? "1" : "0",
    HIVE_CONNECTORS: agent.connectors.join(","),
  };
  const config = { mcpServers: { hive: { command: mcp.command, args: mcp.args, env } } };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
}
