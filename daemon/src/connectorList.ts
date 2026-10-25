import { MAC_CONNECTOR_TOOLS } from "./connectors.ts";
import type { ConnectorTool } from "./connectorTools.ts";
import { githubTool } from "./githubTool.ts";

export const CONNECTOR_TOOLS: readonly ConnectorTool[] = [githubTool(), ...MAC_CONNECTOR_TOOLS];
