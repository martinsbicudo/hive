import { Computers, type ComputerOptions, type Screen } from "./computers.ts";
import type { DockerRunner } from "./docker.ts";
import { log } from "./log.ts";
import { loadOrCreateInstanceId } from "./paths.ts";
import type { Approval, ComputerStatus } from "./types.ts";
import type { ComputerProfile, ComputerRuntime } from "./computerTypes.ts";
import { COMPUTER_PROFILE_INFO, discoverComputerRuntimes, runtimeGuidesForHost, runtimeInfoSchema, type RuntimeInfo } from "./runtimeCapabilities.ts";
import { ComputerToolError, defaultBuildContexts, defaultImages, PROFILE_DOCKERFILES, quietly } from "./computerServiceHelpers.ts";
import type { EngineBindings, EngineHost } from "./computerEngines.ts";
import { ComputerRouting } from "./computerRouting.ts";
import type { ProviderId } from "./engineSocket.ts";
import { ComputerGuest } from "./computerGuest.ts";
import type { LeaseRef } from "./computerLeaseExec.ts";
import type { Images } from "./computerArgs.ts";

export { ComputerToolError } from "./computerServiceHelpers.ts";

export interface ComputerServiceOptions {
  instanceId?: string;
  docker?: () => DockerRunner;
  engines?: EngineHost;
  bindEngine?: (computerId: string, provider: ProviderId) => void;
  computerForAgent?: (agentId: string) => ComputerConfig | null;
  computerResources?: () => ComputerConfig[];
  isLeaseCurrent?: (context: ComputerExportContext & { agentId: string }) => boolean;
  now?: () => number;
  idleMs?: number;
  downloadsRoot?: string;
  stageRoot?: string;
  runtimeInfo?: () => Promise<RuntimeInfo>;
  images?: Images;
}

export interface ComputerConfig {
  id: string;
  name: string;
  runtime: ComputerRuntime;
  profile: ComputerProfile;
  engine?: ProviderId | null;
  revision: number;
  memberAgentIds: string[];
  managed?: boolean;
}

export interface ComputerExportContext {
  computerId: string;
  computerRevision: number;
  computerLeaseId: string;
}

const IDLE_MS = 15 * 60_000;
const ACTIVE_STATES = new Set(["building", "starting", "running"]);

export class ComputerService {
  private readonly machineById = new Map<string, Computers>();
  private readonly configById = new Map<string, ComputerConfig>();
  private readonly routing: ComputerRouting;
  readonly guest: ComputerGuest;
  private readonly listeners = new Set<(agentId: string) => void>();
  private readonly options: ComputerServiceOptions;
  private readonly now: () => number;
  private blocked: () => string | null = () => null;

  constructor(options: ComputerServiceOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.routing = new ComputerRouting({
      engines: options.engines, docker: options.docker, instanceId: () => this.instanceId(), now: this.now,
      bind: (computerId, provider) => this.options.bindEngine?.(computerId, provider),
    });
    this.guest = new ComputerGuest(options, {
      computerOf: (agentId) => this.requireComputer(agentId),
      machineOf: (config) => this.machineFor(config),
      existingMachine: (computerId) => this.machineById.get(computerId),
    });
  }

  onChange(listener: (agentId: string) => void): void {
    this.listeners.add(listener);
  }

  setLeaseValidator(validate: NonNullable<ComputerServiceOptions["isLeaseCurrent"]>): void {
    this.guest.setLeaseValidator(validate);
  }

  // Every start and guest command checks this, so a pause holds even for calls already past their lease check.
  setStartGuard(blocked: () => string | null): void {
    this.blocked = blocked;
  }

  setComputerResolvers(resolvers: Pick<ComputerServiceOptions, "computerForAgent" | "computerResources" | "bindEngine">): void {
    this.options.computerForAgent = resolvers.computerForAgent;
    this.options.computerResources = resolvers.computerResources;
    this.options.bindEngine = resolvers.bindEngine;
  }

