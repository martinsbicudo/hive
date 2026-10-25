export class RunnerIdle {
  private readonly pending = new Map<string, number>();
  private readonly allWaiters = new Set<() => void>();
  private readonly agentWaiters = new Map<string, Array<() => void>>();

  beginPreparation(agentId: string): void {
    this.pending.set(agentId, (this.pending.get(agentId) ?? 0) + 1);
  }

  hasPreparation(agentId: string): boolean {
    return this.pending.has(agentId);
  }

  hasAnyPreparation(): boolean {
    return this.pending.size > 0;
  }

  waitForAgent(agentId: string, idle: () => boolean): Promise<void> {
    if (idle()) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.agentWaiters.get(agentId) ?? [];
      this.agentWaiters.set(agentId, [...waiters, resolve]);
    });
  }

  waitForAll(idle: () => boolean): Promise<void> {
    if (idle()) return Promise.resolve();
    return new Promise((resolve) => this.allWaiters.add(resolve));
  }

  preparationFinished(agentId: string, agentIdle: () => boolean, allIdle: () => boolean): void {
    const count = (this.pending.get(agentId) ?? 1) - 1;
    if (count === 0) this.pending.delete(agentId);
    else this.pending.set(agentId, count);
    this.resolve(agentId, agentIdle, allIdle);
  }

  resolve(agentId: string, agentIdle: () => boolean, allIdle: () => boolean): void {
    if (agentIdle()) {
      for (const resolve of this.agentWaiters.get(agentId) ?? []) resolve();
      this.agentWaiters.delete(agentId);
    }
    if (allIdle()) {
      for (const resolve of this.allWaiters) resolve();
      this.allWaiters.clear();
    }
  }
}
