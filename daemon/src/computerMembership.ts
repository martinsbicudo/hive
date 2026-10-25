import { checkPlacement, ValidationError } from "./agentFields.ts";
import type { ComputerLeases } from "./computerLeases.ts";
import type { ComputerManagementDeps } from "./computerManagement.ts";
import { finishMutationTargets, preemptMembers, reserveTargets, resumeMembers } from "./computerManagementInvalidation.ts";
import { NotFoundError } from "./httpError.ts";
import type { ComputerResource } from "./types.ts";

export interface MembershipHost {
  deps: ComputerManagementDeps;
  leases: ComputerLeases;
  get(id: string): ComputerResource;
}

const membersOf = (resource: ComputerResource) => resource.members.map((member) => member.agentId);

// Reserves the computers, then rechecks: if the agent moved while this waited, the caller starts over.
async function withTargets(host: MembershipHost, agentId: string, computerIds: readonly string[], work: () => Promise<void>): Promise<boolean> {
  const before = host.deps.store.getAgent(agentId)?.computerId ?? null;
  const locked = await reserveTargets(host.leases, computerIds);
  try {
    const agent = host.deps.store.getAgent(agentId);
    if (!agent) throw new NotFoundError("agent not found");
    if (agent.computerId !== before) return false;
    await work();
    return true;
  } finally {
    finishMutationTargets(host.leases, host.deps, locked);
  }
}

export async function attachAgent(host: MembershipHost, agentId: string, computerId: string): Promise<void> {
  const { store, computers, tasks } = host.deps;
  const current = store.getAgent(agentId);
  if (!current) throw new NotFoundError("agent not found");
  const target = host.get(computerId);
  if (!target.managed && target.id !== agentId) throw new ValidationError("a private computer can only be assigned to its agent");
  checkPlacement(current.engine, "virtual", current.connectors);
  if (current.computerId === computerId) return;
  const previousId = current.computerId;
  const targets = previousId ? [computerId, previousId] : [computerId];
  const done = await withTargets(host, agentId, targets, async () => {
    const affected = new Set([agentId, ...membersOf(host.get(computerId)), ...(previousId ? membersOf(host.get(previousId)) : [])]);
    try {
      const interrupted = await preemptMembers(host.deps, host.leases, targets, affected, agentId);
      const now = new Date().toISOString();
      if (!store.computers.assign(agentId, computerId, now)) throw new NotFoundError("computer not found");
      store.updateAgent(agentId, { sessionId: null }, now);
      tasks.modeChanged(agentId, current.name, interrupted);
      if (previousId && !host.get(previousId).members.some((member) => member.agentId !== agentId)) void computers.stop(previousId);
      host.deps.changed();
    } finally {
      resumeMembers(host.deps, affected);
    }
  });
  if (!done) return attachAgent(host, agentId, computerId);
}

export async function detachAgent(host: MembershipHost, agentId: string): Promise<void> {
  const { store, computers, tasks } = host.deps;
  const current = store.getAgent(agentId);
  if (!current) throw new NotFoundError("agent not found");
  const computerId = current.computerId;
  if (computerId === null) return;
  const done = await withTargets(host, agentId, [computerId], async () => {
    const affected = new Set([agentId, ...membersOf(host.get(computerId))]);
    try {
      const interrupted = await preemptMembers(host.deps, host.leases, [computerId], affected, agentId);
      const now = new Date().toISOString();
      store.computers.detach(agentId, now);
      store.updateAgent(agentId, { sessionId: null }, now);
      tasks.modeChanged(agentId, current.name, interrupted);
      if (store.computers.resource(computerId)?.members.length === 0) void computers.stop(computerId);
      host.deps.changed();
    } finally {
      resumeMembers(host.deps, affected);
    }
  });
  if (!done) return detachAgent(host, agentId);
}
