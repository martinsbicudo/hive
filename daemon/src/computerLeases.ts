import { randomUUID } from "node:crypto";

export interface ComputerLease {
  id: string;
  agentId: string;
  computerId: string;
  revision: number;
  valid: boolean;
}

interface Waiting {
  agentId: string;
  computerId: string;
  revision: number;
  resolve: (lease: ComputerLease) => void;
  reject: (error: Error) => void;
}

// The computer changed while this run waited; the run may wait again for the new revision.
export class StaleRevisionError extends Error {
  constructor() {
    super("computer configuration changed");
  }
}

export interface LeaseHooks {
  revoked?(lease: ComputerLease): void;
  drain?(lease: ComputerLease): Promise<void> | null;
}

export class ComputerLeases {
  private readonly hooks: LeaseHooks;
  private readonly draining = new Set<string>();
  private readonly active = new Map<string, ComputerLease>();
  private readonly waiting = new Map<string, Waiting[]>();
  private readonly releaseWaiters = new Map<string, Array<() => void>>();
  private readonly mutating = new Set<string>();
  private readonly mutationWaiters = new Map<string, Array<() => void>>();
  private readonly removing = new Set<string>();

  constructor(hooks: LeaseHooks = {}) {
    this.hooks = hooks;
  }

  acquire(agentId: string, computerId: string, revision: number): Promise<ComputerLease> {
    if (this.removing.has(agentId)) return Promise.reject(new Error("this agent is being deleted"));
    if (!this.active.has(computerId) && !this.mutating.has(computerId)) return Promise.resolve(this.grant(agentId, computerId, revision));
    return new Promise((resolve, reject) => {
      const queue = this.waiting.get(computerId) ?? [];
      this.waiting.set(computerId, [...queue, { agentId, computerId, revision, resolve, reject }]);
    });
  }

  isCurrent(agentId: string, computerId: string, revision: number, leaseId: string): boolean {
    const lease = this.active.get(computerId);
    return lease?.id === leaseId && lease.agentId === agentId && lease.revision === revision && lease.valid;
  }

  isLeased(computerId: string): boolean {
    return this.active.has(computerId) || this.mutating.has(computerId);
  }

  beginMutation(computerId: string): boolean {
    if (this.active.has(computerId) || this.mutating.has(computerId)) return false;
    this.mutating.add(computerId);
    return true;
  }

  reserveMutation(computerId: string): boolean {
    if (this.mutating.has(computerId)) return false;
    this.mutating.add(computerId);
    return true;
  }

  waitForMutation(computerId: string): Promise<void> {
    if (!this.mutating.has(computerId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.mutationWaiters.get(computerId) ?? [];
      this.mutationWaiters.set(computerId, [...waiters, resolve]);
    });
  }

  finishMutation(computerId: string, revision: number | null): void {
    this.mutating.delete(computerId);
    for (const resolve of this.mutationWaiters.get(computerId) ?? []) resolve();
    this.mutationWaiters.delete(computerId);
    const queue = this.waiting.get(computerId) ?? [];
    const current: Waiting[] = [];
    for (const waiting of queue) {
      if (revision === null || waiting.revision !== revision) waiting.reject(new StaleRevisionError());
      else current.push(waiting);
    }
    this.setQueue(computerId, current);
    if (!this.active.has(computerId)) this.grantNext(computerId);
  }

  waitForRelease(computerId: string): Promise<void> {
    if (!this.active.has(computerId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.releaseWaiters.get(computerId) ?? [];
      this.releaseWaiters.set(computerId, [...waiters, resolve]);
    });
  }

  // A removed agent's later runs are refused instead of queueing behind the removal that waits for them.
  beginAgentRemoval(agentId: string): void {
    this.removing.add(agentId);
    this.invalidateAgent(agentId);
  }

  finishAgentRemoval(agentId: string): void {
    this.removing.delete(agentId);
  }

  invalidateAgent(agentId: string): void {
    for (const lease of this.active.values()) if (lease.agentId === agentId) this.revoke(lease);
    for (const [computerId, queue] of this.waiting) {
      const keep = queue.filter((waiting) => {
        if (waiting.agentId !== agentId) return true;
        waiting.reject(new Error("agent computer assignment changed"));
        return false;
      });
      this.setQueue(computerId, keep);
    }
  }

  invalidateComputer(computerId: string): void {
    const lease = this.active.get(computerId);
    if (lease) this.revoke(lease);
    for (const waiting of this.waiting.get(computerId) ?? []) waiting.reject(new Error("computer configuration changed"));
    this.waiting.delete(computerId);
  }

  invalidateAll(): void {
    for (const lease of this.active.values()) this.revoke(lease);
    for (const computerId of this.waiting.keys()) this.invalidateComputer(computerId);
  }

  // The lease keeps its computer until the drain (killing what it left running) settles.
  release(leaseId: string): void {
    const [computerId, active] = [...this.active].find(([, lease]) => lease.id === leaseId) ?? [];
    if (!computerId || !active || this.draining.has(leaseId)) return;
    active.valid = false;
    const drained = this.hooks.drain?.(active) ?? null;
    if (!drained) return this.finishRelease(computerId, leaseId);
    this.draining.add(leaseId);
    void drained.catch(() => undefined).then(() => {
      this.draining.delete(leaseId);
      this.finishRelease(computerId, leaseId);
    });
  }

  private revoke(lease: ComputerLease): void {
    if (!lease.valid) return;
    lease.valid = false;
    this.hooks.revoked?.(lease);
  }

  private finishRelease(computerId: string, leaseId: string): void {
    if (this.active.get(computerId)?.id !== leaseId) return;
    this.active.delete(computerId);
    const queue = this.waiting.get(computerId) ?? [];
    const [next, ...rest] = queue;
    this.setQueue(computerId, rest);
    if (next && !this.mutating.has(computerId)) next.resolve(this.grant(next.agentId, next.computerId, next.revision));
    else if (next) this.setQueue(computerId, queue);
    for (const resolve of this.releaseWaiters.get(computerId) ?? []) resolve();
    this.releaseWaiters.delete(computerId);
  }

  private grant(agentId: string, computerId: string, revision: number): ComputerLease {
    const lease = { id: randomUUID(), agentId, computerId, revision, valid: true };
    this.active.set(computerId, lease);
    return lease;
  }

  private setQueue(computerId: string, queue: Waiting[]): void {
    if (queue.length > 0) this.waiting.set(computerId, queue);
    else this.waiting.delete(computerId);
  }

  private grantNext(computerId: string): void {
    if (this.active.has(computerId) || this.mutating.has(computerId)) return;
    const queue = this.waiting.get(computerId) ?? [];
    const [next, ...rest] = queue;
    if (!next) return;
    this.setQueue(computerId, rest);
    next.resolve(this.grant(next.agentId, next.computerId, next.revision));
  }
}