  async runtimeInfo(): Promise<RuntimeInfo> {
    if (this.options.runtimeInfo) return runtimeInfoSchema.parse(await this.options.runtimeInfo());
    const runtimes = await discoverComputerRuntimes({ active: () => this.routing.engines().active() });
    return runtimeInfoSchema.parse({ runtimes, profiles: COMPUTER_PROFILE_INFO, guides: runtimeGuidesForHost() });
  }

  /** The engine checks; `refresh()` makes the next check see an engine that was just set up or started. */
  engines(): EngineBindings {
    return this.routing.engines();
  }

  anyActive(): boolean {
    return [...this.machineById].some(([computerId, machine]) => ACTIVE_STATES.has(machine.statusOf(computerId).state));
  }

  /** Rebinds a stopped computer to the active engine; its old home stays untouched in the old engine. */
  async moveEngine(computerId: string): Promise<ProviderId> {
    const config = this.options.computerResources?.().find((entry) => entry.id === computerId);
    if (!config) throw new ComputerToolError("computer not found");
    const machine = this.machineById.get(computerId);
    if (machine && ACTIVE_STATES.has(machine.statusOf(computerId).state)) throw new ComputerToolError("stop this computer before moving it to another engine");
    const target = await this.routing.moveTarget(config.engine ?? null);
    this.options.bindEngine?.(computerId, target.provider);
    this.routing.forget(computerId);
    this.machineById.delete(computerId);
    return target.provider;
  }

  statusOf(agentId: string): ComputerStatus {
    const config = this.computerConfig(agentId);
    return config ? this.machineById.get(config.id)?.statusOf(config.id) ?? { state: "stopped" } : { state: "stopped" };
  }

  screen(agentId: string): Screen | null {
    const config = this.computerConfig(agentId);
    if (!config || config.profile === "terminal" || this.statusOf(agentId).state !== "running") return null;
    return this.machineById.get(config.id)?.screen(config.id) ?? null;
  }

  start(agentId: string): void {
    const config = this.computerConfig(agentId);
    if (!config) return;
    this.machineFor(config).ensureRunning(config.id).catch((error: unknown) => log(`computer ${agentId} didn't start: ${String(error)}`));
  }

  ensureRunning(agentId: string): Promise<void> {
    const config = this.requireComputer(agentId);
    return this.machineFor(config).ensureRunning(config.id);
  }

  async stop(agentId: string): Promise<void> {
    const config = this.computerConfig(agentId);
    const machine = config ? this.machineById.get(config.id) : undefined;
    if (config && machine) await this.stopMachine(config.id, machine);
  }

  async remove(agentId: string): Promise<void> {
    const config = this.computerConfig(agentId);
    if (!config || config.memberAgentIds.length > 1) return;
    await this.removeComputer(config.id);
  }

  async removeComputer(computerId: string): Promise<void> {
    const config = this.configById.get(computerId) ?? this.options.computerResources?.().find((entry) => entry.id === computerId) ?? this.defaultComputer(computerId);
    const machine = this.machineById.get(computerId) ?? this.machineFor(config);
    await this.routing.onEachEngine(computerId, config.engine ?? null, () => quietly(machine.remove(computerId)));
    this.machineById.delete(computerId);
    this.configById.delete(computerId);
  }

  async updateComputer(config: ComputerConfig): Promise<void> {
    if (config.runtime !== "docker") throw new ComputerToolError("this computer runtime isn't supported by Hive yet");
    const machine = this.machineById.get(config.id);
    const previous = this.configById.get(config.id);
    if (machine && previous && previous.runtime !== config.runtime) {
      throw new ComputerToolError("changing runtime requires an approved home transfer that isn't available yet");
    }
    if (machine) await machine.reconfigure(config.id, config.profile);
    this.configById.set(config.id, config);
  }

  /** Each answering engine is cleaned through its own socket, so one engine's pass never touches another's resources. */
  async reconcile(knownComputerIds: ReadonlySet<string>): Promise<void> {
    for (const runner of await this.routing.presentRunners()) {
      const machine = new Computers(runner, this.machineOptions(this.defaultComputer("00000000-0000-4000-8000-000000000000")));
      await quietly(machine.reconcile(knownComputerIds));
    }
  }

