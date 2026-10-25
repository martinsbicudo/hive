import { INSTANCE_LABEL, type ComputerNames } from "./computerArgs.ts";
import type { DockerRunner } from "./docker.ts";
import { log } from "./log.ts";

type Kind = "container" | "network" | "volume";

const LABEL_FORMAT: Record<Kind, string> = {
  container: `{{index .Config.Labels "${INSTANCE_LABEL}"}}`,
  network: `{{index .Labels "${INSTANCE_LABEL}"}}`,
  volume: `{{index .Labels "${INSTANCE_LABEL}"}}`,
};

export type Owner = "missing" | "ours" | "foreign";

export async function ownerOf(docker: DockerRunner, instanceId: string, kind: Kind, name: string): Promise<Owner> {
  const inspected = await docker([kind, "inspect", "--format", LABEL_FORMAT[kind], name]);
  if (inspected.code !== 0) return "missing";
  return inspected.stdout.toString("utf8").trim() === instanceId ? "ours" : "foreign";
}

// Names are predictable, so another Hive instance (or anyone) may own a resource with the same name.
export async function owned(docker: DockerRunner, instanceId: string, kind: Kind, names: readonly string[]): Promise<string[]> {
  const mine: string[] = [];
  for (const name of names) {
    const inspected = await docker([kind, "inspect", "--format", LABEL_FORMAT[kind], name]);
    if (inspected.code !== 0) continue;
    if (inspected.stdout.toString("utf8").trim() === instanceId) mine.push(name);
    else log(`left ${kind} ${name} alone: it doesn't belong to this Hive`);
  }
  return mine;
}

export async function removeOwnedContainers(docker: DockerRunner, instanceId: string, names: readonly string[]): Promise<void> {
  const containers = await owned(docker, instanceId, "container", names);
  if (containers.length > 0) await docker(["rm", "-f", ...containers]);
}

export async function removeOwnedComputer(docker: DockerRunner, instanceId: string, names: ComputerNames): Promise<void> {
  await removeOwnedContainers(docker, instanceId, [names.agent, names.holder]);
  for (const network of await owned(docker, instanceId, "network", [names.network])) await docker(["network", "rm", network]);
  for (const volume of await owned(docker, instanceId, "volume", [names.volume])) await docker(["volume", "rm", "-f", volume]);
}
