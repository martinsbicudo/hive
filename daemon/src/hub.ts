import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { buildAgentPatch, buildNewAgent, ValidationError, type AgentInput } from "./agents.ts";
import { Approvals } from "./approvals.ts";
import { Architect, type ArchitectConfig } from "./architect.ts";
import { execFileRunner, type CommandRunner } from "./commandRunner.ts";
import { ConnectorApprovals } from "./connectorApprovals.ts";
import { internalConnectors, type ConnectorRouteDeps } from "./connectorRoutes.ts";
import { CONNECTOR_TOOLS } from "./connectorList.ts";
import { connectorRegistry, connectorToolName, type ConnectorTool } from "./connectorTools.ts";
import { ComputerService } from "./computerService.ts";
import type { ExportSnapshot } from "./exportStaging.ts";
import { ComputerManagement, computerServiceOptions, runtimeReadiness, type RuntimeReadiness } from "./computerManagement.ts";
export { NotVirtualError } from "./computerManagement.ts";
import type { Screen } from "./computers.ts";
import type { Store } from "./db.ts";
import { TASK_TOOLS } from "./hiveTools.ts";
import { NotFoundError } from "./httpError.ts";
import { ApprovalDesk } from "./hubApprovals.ts";
import { Control } from "./control.ts";
import { EngineSetup, type SetupEffects } from "./engineSetup.ts";
import { hubSetupEffects } from "./engineSetupHub.ts";
import { buildOptions, buildState } from "./hubState.ts";
import { LoopGuard, type LoopLimits } from "./loopGuard.ts";
import { Notifier } from "./notify.ts";
import { agentsDir, removeMcpConfig } from "./paths.ts";
import { findBinary } from "./process.ts";
import { RunGate, PAUSED_MESSAGE } from "./runGate.ts";
import { RunJobs } from "./runJobs.ts";
import { Runner, type McpLaunch } from "./runner.ts";
import { RunTokens, type RunContext } from "./runTokens.ts";
import { Scheduler } from "./scheduler.ts";
import { parseOr400 } from "./taskCore.ts";
import { ScheduleService } from "./scheduleService.ts";
import { TaskService } from "./taskService.ts";
import type { Agent, Approval, ApprovalStatus, ComputerRuntime, ComputerStatus, HubEvent, HubOptions, HubState } from "./types.ts";
import { removeVirtualCwd } from "./virtualClaude.ts";

export { NotFoundError } from "./httpError.ts";

const BROADCAST_DELAY_MS = 50;
const RULE_REMOVAL = z.object({ rule: z.string().min(1).max(200) }).strict();

export interface HubConfig {
  limits?: LoopLimits;
  now?: () => number;
  approvalTtlMs?: number;
  findEngine?: (name: string) => string | null;
  architect?: ArchitectConfig;
  commands?: CommandRunner;
  connectorTools?: readonly ConnectorTool[];
  runtimeReady?: (runtime: ComputerRuntime) => Promise<RuntimeReadiness>;
  setupEffects?: Partial<SetupEffects>;
}

function taskOf(approval: Approval): string | null {
  return TASK_TOOLS.has(approval.toolName) && typeof approval.input.taskId === "string" ? approval.input.taskId : null;
}

export class Hub {
  readonly approvals: Approvals;
  readonly runTokens = new RunTokens();
  readonly computers: ComputerService;
  readonly tasks: TaskService;
  readonly control: Control;
  readonly schedules: ScheduleService;
  readonly architect: Architect;
  readonly connectorGate: ConnectorApprovals;
  readonly engineSetup: EngineSetup;
  private readonly desk: ApprovalDesk;
  private readonly connectorRoute: ConnectorRouteDeps;
  readonly computerManagement: ComputerManagement;
  private readonly scheduler: Scheduler;
  private readonly clock: () => Date;
  private readonly runner: Runner;
  private readonly findEngine: (name: string) => string | null;
  private readonly listeners = new Set<(event: HubEvent) => void>();
  private broadcastTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private readonly store: Store;

