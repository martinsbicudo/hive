import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerComputerTools } from "./computerTools.ts";
import { enabledConnectors, registerConnectorTools } from "./connectorClient.ts";
import { registerTaskTools } from "./taskTools.ts";

const url = process.env.HIVE_URL ?? "";
const token = process.env.HIVE_TOKEN ?? "";
const agentId = process.env.HIVE_AGENT_ID ?? "";

type Decision = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (!response.ok) throw new Error(`Hive answered ${response.status}`);
  return response.json();
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? Object.entries(value).find(([name]) => name === key)?.[1] : undefined;
}

async function waitForApproval(id: string): Promise<string> {
  for (;;) {
    const status = field(await call(`/internal/approvals/${encodeURIComponent(id)}/wait`), "status");
    if (status !== "pending") return typeof status === "string" ? status : "expired";
  }
}

async function decide(toolName: string, input: Record<string, unknown>): Promise<Decision> {
  const created = await call("/internal/approvals", { method: "POST", body: JSON.stringify({ agentId, toolName, input }) });
  if (field(created, "autoAllowed") === true) return { behavior: "allow", updatedInput: input };
  const id = field(created, "id");
  if (typeof id !== "string") return { behavior: "deny", message: "Hive couldn't register the approval request." };
  const status = await waitForApproval(id);
  if (status === "allowed") return { behavior: "allow", updatedInput: input };
  if (status === "denied") return { behavior: "deny", message: "The user denied this action. Don't retry it; ask or try another approach." };
  return { behavior: "deny", message: "The approval request expired without an answer." };
}

const server = new McpServer({ name: "hive", version: "0.1.0" });

server.registerTool(
  "approve",
  {
    description: "Asks the Hive user to approve a tool call. Used by Claude Code as its permission prompt tool.",
    inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() },
  },
  async ({ tool_name, input }) => {
    let decision: Decision;
    try {
      decision = await decide(tool_name, input);
    } catch (error) {
      decision = { behavior: "deny", message: `Hive isn't reachable (${String(error)}), so the action was not approved.` };
    }
    return { content: [{ type: "text", text: JSON.stringify(decision) }] };
  },
);

if (process.env.HIVE_COMPUTER === "1") registerComputerTools(server, { url, token, waitForApproval });
registerTaskTools(server, { url, token });
registerConnectorTools(server, { url, token }, enabledConnectors(process.env.HIVE_CONNECTORS));

await server.connect(new StdioServerTransport());
