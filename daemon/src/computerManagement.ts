import { ValidationError } from "./agentFields.ts";
import type { Approvals } from "./approvals.ts";
import type { ComputerService } from "./computerService.ts";
import type { Store } from "./db.ts";
import { NotFoundError } from "./httpError.ts";
import type { ConnectorApprovals } from "./connectorApprovals.ts";
import type { Runner } from "./runner.ts";
import { PAUSED_MESSAGE } from "./runGate.ts";
import type { RunEntry } from "./runJobs.ts";
import type { TaskService } from "./taskService.ts";
import type { ComputerProfile, ComputerResource, ComputerRuntime, ComputerStatus } from "./types.ts";
import { ComputerLeases } from "./computerLeases.ts";
import type { ComputerRunBinding, RunContext } from "./runTokens.ts";
import type { ExportSnapshot } from "./exportStaging.ts";
import { computerScreen, computerServiceOptions, computerStatus, NotVirtualError, runtimeReadiness, startComputer, stopComputer } from "./computerManagementHelpers.ts";
import type { RuntimeReadiness } from "./computerManagementHelpers.ts";
import { computerRunIsCurrent, exportLeaseIsCurrent, prepareComputerRun, releaseComputerRun } from "./computerManagementRuns.ts";
import { invalidateResourceMembers, preemptMembers, reserveTargets, resumeMembers } from "./computerManagementInvalidation.ts";
import { attachAgent, detachAgent, type MembershipHost } from "./computerMembership.ts";
export { NotVirtualError, computerServiceOptions, runtimeReadiness } from "./computerManagementHelpers.ts";
export type { RuntimeReadiness } from "./computerManagementHelpers.ts";

export interface ComputerManagementDeps {
  store: Store;
  computers: ComputerService;
  runner: Pick<Runner, "interrupt" | "resume" | "stop" | "waitForAgentIdle">;
  approvals: Pick<Approvals, "denyAllFor">;
  connectorGate: Pick<ConnectorApprovals, "denyFor">;
  tasks: Pick<TaskService, "modeChanged">;
  askToExport(agentId: string, snapshot: ExportSnapshot): string;
  runtimeReady(runtime: ComputerRuntime): Promise<RuntimeReadiness>;
  changed(): void;
}

export class ComputerManagement {
  private readonly deps: ComputerManagementDeps;
  readonly leases: ComputerLeases;

  constructor(deps: ComputerManagementDeps) {
    this.deps = deps;
    this.leases = new ComputerLeases({ drain: (lease) => deps.computers.drainLease(lease), revoked: (lease) => deps.computers.revokeLease(lease) });
    deps.computers.setComputerResolvers(computerServiceOptions(deps.store));
    deps.computers.setLeaseValidator((context) => this.exportLeaseIsCurrent(context));
    deps.computers.setStartGuard(() => (deps.store.settings.paused() ? PAUSED_MESSAGE : null));
  }

  list(): ComputerResource[] {
    return this.deps.store.computers.resources();
  }

  get(id: string): ComputerResource {
    const computer = this.deps.store.computers.resource(id);
    if (!computer) throw new NotFoundError("computer not found");
    return computer;
  }

  async create(name: string, runtime: ComputerRuntime, profile: ComputerProfile): Promise<ComputerResource> {
    await this.assertReady(runtime, profile);
    const computer = this.deps.store.computers.createManaged(name, runtime, profile, new Date().toISOString());
    this.deps.changed();
    return this.get(computer.id);
  }

  async update(id: string, patch: { name?: string; runtime?: ComputerRuntime; profile?: ComputerProfile; managed?: true }): Promise<ComputerResource> {
    this.get(id);
    if (patch.name !== undefined && Object.keys(patch).length === 1) return this.rename(id, patch.name);
    await reserveTargets(this.leases, [id]);
    let revision: number | null = null;
    let members: string[] = [];
    try {
      const resource = this.get(id);
      revision = resource.revision;
      members = resource.members.map((member) => member.agentId);
      await preemptMembers(this.deps, this.leases, [id], new Set(members));
      const next = { ...resource, ...patch, revision: resource.revision + 1, managed: patch.managed ?? resource.managed };
      if (patch.runtime !== undefined || patch.profile !== undefined) {
        await this.assertReady(next.runtime, next.profile);
        await this.deps.computers.updateComputer({
          id: next.id, name: next.name, runtime: next.runtime, profile: next.profile, revision: next.revision, memberAgentIds: members,
        });
      }
      const saved = this.deps.store.computers.update(id, patch, new Date().toISOString());
      if (!saved) throw new NotFoundError("computer not found");
      revision = saved.revision;
      invalidateResourceMembers(this.deps, resource);
      this.deps.changed();
      return this.get(id);
    } finally {
      resumeMembers(this.deps, members);
      this.leases.finishMutation(id, revision);
    }
  }