  async stopIdle(): Promise<void> {
    await Promise.all(this.routedMachines().map(([, machine]) => quietly(machine.stopIdle())));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.machineById].map(([computerId, machine]) => this.stopMachine(computerId, machine)));
  }

  async shutdown(): Promise<void> {
    await this.stopAll();
    this.clearStagedExports();
  }

  clearStagedExports(): void {
    try {
      this.guest.exports.clear();
    } catch (error) {
      log(`staged exports weren't cleared: ${String(error)}`);
    }
  }

  revokeLease(lease: LeaseRef): void {
    this.guest.revokeLease(lease);
  }

  drainLease(lease: LeaseRef): Promise<void> | null {
    return this.guest.drainLease(lease);
  }

  noteExportAllowed(approval: Approval): void {
    this.guest.exports.noteAllowed(approval);
  }

  noteExportClosed(approval: Approval): void {
    this.guest.exports.noteClosed(approval);
  }

  forgetGrants(agentId: string): void {
    this.guest.exports.forgetAgent(agentId);
  }

  private instanceId(): string {
    this.options.instanceId ??= loadOrCreateInstanceId();
    return this.options.instanceId;
  }

  // Every start, including one a guest command triggers, checks the engine first and routes the computer to it.
  private async routeForStart(config: ComputerConfig): Promise<void> {
    const current = this.options.computerResources?.().find((entry) => entry.id === config.id) ?? config;
    await this.routing.routeForStart(config.id, current.engine ?? null);
  }

  // A start still checking its engine has no route yet; it is waited for, so a pause or shutdown can't miss it.
  private async stopMachine(computerId: string, machine: Computers): Promise<void> {
    await machine.settled(computerId);
    if (this.routing.has(computerId)) await quietly(machine.stop(computerId));
  }

  private routedMachines(): [string, Computers][] {
    return [...this.machineById].filter(([computerId]) => this.routing.has(computerId));
  }

  private machineFor(config: ComputerConfig): Computers {
    if (config.runtime !== "docker") throw new ComputerToolError("this computer runtime isn't supported by Hive yet");
    let machine = this.machineById.get(config.id);
    if (machine) return machine;
    machine = new Computers(this.routing.runnerOf(config.id), {
      ...this.machineOptions(config),
      beforeStart: () => this.routeForStart(config),
    });
    this.machineById.set(config.id, machine);
    this.configById.set(config.id, config);
    return machine;
  }

  private machineOptions(config: ComputerConfig): ComputerOptions {
    return {
      instanceId: this.instanceId(),
      images: this.options.images ?? defaultImages(),
      buildContexts: defaultBuildContexts(),
      profileDockerfiles: { ...PROFILE_DOCKERFILES },
      profile: config.profile,
      idleMs: this.options.idleMs ?? IDLE_MS,
      now: this.now,
      blocked: () => this.blocked(),
      onChange: (computerId) => {
        const members = this.options.computerResources?.().find((entry) => entry.id === computerId)?.memberAgentIds ?? config.memberAgentIds;
        for (const agentId of members) for (const listener of this.listeners) listener(agentId);
      },
    };
  }

  private computerForAgent(agentId: string): ComputerConfig | null {
    return this.options.computerForAgent?.(agentId) ?? (this.options.computerForAgent ? null : this.defaultComputer(agentId));
  }

  private computerConfig(reference: string): ComputerConfig | null {
    return this.options.computerResources?.().find((entry) => entry.id === reference) ?? this.computerForAgent(reference);
  }

  private defaultComputer(agentId: string): ComputerConfig {
    return { id: agentId, name: "Virtual computer", runtime: "docker", profile: "desktop", revision: 1, memberAgentIds: [agentId] };
  }

  private requireComputer(agentId: string): ComputerConfig {
    const config = this.computerForAgent(agentId);
    if (!config) throw new ComputerToolError("this agent isn't assigned to a virtual computer");
    return config;
  }
}