  constructor(store: Store, mcp: McpLaunch, computers: ComputerService = new ComputerService(computerServiceOptions(store)), config: HubConfig = {}) {
    this.store = store;
    this.computers = computers;
    this.clock = () => new Date(config.now?.() ?? Date.now());
    this.findEngine = config.findEngine ?? findBinary;
    const notifier = new Notifier((event) => this.emit(event), this.clock);
    const gate = new RunGate(store, this.clock);
    computers.onChange(() => this.scheduleState());
    const stale = store.pendingApprovals();
    store.failInterruptedRuns(new Date().toISOString());
    this.approvals = new Approvals(store, () => this.scheduleState(), undefined, config.approvalTtlMs);
    this.approvals.onCreated((approval) => notifier.approval(store.getAgent(approval.agentId)?.name ?? "An agent", approval.agentId, taskOf(approval)));
    const jobs = new RunJobs(store, {
      message: (agentId) => this.emit({ type: "message", agentId }),
      task: (taskId) => this.emit({ type: "task", taskId }),
    });
    this.runner = new Runner(store, mcp, this.runTokens, {
      changed: () => this.scheduleState(),
      delta: (agentId, text) => this.emit({ type: "delta", agentId, text }),
      prepareComputer: (agentId) => this.computerManagement.prepare(agentId),
      releaseComputer: (binding) => this.computerManagement.release(binding),
      blockedReason: (agentId) => gate.blockedReason(agentId),
      refused: (agentId, reason) => {
        if (reason !== PAUSED_MESSAGE) notifier.budget(agentId, reason);
      },
      failed: (agentId, taskId) => notifier.failed(store.getAgent(agentId)?.name ?? "An agent", agentId, taskId),
    }, jobs, this.findEngine);
    this.scheduler = new Scheduler({
      schedules: store.schedules, clock: this.clock, paused: () => store.settings.paused(), changed: () => this.scheduleState(),
      wake: (schedule) => this.runner.send(schedule.agentId, `Scheduled wake: ${schedule.prompt}`),
    });
    this.architect = new Architect({ ...config.architect, store, gate, findEngine: this.findEngine, changed: () => this.scheduleState() });
    this.engineSetup = new EngineSetup(hubSetupEffects(store, computers, config.setupEffects));
    this.control = new Control({
      store, runner: this.runner, architect: this.architect, approvals: this.approvals, computers, scheduler: this.scheduler, notifier, clock: this.clock,
      changed: () => this.scheduleState(), leases: { cancelAll: () => this.computerManagement.cancelAll() }, setup: this.engineSetup,
    });
    this.schedules = new ScheduleService(store, this.clock, () => this.scheduleState());
    this.tasks = new TaskService({
      store, jobs, approvals: this.approvals, guard: new LoopGuard(config.limits, config.now),
      enqueue: (agentId, entry) => this.runner.enqueue(agentId, entry),
      dropQueued: (agentId, drop) => this.runner.dropQueued(agentId, drop),
      emit: (taskId) => this.emit({ type: "task", taskId }),
    });
    this.tasks.expiredAtStartup(stale);
    const commands = config.commands ?? execFileRunner;
    const tools = connectorRegistry(config.connectorTools ?? CONNECTOR_TOOLS);
    this.connectorGate = new ConnectorApprovals({ approvals: this.approvals, store, commands });
    const routeGated = new Set([...tools.keys()].map(connectorToolName));
    this.desk = new ApprovalDesk({ store, approvals: this.approvals, computers, routeGated, changed: () => this.scheduleState() });
    this.connectorRoute = { store, tools, gate: this.connectorGate, commands, waitForApproval: (agentId, id, ms) => this.desk.wait(agentId, id, ms) };
    this.computerManagement = new ComputerManagement({
      store, computers, runner: this.runner, approvals: this.approvals, connectorGate: this.connectorGate, tasks: this.tasks,
      askToExport: (agentId, snapshot) => this.desk.askToExport(agentId, snapshot),
      runtimeReady: config.runtimeReady ?? ((runtime) => runtimeReadiness(computers, runtime)), changed: () => this.scheduleState(),
    });
  }

  startScheduler(): void { this.scheduler.start(); }

  checkSchedules(): void { this.scheduler.check(); }