  /** Rebinds a stopped computer to the engine in use; it starts there with an empty home, the old one stays put. */
  async moveEngine(id: string): Promise<ComputerResource> {
    this.get(id);
    await this.deps.computers.moveEngine(id);
    this.deps.changed();
    return this.get(id);
  }

  private rename(id: string, name: string): ComputerResource {
    if (!this.deps.store.computers.rename(id, name, new Date().toISOString())) throw new NotFoundError("computer not found");
    this.deps.changed();
    return this.get(id);
  }

  runtimeInfo() {
    return this.deps.computers.runtimeInfo();
  }

  private async assertReady(runtime: ComputerRuntime, profile: ComputerProfile): Promise<void> {
    const capability = await this.deps.runtimeReady(runtime);
    if (!capability.ready) throw new ValidationError(capability.detail);
    if (!capability.profiles.includes(profile)) throw new ValidationError(`the ${profile} profile isn't available for this runtime`);
  }

  attach(agentId: string, computerId: string): Promise<void> {
    return attachAgent(this.membership(), agentId, computerId);
  }

  async removeAgent(agentId: string, removeData: () => void): Promise<void> {
    const agent = this.deps.store.getAgent(agentId);
    if (!agent) throw new NotFoundError("agent not found");
    const assigned = this.deps.store.computers.forAgent(agentId);
    const orphanPrivate = assigned ? null : this.deps.store.computers.resource(agentId);
    const resource = assigned ?? (orphanPrivate?.managed ? null : orphanPrivate);
    const members = resource?.members.map((member) => member.agentId) ?? [];
    if (!members.includes(agentId)) members.push(agentId);
    if (resource && !this.leases.reserveMutation(resource.id)) {
      await this.leases.waitForMutation(resource.id);
      return this.removeAgent(agentId, removeData);
    }
    this.leases.beginAgentRemoval(agentId);
    try {
      if (resource) this.leases.invalidateComputer(resource.id);
      for (const memberId of members) {
        if (memberId === agentId) this.deps.runner.stop(memberId);
        else this.deps.runner.interrupt(memberId, false);
        if (memberId !== agentId) this.leases.invalidateAgent(memberId);
        this.deps.approvals.denyAllFor(memberId);
        this.deps.connectorGate.denyFor(memberId);
        this.deps.computers.forgetGrants(memberId);
      }
      await this.deps.runner.waitForAgentIdle(agentId);
      if (resource) await this.leases.waitForRelease(resource.id);
      if (assigned) this.deps.store.computers.detach(agentId, new Date().toISOString());
      removeData();
      if (resource && this.deps.store.computers.resource(resource.id)?.members.length === 0) {
        await this.deps.computers.stop(resource.id);
        if (!resource.managed) {
          await this.deps.computers.removeComputer(resource.id);
          this.deps.store.computers.deletePrivateIfUnused(resource.id);
        }
      }
      if (assigned && assigned.id !== agentId) await this.removeUnusedPrivate(agentId);
      for (const memberId of members) if (memberId !== agentId && this.deps.store.getAgent(memberId)) this.deps.runner.resume(memberId);
      this.deps.changed();
    } finally {
      this.leases.finishAgentRemoval(agentId);
      if (resource) this.leases.finishMutation(resource.id, this.deps.store.computers.get(resource.id)?.revision ?? null);
    }
  }

  detach(agentId: string): Promise<void> {
    return detachAgent(this.membership(), agentId);
  }

