import { randomBytes } from "node:crypto";
import {
  agentRunArgs, commandArgv, execArgs, holderRunArgs, namesFor, networkCreateArgs, SCREEN_PORT, UUID, volumeCreateArgs, type Images,
} from "./computerArgs.ts";
import { DockerUnavailableError, type CommandResult, type DockerRunner, type RunOptions } from "./docker.ts";
import { owned, ownerOf, removeOwnedComputer, removeOwnedContainers } from "./computerOwnership.ts";
import { leaseCommand, leaseKillCommand } from "./computerLeaseExec.ts";
import { reconcileComputers } from "./computerReconcile.ts";
import { ensureImages, ImageBuildError } from "./computerImages.ts";
import { DESKTOP_READY_SCRIPT } from "./computerServiceHelpers.ts";
import { firewallIsInPlace, peersFrom, type FirewallPeers } from "./firewall.ts";
import type { ComputerStatus } from "./types.ts";
import type { ComputerProfile } from "./computerTypes.ts";

export type { ComputerState, ComputerStatus } from "./types.ts";

export interface Screen {
  port: number;
  token: string;
  password: string;
}

export interface ComputerOptions {
  instanceId: string;
  images: Images;
  buildContexts: Images;
  profileDockerfiles?: Partial<Record<ComputerProfile, string>>;
  profile?: ComputerProfile;
  idleMs: number;
  now: () => number;
  onChange: (agentId: string) => void;
  blocked?: () => string | null;
  beforeStart?: (agentId: string) => Promise<void>;
}

export class ComputerError extends Error {}

export const DOCKER_MISSING = "Docker isn't installed or isn't running";
export const LEASE_ENDED = "this run no longer has access to its assigned computer";

export interface LeaseScope {
  leaseId?: string;
  current?: () => boolean;
}

export interface ExecOptions extends Pick<RunOptions, "input" | "maxStdoutBytes" | "timeoutMs">, LeaseScope {
  detach?: boolean;
}

