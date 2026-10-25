import { AGENT_LABEL, INSTANCE_LABEL, ROLE_LABEL, UUID } from "./computerArgs.ts";
import type { DockerRunner } from "./docker.ts";

interface Owned {
  id: string;
  agentId: string;
  role: string;
}

async function owned(docker: DockerRunner, instanceId: string, list: readonly string[], format: string): Promise<Owned[]> {
  const filters = ["--filter", `label=${AGENT_LABEL}`, "--filter", `label=${INSTANCE_LABEL}=${instanceId}`];
  const result = await docker([...list, ...filters, "--format", format]);
  if (result.code !== 0) throw new Error(`listing this Hive's computers: ${result.stderr.trim().split("\n").pop() ?? "docker failed"}`);
  return result.stdout.toString("utf8").split("\n").flatMap((line): Owned[] => {
    const [id, agentId, role] = line.trim().split("\t");
    return id && agentId && UUID.test(agentId) ? [{ id, agentId, role: role ?? "" }] : [];
  });
}

export async function reconcileComputers(docker: DockerRunner, instanceId: string, knownIds: ReadonlySet<string>): Promise<string[]> {
  const [containers, networks, volumes] = await Promise.all([
    owned(docker, instanceId, ["ps", "-a"], `{{.ID}}\t{{.Label "${AGENT_LABEL}"}}\t{{.Label "${ROLE_LABEL}"}}`),
    owned(docker, instanceId, ["network", "ls"], `{{.ID}}\t{{.Label "${AGENT_LABEL}"}}`),
    owned(docker, instanceId, ["volume", "ls"], `{{.Name}}\t{{.Label "${AGENT_LABEL}"}}`),
  ]);
  const ofAgent = (list: Owned[], agentId: string, role?: string) =>
    list.filter((entry) => entry.agentId === agentId && (role === undefined || entry.role === role)).map((entry) => entry.id);
  const stopped: string[] = [];
  for (const agentId of new Set([...containers, ...networks, ...volumes].map((entry) => entry.agentId))) {
    if (knownIds.has(agentId)) {
      const computer = ofAgent(containers, agentId, "computer");
      const holders = ofAgent(containers, agentId, "netns");
      if (computer.length > 0) await docker(["stop", "-t", "3", ...computer]);
      if (holders.length > 0) await docker(["rm", "-f", ...holders]);
      stopped.push(agentId);
      continue;
    }
    const removable = ofAgent(containers, agentId);
    if (removable.length > 0) await docker(["rm", "-f", ...removable]);
    for (const network of ofAgent(networks, agentId)) await docker(["network", "rm", network]);
    for (const volume of ofAgent(volumes, agentId)) await docker(["volume", "rm", "-f", volume]);
  }
  return stopped;
}
