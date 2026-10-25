import type { Agent } from "./api.ts";

type Connector = Agent["connectors"][number];

export const CONNECTOR_NAMES: Record<Connector, string> = { github: "GitHub", mail: "Mail", calendar: "Calendar", messages: "Messages" };

export function connectorNames(connectors: readonly Connector[]): string {
  const names = connectors.map((connector) => CONNECTOR_NAMES[connector]);
  const last = names.pop();
  return names.length === 0 ? (last ?? "") : `${names.join(", ")} and ${last}`;
}
