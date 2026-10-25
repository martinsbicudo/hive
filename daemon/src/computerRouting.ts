import { ComputerToolError } from "./computerServiceHelpers.ts";
import { EngineBindings, fixedEngineHost, systemEngineHost, type EngineHost } from "./computerEngines.ts";
import { DockerUnavailableError, type DockerRunner } from "./docker.ts";
import type { Engine } from "./engineAttest.ts";
import type { ProviderId } from "./engineSocket.ts";

export interface RoutingOptions {
  engines?: EngineHost;
  docker?: () => DockerRunner;
  instanceId: () => string;
  bind: (computerId: string, provider: ProviderId) => void;
  now: () => number;
}

const unrouted: DockerRunner = async () => {
  throw new DockerUnavailableError("this computer hasn't been started on an engine yet");
};

/** Which engine each computer's Docker calls reach; set when it starts, so a later engine switch can't redirect it. */
export class ComputerRouting {
  private readonly routes = new Map<string, DockerRunner>();
  private readonly options: RoutingOptions;
  private bindings: EngineBindings | null = null;

  constructor(options: RoutingOptions) {
    this.options = options;
  }

  engines(): EngineBindings {
    const { engines, docker, instanceId, bind, now } = this.options;
    this.bindings ??= new EngineBindings({ host: engines ?? (docker ? fixedEngineHost(docker()) : systemEngineHost()), instanceId: instanceId(), bind, now });
    return this.bindings;
  }

  runnerOf(computerId: string): DockerRunner {
    return (args, options) => (this.routes.get(computerId) ?? unrouted)(args, options);
  }

  has(computerId: string): boolean {
    return this.routes.has(computerId);
  }

  forget(computerId: string): void {
    this.routes.delete(computerId);
  }

  async routeForStart(computerId: string, bound: ProviderId | null): Promise<void> {
    const engine = await this.engines().forStart(computerId, bound);
    this.routes.set(computerId, this.engines().runner(engine));
  }

  /** Runs `work` once per engine that may hold the computer, routed there, then leaves the computer unrouted. */
  async onEachEngine(computerId: string, bound: ProviderId | null, work: () => Promise<void>): Promise<void> {
    try {
      for (const engine of await this.engines().enginesFor(bound)) {
        this.routes.set(computerId, this.engines().runner(engine));
        await work();
      }
    } finally {
      this.routes.delete(computerId);
    }
  }

  /** The active engine a stopped computer may move to. */
  async moveTarget(bound: ProviderId | null): Promise<Engine> {
    const active = await this.engines().active();
    if (active.status !== "ready") throw new ComputerToolError(active.detail);
    if (bound === active.engine.provider) throw new ComputerToolError(`this computer already uses ${active.engine.name}`);
    return active.engine;
  }

  async presentRunners(): Promise<DockerRunner[]> {
    return (await this.engines().present()).map((engine: Engine) => this.engines().runner(engine));
  }
}
