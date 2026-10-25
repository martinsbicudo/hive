import type { ComputerConfig, ComputerService, ComputerServiceOptions } from "./computerService.ts";
import type { Screen } from "./computers.ts";
import type { Store } from "./db.ts";
import { ValidationError } from "./agentFields.ts";
import { NotFoundError } from "./httpError.ts";
import { PAUSED_MESSAGE } from "./runGate.ts";
import type { ComputerProfile, ComputerResource, ComputerRuntime, ComputerStatus } from "./types.ts";

export class NotVirtualError extends Error {}

export interface RuntimeReadiness {
  ready: boolean;
  detail: string;
  profiles: readonly ComputerProfile[];
}

export async function runtimeReadiness(computers: Pick<ComputerService, "runtimeInfo">, runtime: ComputerRuntime): Promise<RuntimeReadiness> {
  const capability = (await computers.runtimeInfo()).runtimes.find((entry) => entry.runtime === runtime);
  return capability ? {
    ready: capability.status === "ready", detail: capability.detail,
    profiles: capability.capabilities.profiles,
  } : { ready: false, detail: `the ${runtime} runtime isn't available`, profiles: [] };
}

export function computerServiceOptions(store: Store): Pick<ComputerServiceOptions, "computerForAgent" | "computerResources" | "bindEngine"> {
  const config = (resource: ComputerResource): ComputerConfig => ({
    ...resource, memberAgentIds: resource.members.map((member) => member.agentId),
  });
  return {
    computerForAgent: (agentId) => {
      const resource = store.computers.forAgent(agentId);
      return resource ? config(resource) : null;
    },
    computerResources: () => store.computers.resources().map(config),
    bindEngine: (computerId, provider) => {
      store.computers.setEngine(computerId, provider, new Date().toISOString());
    },
  };
}

// Agent ids stay known so an agent an older build moved to the Mac keeps its labelled home volume.
export function knownComputerIds(store: Store): Set<string> {
  return new Set([...store.computers.resources().map((computer) => computer.id), ...store.listAgents().map((agent) => agent.id)]);
}

export function computerStatus(store: Store, computers: ComputerService, agentId: string): ComputerStatus {
  const agent = store.getAgent(agentId);
  if (!agent) throw new NotFoundError("agent not found");
  const resource = store.computers.forAgent(agentId);
  if (!resource) throw new NotVirtualError("this agent works on your Mac, not on a virtual computer");
  return {
    ...computers.statusOf(resource.id), computerId: resource.id, profile: resource.profile, hasScreen: resource.profile !== "terminal",
  };
}

export function startComputer(store: Store, computers: ComputerService, agentId: string): ComputerStatus {
  const agent = store.getAgent(agentId);
  if (!agent) throw new NotFoundError("agent not found");
  const resource = store.computers.forAgent(agentId);
  if (!resource) throw new NotVirtualError("this agent works on your Mac, not on a virtual computer");
  if (store.settings.paused()) throw new ValidationError(PAUSED_MESSAGE);
  computers.start(resource.id);
  return computerStatus(store, computers, agentId);
}

export async function stopComputer(store: Store, computers: ComputerService, agentId: string): Promise<ComputerStatus> {
  const agent = store.getAgent(agentId);
  if (!agent) throw new NotFoundError("agent not found");
  const resource = store.computers.forAgent(agentId);
  if (!resource) throw new NotVirtualError("this agent works on your Mac, not on a virtual computer");
  await computers.stop(resource.id);
  return computerStatus(store, computers, agentId);
}

export function computerScreen(store: Store, computers: ComputerService, agentId: string): Screen | null {
  const agent = store.getAgent(agentId);
  if (!agent) throw new NotFoundError("agent not found");
  const resource = store.computers.forAgent(agentId);
  if (!resource) throw new NotVirtualError("this agent works on your Mac, not on a virtual computer");
  return computers.screen(resource.id);
}
