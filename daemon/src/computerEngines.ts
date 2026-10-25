import { homedir } from "node:os";
import { join } from "node:path";
import { execFileRunner } from "./commandRunner.ts";
import { namesFor } from "./computerArgs.ts";
import { ownerOf } from "./computerOwnership.ts";
import { ComputerToolError } from "./computerServiceHelpers.ts";
import { dockerRunner, DockerUnavailableError, findDocker, type DockerRunner } from "./docker.ts";
import { attestActive, attestEndpoint, type Engine, type EngineVerdict } from "./engineAttest.ts";
import { PROVIDERS, type ProviderId } from "./engineSocket.ts";

export interface EngineHost {
  active(): Promise<EngineVerdict>;
  attest(provider: ProviderId): Promise<EngineVerdict>;
  runner(engine: Engine): DockerRunner;
}

export interface BindingDeps {
  host: EngineHost;
  instanceId: string;
  bind: (computerId: string, provider: ProviderId) => void;
  now: () => number;
}

const ACTIVE_CACHE_MS = 5000;

const missingDocker: DockerRunner = async () => {
  throw new DockerUnavailableError("docker not found");
};

/** The real engines; the Docker CLI and the selected context are looked up again on every check. */
export function systemEngineHost(home = homedir()): EngineHost {
  const deps = () => ({ run: execFileRunner, docker: findDocker(), home });
  return {
    active: () => attestActive(deps()),
    attest: (provider) => attestEndpoint(deps(), `unix://${join(home, PROVIDERS[provider].socket)}`),
    runner: (engine) => {
      const binary = findDocker();
      return binary ? dockerRunner(binary, engine.endpoint) : missingDocker;
    },
  };
}

const FIXED: Engine = { provider: "docker-desktop", name: "Docker Desktop", endpoint: "unix:///fixed/docker.sock", version: "test" };

/** One already-verified engine behind a given runner, for callers that bring their own Docker. */
export function fixedEngineHost(runner: DockerRunner, engine: Engine = FIXED): EngineHost {
  const stopped = (provider: ProviderId): EngineVerdict => ({ status: "stopped", provider: PROVIDERS[provider].name, detail: `${PROVIDERS[provider].name} isn't running.`, version: null });
  return {
    active: async () => ({ status: "ready", engine }),
    attest: async (provider) => provider === engine.provider ? { status: "ready", engine } : stopped(provider),
    runner: () => runner,
  };
}

export function mismatchMessage(bound: ProviderId, active: Engine): string {
  const old = PROVIDERS[bound].name;
  return `This computer's files are in ${old}, but the active engine is ${active.name}. Switch back to ${old}, or move this computer to ${active.name}; it then starts with an empty home and its old one stays in ${old}.`;
}

export class EngineBindings {
  private readonly deps: BindingDeps;
  private cached: { at: number; verdict: Promise<EngineVerdict> } | null = null;

  constructor(deps: BindingDeps) {
    this.deps = deps;
  }

  active(): Promise<EngineVerdict> {
    const now = this.deps.now();
    if (!this.cached || now - this.cached.at > ACTIVE_CACHE_MS) this.cached = { at: now, verdict: this.deps.host.active() };
    return this.cached.verdict;
  }

  refresh(): void {
    this.cached = null;
  }

  runner(engine: Engine): DockerRunner {
    return this.deps.host.runner(engine);
  }

  /** The engine a start must use. An unbound computer binds where its home already is, else to the active engine. */
  async forStart(computerId: string, bound: ProviderId | null): Promise<Engine> {
    const active = await this.active();
    if (active.status !== "ready") throw new ComputerToolError(active.detail);
    const provider = bound ?? (await this.holderOf(computerId)) ?? active.engine.provider;
    if (bound === null) this.deps.bind(computerId, provider);
    if (provider !== active.engine.provider) throw new ComputerToolError(mismatchMessage(provider, active.engine));
    return active.engine;
  }

  /** Engines that may hold this computer: its bound one when it answers, or every answering engine when unbound. */
  async enginesFor(bound: ProviderId | null): Promise<Engine[]> {
    const present = await this.present();
    return bound === null ? present : present.filter((engine) => engine.provider === bound);
  }

  async present(): Promise<Engine[]> {
    const verdicts = await Promise.all(Object.values(PROVIDERS).map((provider) => this.deps.host.attest(provider.id)));
    return verdicts.flatMap((verdict) => verdict.status === "ready" ? [verdict.engine] : []);
  }

  private async holderOf(computerId: string): Promise<ProviderId | null> {
    for (const engine of await this.present()) {
      const owner = await ownerOf(this.runner(engine), this.deps.instanceId, "volume", namesFor(computerId).volume);
      if (owner === "ours") return engine.provider;
    }
    return null;
  }
}