  async delete(id: string): Promise<{ ok: true }> {
    const computer = this.get(id);
    if (!computer.managed) throw new ValidationError("private computers are removed with their agent");
    if (computer.members.length > 0) throw new ValidationError("detach every agent before deleting this computer");
    if (!this.leases.beginMutation(id)) throw new ValidationError("wait for computer runs to finish before deleting it");
    try {
      this.leases.invalidateComputer(id);
      await this.deps.computers.removeComputer(id);
      if (!this.deps.store.computers.deleteManagedIfUnused(id)) throw new ValidationError("computer is still assigned to an agent");
      this.deps.changed();
      return { ok: true };
    } finally {
      this.leases.finishMutation(id, this.deps.store.computers.get(id)?.revision ?? null);
    }
  }

  status(agentId: string): ComputerStatus {
    return computerStatus(this.deps.store, this.deps.computers, agentId);
  }

  start(agentId: string): ComputerStatus {
    return startComputer(this.deps.store, this.deps.computers, agentId);
  }

  async stop(agentId: string): Promise<ComputerStatus> {
    return stopComputer(this.deps.store, this.deps.computers, agentId);
  }

  screen(agentId: string) {
    return computerScreen(this.deps.store, this.deps.computers, agentId);
  }

  virtualAgent(agentId: string): void {
    const agent = this.deps.store.getAgent(agentId);
    if (!agent) throw new NotFoundError("agent not found");
    if (agent.computerId === null) throw new NotVirtualError("this agent works on your Mac, not on a virtual computer");
  }

  askToExport(agentId: string, snapshot: ExportSnapshot): string {
    return this.deps.askToExport(agentId, snapshot);
  }

  async prepare(agentId: string): Promise<ComputerRunBinding> {
    return prepareComputerRun(this.deps.store, this.deps.computers, this.leases, agentId);
  }

  release(binding: ComputerRunBinding): void {
    releaseComputerRun(this.leases, binding);
  }

  cancelAgent(agentId: string): void {
    this.leases.invalidateAgent(agentId);
  }

  beforeAgentComputerChange(agentId: string, computerId: string | null): RunEntry | null {
    if (computerId === null) {
      if (this.deps.store.computers.get(agentId)?.managed) throw new ValidationError("this agent's old computer is now shared; attach it from Computers instead");
      return this.deps.runner.interrupt(agentId);
    }
    const resource = this.get(computerId);
    if (!this.leases.reserveMutation(computerId)) throw new ValidationError("this computer is already being changed");
    this.leases.invalidateComputer(computerId);
    let interrupted: RunEntry | null = null;
    for (const member of new Set([...resource.members.map((item) => item.agentId), agentId])) {
      const entry = this.deps.runner.interrupt(member);
      if (member === agentId) interrupted = entry;
      this.leases.invalidateAgent(member);
      this.deps.approvals.denyAllFor(member);
      this.deps.connectorGate.denyFor(member);
      this.deps.computers.forgetGrants(member);
    }
    return interrupted;
  }

  // The reservation beforeAgentComputerChange took is handed back even when the commit throws.
  commitAgentChange(reservedComputerId: string | null, commit: () => void): void {
    try {
      commit();
    } finally {
      if (reservedComputerId !== null) this.afterAgentComputerChange(reservedComputerId);
    }
  }

  afterAgentComputerChange(computerId: string): void {
    void this.leases.waitForRelease(computerId).then(async () => {
      try {
        const resource = this.deps.store.computers.resource(computerId);
        if (!resource) return;
        if (resource.members.length === 0) await this.deps.computers.stop(computerId);
        else for (const member of resource.members) this.deps.runner.resume(member.agentId);
      } finally {
        this.leases.finishMutation(computerId, this.deps.store.computers.get(computerId)?.revision ?? null);
      }
    });
  }

  cancelAll(): void {
    this.leases.invalidateAll();
  }

  isCurrent(context: RunContext): boolean {
    return computerRunIsCurrent(this.deps.store, this.leases, context);
  }

  private membership(): MembershipHost {
    return { deps: this.deps, leases: this.leases, get: (id) => this.get(id) };
  }

  private async removeUnusedPrivate(agentId: string): Promise<void> {
    const own = this.deps.store.computers.resource(agentId);
    if (!own || own.managed || own.members.length > 0) return;
    this.leases.invalidateComputer(own.id);
    await this.deps.computers.removeComputer(own.id);
    this.deps.store.computers.deletePrivateIfUnused(own.id);
  }

  private exportLeaseIsCurrent(context: { agentId: string; computerId: string; computerRevision: number; computerLeaseId: string }): boolean {
    return exportLeaseIsCurrent(this.deps.store, this.leases, context);
  }

}
