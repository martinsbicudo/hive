import type { Store } from "./db.ts";
import { StaleRevisionError, type ComputerLease, type ComputerLeases } from "./computerLeases.ts";
import type { ComputerResource } from "./computerTypes.ts";
import type { ComputerRunBinding, RunContext } from "./runTokens.ts";
import type { ComputerService } from "./computerService.ts";

export async function prepareComputerRun(store: Store, computers: ComputerService, leases: ComputerLeases, agentId: string): Promise<ComputerRunBinding> {
  const { resource, lease } = await acquireCurrent(store, leases, agentId);
  try {
    if (!leases.isCurrent(agentId, resource.id, resource.revision, lease.id)) throw new Error("computer assignment changed while waiting");
    await computers.ensureRunning(agentId);
    const current = store.computers.forAgent(agentId);
    if (!current || current.id !== resource.id || current.revision !== resource.revision || !leases.isCurrent(agentId, resource.id, resource.revision, lease.id)) {
      throw new Error("computer assignment changed while preparing");
    }
    return {
      computerId: resource.id, computerRevision: resource.revision, computerRuntime: resource.runtime,
      computerProfile: resource.profile, computerLeaseId: lease.id,
      sharedWith: current.members.filter((member) => member.agentId !== agentId).map((member) => member.name),
    };
  } catch (error) {
    leases.release(lease.id);
    throw error;
  }
}

async function acquireCurrent(store: Store, leases: ComputerLeases, agentId: string): Promise<{ resource: ComputerResource; lease: ComputerLease }> {
  for (;;) {
    const resource = store.computers.forAgent(agentId);
    if (!resource) throw new Error("this agent isn't assigned to a virtual computer");
    try {
      return { resource, lease: await leases.acquire(agentId, resource.id, resource.revision) };
    } catch (error) {
      if (!(error instanceof StaleRevisionError) || store.computers.forAgent(agentId)?.revision === resource.revision) throw error;
    }
  }
}

export function releaseComputerRun(leases: ComputerLeases, binding: ComputerRunBinding): void {
  leases.release(binding.computerLeaseId);
}

export function computerRunIsCurrent(store: Store, leases: ComputerLeases, context: RunContext): boolean {
  const { computerId, computerRevision, computerLeaseId, agentId } = context;
  if (!computerId || computerRevision === null || !computerLeaseId) return false;
  const current = store.computers.forAgent(agentId);
  return current?.id === computerId && current.revision === computerRevision && leases.isCurrent(agentId, computerId, computerRevision, computerLeaseId);
}

export function exportLeaseIsCurrent(store: Store, leases: ComputerLeases, context: {
  agentId: string; computerId: string; computerRevision: number; computerLeaseId: string;
}): boolean {
  const current = store.computers.forAgent(context.agentId);
  return current?.id === context.computerId && current.revision === context.computerRevision &&
    leases.isCurrent(context.agentId, context.computerId, context.computerRevision, context.computerLeaseId);
}
