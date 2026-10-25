import type { z } from "zod";
import type { CommandRunner } from "./commandRunner.ts";
import { APPROVAL_TOOL, COMPUTER_TOOLS, TASK_TOOLS } from "./hiveTools.ts";
import { checkedDisplay, displaySummary } from "./outwardDisplay.ts";
import { parseOr400 } from "./taskCore.ts";
import type { RunContext } from "./runTokens.ts";
import type { ApprovalDisplay, Connector, MailDisplay, StoredAgent } from "./types.ts";

export type ConnectorKind = "read" | "outward";

export interface ConnectorContext {
  agentId: string;
  nonce: string;
  commands: CommandRunner;
  markTainted(): void;
}

export interface PreparedCall {
  kind: ConnectorKind;
  payload: Readonly<Record<string, unknown>>;
  summary?: string;
  display?: ApprovalDisplay;
  execute(ctx: ConnectorContext): Promise<unknown>;
}

export interface ConnectorTool {
  tool: string;
  connector: Connector;
  prepare(raw: unknown): PreparedCall;
}

export interface ConnectorToolSpec<T extends Record<string, unknown>> {
  tool: string;
  connector: Connector;
  kind: ConnectorKind;
  input: z.ZodType<T>;
  display?(input: T): MailDisplay;
  run(input: T, ctx: ConnectorContext): Promise<unknown>;
}

const TOOL_NAME = /^[a-z][a-z_]{0,39}$/;

export function connectorToolName(tool: string): string {
  return `mcp__hive__${tool}`;
}

export function checkedConnectorTool(tool: ConnectorTool): ConnectorTool {
  const name = connectorToolName(tool.tool);
  const taken = name === APPROVAL_TOOL || COMPUTER_TOOLS.has(name) || TASK_TOOLS.has(name) || tool.tool === "wait";
  if (!TOOL_NAME.test(tool.tool) || taken) throw new Error(`bad connector tool name ${tool.tool}`);
  return tool;
}

export function connectorTool<T extends Record<string, unknown>>(spec: ConnectorToolSpec<T>): ConnectorTool {
  return checkedConnectorTool({
    tool: spec.tool,
    connector: spec.connector,
    prepare: (raw) => {
      const input = Object.freeze(parseOr400(spec.input, raw));
      const execute = (ctx: ConnectorContext) => spec.run(input, ctx);
      if (!spec.display) return { kind: spec.kind, payload: input, execute };
      const display = checkedDisplay(spec.display(input));
      return { kind: spec.kind, payload: input, display, summary: displaySummary(spec.tool, display), execute };
    },
  });
}

export function connectorContext(context: RunContext, commands: CommandRunner): ConnectorContext {
  return {
    agentId: context.agentId,
    nonce: context.nonce,
    commands,
    markTainted: () => {
      context.tainted = true;
    },
  };
}

export function connectorAllowed(agent: Pick<StoredAgent, "computer" | "engine" | "connectors"> | null, connector: Connector): boolean {
  return agent !== null && agent.computer === "mac" && agent.engine === "claude-code" && agent.connectors.includes(connector);
}

export function connectorRegistry(tools: readonly ConnectorTool[]): ReadonlyMap<string, ConnectorTool> {
  const registry = new Map<string, ConnectorTool>();
  for (const tool of tools) {
    if (registry.has(tool.tool)) throw new Error(`connector tool ${tool.tool} is registered twice`);
    registry.set(tool.tool, tool);
  }
  return registry;
}