const FIREWALL_READY_ATTEMPTS = 20;
const FIREWALL_POLL_MS = 250;
const SCREEN_SETTLE_MS = 1500;
const OUTPUT_LIMIT = 30 * 1024;
const KILL_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Computers {
  private readonly docker: DockerRunner;
  private readonly options: ComputerOptions;
  private readonly status = new Map<string, ComputerStatus>();
  private readonly screens = new Map<string, Screen>();
  private readonly lastUse = new Map<string, number>();
  private readonly starting = new Map<string, Promise<void>>();

  constructor(docker: DockerRunner, options: ComputerOptions) {
    if (!UUID.test(options.instanceId)) throw new ComputerError(`not a Hive instance id: ${options.instanceId}`);
    this.docker = docker;
    this.options = options;
  }

  statusOf(agentId: string): ComputerStatus {
    return this.status.get(agentId) ?? { state: "stopped" };
  }

  screen(agentId: string): Screen | null {
    return this.screens.get(agentId) ?? null;
  }

  async ensureRunning(agentId: string): Promise<void> {
    this.refuseWhileBlocked();
    this.lastUse.set(agentId, this.options.now());
    if (this.statusOf(agentId).state === "running" && (await this.isRunning(namesFor(agentId).agent))) return;
    // Checked again after the await and before the start is registered, so a pause's stop either waits for it or it never begins.
    this.refuseWhileBlocked();
    const pending = this.starting.get(agentId) ?? this.start(agentId).finally(() => this.starting.delete(agentId));
    this.starting.set(agentId, pending);
    await pending;
  }

  /** Waits for a start in progress, whether it ends running or failed. */
  async settled(agentId: string): Promise<void> {
    await this.starting.get(agentId)?.catch(() => undefined);
  }

  async stop(agentId: string): Promise<void> {
    await this.settled(agentId);
    const names = namesFor(agentId);
    const mine = await owned(this.docker, this.options.instanceId, "container", [names.agent, names.holder]);
    if (mine.includes(names.agent)) await this.docker(["stop", "-t", "3", names.agent]);
    if (mine.includes(names.holder)) await this.docker(["rm", "-f", names.holder]);
    this.screens.delete(agentId);
    this.setStatus(agentId, { state: "stopped" });
  }

  async remove(agentId: string): Promise<void> {
    await removeOwnedComputer(this.docker, this.options.instanceId, namesFor(agentId));
    this.screens.delete(agentId);
    this.status.delete(agentId);
    this.lastUse.delete(agentId);
  }

  async reconcile(knownAgentIds: ReadonlySet<string>): Promise<void> {
    for (const agentId of await reconcileComputers(this.docker, this.options.instanceId, knownAgentIds)) {
      this.screens.delete(agentId);
      this.setStatus(agentId, { state: "stopped" });
    }
  }

  async stopIdle(): Promise<void> {
    const now = this.options.now();
    for (const [agentId, used] of this.lastUse) {
      if (now - used >= this.options.idleMs && this.statusOf(agentId).state === "running") await this.stop(agentId);
    }
  }

  async run(agentId: string, command: string, timeoutS: number, scope: LeaseScope = {}): Promise<{ exitCode: number; output: string }> {
    const result = await this.exec(agentId, commandArgv(command, timeoutS), { ...scope, timeoutMs: (timeoutS + 10) * 1000 });
    const output = (result.stdout.toString("utf8") + (result.stderr ? `\n${result.stderr}` : "")).slice(-OUTPUT_LIMIT);
    return { exitCode: result.code, output };
  }

  async exec(agentId: string, command: readonly string[], options: ExecOptions = {}): Promise<CommandResult> {
    await this.ensureRunning(agentId);
    const { detach, leaseId, current, ...run } = options;
    if (current && !current()) throw new ComputerError(LEASE_ENDED);
    this.refuseWhileBlocked();
    const argv = leaseId === undefined ? command : leaseCommand(leaseId, command);
    return this.docker(execArgs(agentId, "agent", argv, { stdin: run.input !== undefined, detach }), run);
  }

  async killLease(computerId: string, leaseId: string): Promise<boolean> {
    const container = namesFor(computerId).agent;
    if (!(await this.isRunning(container))) return true;
    const result = await this.docker(execArgs(computerId, "agent", leaseKillCommand(leaseId)), { timeoutMs: KILL_TIMEOUT_MS });
    return result.code === 0 || !(await this.isRunning(container));
  }

  private async start(agentId: string): Promise<void> {
    const names = namesFor(agentId);
    try {
      await this.options.beforeStart?.(agentId);
      this.refuseWhileBlocked();
      await this.ensureImages(agentId);
      this.setStatus(agentId, { state: "starting" });
      const { instanceId, images } = this.options;
      await removeOwnedContainers(this.docker, instanceId, [names.agent, names.holder]);
      await this.claim("network", networkCreateArgs(agentId, instanceId), names.network, "network");
      await this.claim("volume", volumeCreateArgs(agentId, instanceId), names.volume, "home folder");
      const profile = this.options.profile ?? "desktop";
      await this.must(holderRunArgs(agentId, images, instanceId, profile), "the network guard didn't start");
      if (!(await this.firewallReady(names.holder))) {
        await this.docker(["rm", "-f", names.holder]);
        throw new ComputerError("the network guard couldn't confirm its firewall, so the computer stays off");
      }
      await this.must(agentRunArgs(agentId, images, instanceId, profile), "the computer didn't start");
      if (profile !== "terminal") this.screens.set(agentId, await this.startScreen(agentId, names.holder));
      this.setStatus(agentId, { state: "running" });
    } catch (error) {
      const detail = error instanceof DockerUnavailableError ? DOCKER_MISSING : error instanceof Error ? error.message : String(error);
      this.setStatus(agentId, { state: "error", detail });
      throw error instanceof DockerUnavailableError ? new ComputerError(DOCKER_MISSING) : error;
    }
  }

  private async claim(kind: "network" | "volume", create: readonly string[], name: string, what: string): Promise<void> {
    const { instanceId } = this.options;
    const foreign = new ComputerError(`a Docker ${kind} named ${name} doesn't belong to this Hive, so Hive left it alone and the computer stays off`);
    if ((await ownerOf(this.docker, instanceId, kind, name)) === "foreign") throw foreign;
    const created = await this.docker(create);
    const owner = await ownerOf(this.docker, instanceId, kind, name);
    if (owner === "ours") return;
    if (owner === "foreign") throw foreign;
    throw new ComputerError(`the computer's ${what} couldn't be prepared: ${created.stderr.trim().split("\n").pop() || "docker failed"}`);
  }

  private async ensureImages(agentId: string): Promise<void> {
    const building = () => this.setStatus(agentId, { state: "building", detail: "Preparing the virtual computer (first time only)…" });
    try {
      await ensureImages(this.docker, this.options, this.options.profile ?? "desktop", { onBuilding: building });
    } catch (error) {
      throw error instanceof ImageBuildError ? new ComputerError(error.message) : error;
    }
  }

  private async firewallReady(holder: string): Promise<boolean> {
    for (let attempt = 0; attempt < FIREWALL_READY_ATTEMPTS; attempt++) {
      const peers = await this.firewallPeers(holder);
      const ruleset = peers ? await this.docker(["exec", holder, "nft", "list", "table", "inet", "hive"]) : null;
      if (peers && ruleset?.code === 0 && firewallIsInPlace(ruleset.stdout.toString("utf8"), peers)) return true;
      if (!(await this.isRunning(holder))) return false;
      await sleep(FIREWALL_POLL_MS);
    }
    return false;
  }

  private async firewallPeers(holder: string): Promise<FirewallPeers | null> {
    const [resolvConf, route] = await Promise.all([
      this.docker(["exec", holder, "cat", "/etc/resolv.conf"]),
      this.docker(["exec", holder, "ip", "-4", "route", "show"]),
    ]);
    if (resolvConf.code !== 0 || route.code !== 0) return null;
    return peersFrom(resolvConf.stdout.toString("utf8"), route.stdout.toString("utf8"));
  }

  private async startScreen(agentId: string, holder: string): Promise<Screen> {
    const token = randomBytes(32).toString("hex");
    const password = randomBytes(4).toString("hex");
    await this.must(execArgs(agentId, "vnc", ["sh", "-c", "umask 077; vncpasswd -f > /run/vnc/passwd"], { stdin: true }), "screen password", undefined, password);
    await this.must(execArgs(agentId, "vnc", ["sh", "-c", "umask 077; cat > /run/vnc/tokens"], { stdin: true }), "screen token", undefined, `${token}: 127.0.0.1:5900\n`);
    await this.must(execArgs(agentId, "vnc", ["hive-screen"], { detach: true }), "the screen didn't start");
    await sleep(SCREEN_SETTLE_MS);
    const session = this.options.profile === "browser" ? "hive-session-browser" : "hive-session";
    await this.must(execArgs(agentId, "agent", [session], { detach: true }), "the desktop didn't start");
    await this.must(execArgs(agentId, "agent", ["sh", "-c", DESKTOP_READY_SCRIPT]), "the desktop didn't start");
    const published = await this.must(["port", holder, String(SCREEN_PORT)], "screen port");
    const match = /^127\.0\.0\.1:(\d+)$/m.exec(published.stdout.toString("utf8").trim());
    if (!match?.[1]) throw new ComputerError("the screen isn't published on 127.0.0.1 only");
    return { port: Number(match[1]), token, password };
  }

  private async isRunning(container: string): Promise<boolean> {
    const result = await this.docker(["inspect", "-f", "{{.State.Running}}", container]);
    return result.code === 0 && result.stdout.toString("utf8").trim() === "true";
  }

  private async must(args: readonly string[], what: string, timeoutMs?: number, input?: string): Promise<CommandResult> {
    const result = await this.docker(args, { timeoutMs, input });
    if (result.code !== 0) throw new ComputerError(`${what}: ${result.stderr.trim().split("\n").pop() ?? "docker failed"}`);
    return result;
  }

  private refuseWhileBlocked(): void {
    const reason = this.options.blocked?.() ?? null;
    if (reason !== null) throw new ComputerError(reason);
  }

  private setStatus(agentId: string, status: ComputerStatus): void {
    this.status.set(agentId, status);
    this.options.onChange(agentId);
  }

  async reconfigure(computerId: string, profile: ComputerProfile): Promise<void> {
    if (profile === (this.options.profile ?? "desktop")) return;
    const previous = this.options.profile ?? "desktop";
    const wasRunning = this.statusOf(computerId).state === "running";
    await this.stop(computerId);
    this.options.profile = profile;
    try {
      if (wasRunning) await this.ensureRunning(computerId);
      else {
        await this.ensureImages(computerId);
        this.setStatus(computerId, { state: "stopped" });
      }
    } catch (error) {
      this.options.profile = previous;
      this.setStatus(computerId, { state: "stopped" });
      if (wasRunning) await this.ensureRunning(computerId).catch(() => undefined);
      throw error;
    }
  }
}