  subscribe(listener: (event: HubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  options(): HubOptions {
    return buildOptions(this.findEngine);
  }

  state(): HubState {
    return buildState({ store: this.store, runner: this.runner, computers: this.computers }, this.clock());
  }

  agent(id: string): Agent {
    const agent = this.state().agents.find((candidate) => candidate.id === id);
    if (!agent) throw new NotFoundError("agent not found");
    return agent;
  }

  createAgent(input: AgentInput): Agent {
    const agent = buildNewAgent(input, this.store.listAgents().map((existing) => existing.name));
    this.store.insertAgent(agent, new Date().toISOString());
    this.scheduleState();
    return this.agent(agent.id);
  }

  updateAgent(id: string, input: AgentInput): Agent {
    const current = this.store.getAgent(id);
    if (!current) throw new NotFoundError("agent not found");
    const patch = buildAgentPatch(input, current);
    const switching = patch.computer !== undefined && patch.computer !== current.computer;
    const replaced = patch.engine !== undefined && patch.engine !== current.engine;
    const removed = patch.connectors !== undefined && current.connectors.some((connector) => !patch.connectors?.includes(connector));
    const interrupted = switching ? this.computerManagement.beforeAgentComputerChange(id, current.computerId) : null;
    if (switching || replaced || removed) this.connectorGate.denyFor(id);
    this.computerManagement.commitAgentChange(switching ? current.computerId : null, () => this.store.updateAgent(id, patch, new Date().toISOString()));
    if (switching) {
      this.approvals.denyAllFor(id);
      this.computers.forgetGrants(id);
      this.tasks.modeChanged(id, patch.name ?? current.name, interrupted);
      this.runner.resume(id);
    }
    this.scheduleState();
    return this.agent(id);
  }

  removeRule(id: string, body: unknown): { ok: true; allowedTools: string[] } {
    const { rule } = parseOr400(RULE_REMOVAL, body);
    const current = this.store.getAgent(id);
    if (!current) throw new NotFoundError("agent not found");
    const allowedTools = current.allowedTools.filter((saved) => saved !== rule);
    if (allowedTools.length !== current.allowedTools.length) this.store.updateAgent(id, { allowedTools }, new Date().toISOString());
    this.scheduleState();
    return { ok: true, allowedTools };
  }

  shuffleAvatar(id: string): Agent {
    const current = this.store.getAgent(id);
    if (!current) throw new NotFoundError("agent not found");
    this.store.updateAgent(id, { avatarSeed: `${current.name}-${crypto.randomUUID().slice(0, 8)}` }, new Date().toISOString());
    this.scheduleState();
    return this.agent(id);
  }

  async deleteAgent(id: string): Promise<void> {
    const agent = this.store.getAgent(id);
    if (!agent) throw new NotFoundError("agent not found");
    await this.computerManagement.removeAgent(id, () => {
      this.approvals.denyInvolving(id);
      this.tasks.agentRemoved(id, agent.name);
      this.store.deleteAgent(id);
      rmSync(join(agentsDir, id), { recursive: true, force: true });
      removeMcpConfig(id);
      if (agent.computer === "virtual") removeVirtualCwd(id);
    });
    this.scheduleState();
  }

  messages(id: string, limit: number) {
    if (!this.store.getAgent(id)) throw new NotFoundError("agent not found");
    return this.store.listMessages(id, limit);
  }

  send(id: string, text: unknown): void {
    if (!this.store.getAgent(id)) throw new NotFoundError("agent not found");
    if (typeof text !== "string" || !text.trim()) throw new ValidationError("text is required");
    this.runner.send(id, text.trim());
  }

  stop(id: string): void {
    this.runner.stop(id);
    this.approvals.denyAllFor(id);
  }

  waitForApproval(agentId: string, id: string, timeoutMs: number): Promise<ApprovalStatus> {
    return this.desk.wait(agentId, id, timeoutMs);
  }

  requestApproval(agentId: string, toolName: string, input: Record<string, unknown>, context: RunContext | null = null): { id: string; autoAllowed: boolean } {
    return this.desk.request(agentId, toolName, input, context);
  }

  connectorCall(context: RunContext, tool: string | undefined, body: Record<string, unknown>): Promise<unknown> {
    return internalConnectors(this.connectorRoute, context, tool, body);
  }

  computerStatus(id: string): ComputerStatus {
    return this.computerManagement.status(id);
  }

  startComputer(id: string): ComputerStatus {
    return this.computerManagement.start(id);
  }

  async stopComputer(id: string): Promise<ComputerStatus> { return this.computerManagement.stop(id); }

  screen(id: string): Screen | null { return this.computerManagement.screen(id); }

  virtualAgent(id: string): void { this.computerManagement.virtualAgent(id); }

  askToExport(agentId: string, snapshot: ExportSnapshot): string {
    return this.computerManagement.askToExport(agentId, snapshot);
  }

  decideApproval(id: string, allow: unknown, remember: unknown): Approval {
    return this.desk.decide(id, allow, remember);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.scheduler.stop();
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    this.computerManagement.cancelAll();
    const drained = this.runner.stopAll();
    this.architect.stop();
    this.approvals.denyPending();
    this.engineSetup.cancelForPause();
    await Promise.all([drained, this.engineSetup.settled()]);
    await this.computers.shutdown();
  }

  private emit(event: HubEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  private scheduleState(): void {
    if (this.closing || this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.emit({ type: "state", state: this.state() });
    }, BROADCAST_DELAY_MS);
  }
}
