import type { ComputerResource } from "./computerTypes.ts";
import type { ComputerLeases } from "./computerLeases.ts";
import type { ComputerManagementDeps } from "./computerManagement.ts";
import type { RunEntry } from "./runJobs.ts";

export function invalidateResourceMembers(deps: ComputerManagementDeps, resource: ComputerResource): void {
  for (const member of resource.members) {
    deps.computers.forgetGrants(member.agentId);
    deps.approvals.denyAllFor(member.agentId);
    deps.connectorGate.denyFor(member.agentId);
  }
}

// Targets are reserved in sorted order, so two mutations over the same pair can't each hold one and wait on the other.
export async function reserveTargets(leases: ComputerLeases, computerIds: readonly string[]): Promise<string[]> {
  const locked: string[] = [];
  for (const computerId of [...new Set(computerIds)].sort()) {
    while (!leases.reserveMutation(computerId)) await leases.waitForMutation(computerId);
    locked.push(computerId);
  }
  return locked;
}

// Cuts the members off now and waits until the drained lease lets go of each computer, so the change commits on an idle computer.
export async function preemptMembers(
  deps: ComputerManagementDeps, leases: ComputerLeases, computerIds: readonly string[], agentIds: ReadonlySet<string>, agentId: string | null = null,
): Promise<RunEntry | null> {
  for (const computerId of computerIds) leases.invalidateComputer(computerId);
  let interrupted: RunEntry | null = null;
  for (const member of agentIds) {
    const entry = deps.runner.interrupt(member, false);
    if (member === agentId) interrupted = entry;
    leases.invalidateAgent(member);
    deps.approvals.denyAllFor(member);
    deps.connectorGate.denyFor(member);
    deps.computers.forgetGrants(member);
  }
  await Promise.all(computerIds.map((computerId) => leases.waitForRelease(computerId)));
  return interrupted;
}

export function resumeMembers(deps: ComputerManagementDeps, agentIds: Iterable<string>): void {
  for (const member of agentIds) if (deps.store.getAgent(member)) deps.runner.resume(member);
}

export function finishMutationTargets(leases: ComputerLeases, deps: ComputerManagementDeps, computerIds: readonly string[]): void {
  for (const computerId of computerIds) leases.finishMutation(computerId, deps.store.computers.get(computerId)?.revision ?? null);
}
