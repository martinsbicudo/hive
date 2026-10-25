import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandOptions, CommandOutput, CommandRunner } from "../src/commandRunner.ts";
import type { BuildProgress } from "../src/computerImages.ts";
import type { DockerRunner } from "../src/docker.ts";
import type { Engine, EngineVerdict } from "../src/engineAttest.ts";
import type { SetupFetch, SetupTimer } from "../src/engineDownload.ts";
import type { SetupEffects } from "../src/engineSetupFlow.ts";
import { PROVIDERS, type ProviderId } from "../src/engineSocket.ts";
import { fakeDocker, tempDir } from "./fixtures.ts";

export const ORB_URL = "https://orbstack.dev/download/stable/latest/arm64";
export const ORB_CDN = "https://cdn-updates.orbstack.dev/arm64/OrbStack_v2.2.5_21124_arm64.dmg";
export const DMG_BYTES = Buffer.from("fake-dmg-bytes-".repeat(64));

export function engineOf(provider: ProviderId): Engine {
  return { provider, name: PROVIDERS[provider].name, endpoint: `unix:///home/${PROVIDERS[provider].socket}`, version: "9.9.9" };
}

export interface Timers {
  timer: SetupTimer;
  live: (ms: number) => boolean;
  fire: (ms: number) => void;
}

export function fakeTimers(): Timers {
  const entries: { ms: number; fire: () => void; live: boolean }[] = [];
  return {
    timer: {
      after(ms, fire) {
        const entry = { ms, fire, live: true };
        entries.push(entry);
        return () => {
          entry.live = false;
        };
      },
    },
    live: (ms) => entries.some((entry) => entry.live && entry.ms === ms),
    fire: (ms) => {
      for (const entry of entries.filter((item) => item.live && item.ms === ms)) {
        entry.live = false;
        entry.fire();
      }
    },
  };
}

export async function until(condition: () => boolean, label = "condition"): Promise<void> {
  for (let turn = 0; turn < 20_000; turn += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export interface Call {
  file: string;
  args: readonly string[];
  options: CommandOptions;
}

interface Blocked {
  call: Call;
  release: () => void;
}

/** A Mac, a vendor and two engines in temp folders; every field can be changed to model one failure. */
export class World {
  readonly root = tempDir("hive-setup-");
  readonly cacheRoot = join(this.root, "cache", "setup");
  readonly applicationsDir = join(this.root, "Applications");
  macos = "15.1";
  arm64 = true;
  gatekeeper = "assessments enabled";
  free = 100 * 1024 ** 3;
  dmgTeam = PROVIDERS.orbstack.team;
  dmgNotarized = true;
  appTeam = PROVIDERS.orbstack.team;
  appId = PROVIDERS.orbstack.appId;
  appNotarized = true;
  signedId: string | null = null;
  version = "2.2.5";
  appName = "OrbStack.app";
  layout: (mount: string) => void = (mount) => this.standardLayout(mount);
  attachMounts: ((mount: string) => string[]) | null = null;
  info: unknown = { images: [] };
  active: EngineVerdict = { status: "missing", provider: "Docker-compatible engine", detail: "none", version: null };
  present: Engine[] = [];
  readyOnOpen: ProviderId | null = "orbstack";
  onDitto: (() => void) | null = null;
  block: (call: Call) => boolean = () => false;
  readonly calls: Call[] = [];
  readonly blocked: Blocked[] = [];
  readonly mounted = new Set<string>();
  readonly detached: string[] = [];
  readonly opened: string[] = [];
  readonly logs: string[] = [];
  readonly fetched: { url: string; redirect: string }[] = [];
  readonly built: BuildProgress[] = [];
  imagesGate: Promise<void> | null = null;
  imageSignal: AbortSignal | null = null;
  responses: Record<string, () => Response> = {
    [ORB_URL]: () => new Response(null, { status: 307, headers: { location: ORB_CDN } }),
    [ORB_CDN]: () => new Response(DMG_BYTES, { status: 200, headers: { "content-length": String(DMG_BYTES.length) } }),
  };

  constructor() {
    mkdirSync(this.applicationsDir, { recursive: true });
  }

  standardLayout(mount: string): void {
    const contents = join(mount, this.appName, "Contents");
    mkdirSync(contents, { recursive: true });
    writeFileSync(join(contents, "Info.plist"), JSON.stringify({ CFBundleIdentifier: this.appId, CFBundleShortVersionString: this.version }));
    symlinkSync("/Applications", join(mount, "Applications"));
    writeFileSync(join(mount, ".DS_Store"), "finder");
    mkdirSync(join(mount, ".background"));
  }

  installApp(): string {
    const app = join(this.applicationsDir, this.appName);
    this.standardLayout(join(this.root, "preinstalled"));
    cpSync(join(this.root, "preinstalled", this.appName), app, { recursive: true });
    return app;
  }

  leftovers(): string[] {
    const temps = existsSync(this.cacheRoot) ? readdirSync(this.cacheRoot).map((name) => `cache:${name}`) : [];
    const staging = readdirSync(this.applicationsDir).filter((name) => name.startsWith(".hive-setup-")).map((name) => `apps:${name}`);
    return [...temps, ...staging, ...[...this.mounted].map((mount) => `mounted:${mount}`)];
  }

  appsContent(): string[] {
    return readdirSync(this.applicationsDir);
  }

  ran(file: string, predicate: (args: readonly string[]) => boolean = () => true): Call[] {
    return this.calls.filter((call) => call.file === file && predicate(call.args));
  }

  releaseAll(): void {
    for (const entry of this.blocked.splice(0)) entry.release();
  }

  readonly run: CommandRunner = (file, args, options = {}) => {
    const call = { file, args, options };
    this.calls.push(call);
    const reply = this.reply(call);
    if (!this.block(call)) return Promise.resolve(reply);
    return new Promise((resolve) => {
      const killed = () => resolve(output({ code: -1, stderr: "killed" }));
      options.signal?.addEventListener("abort", killed, { once: true });
      this.blocked.push({ call, release: () => resolve(reply) });
    });
  };

  private reply(call: Call): CommandOutput {
    const { file, args } = call;
    const last = args[args.length - 1] ?? "";
    if (file === "/usr/bin/sw_vers") return output({ stdout: `${this.macos}\n` });
    if (file === "/usr/sbin/sysctl") return this.arm64 ? output({ stdout: "1\n" }) : output({ code: 1, stderr: "unknown oid" });
    if (file === "/usr/sbin/spctl") return this.spctl(args, last);
    if (file === "/usr/bin/codesign") return this.codesign(args, last);
    if (file === "/usr/bin/hdiutil") return this.hdiutil(args, last);
    if (file === "/usr/bin/plutil") return this.plutil(args, call.options.input, last);
    if (file === "/usr/bin/ditto") {
      cpSync(args.at(-2) ?? "", last, { recursive: true, verbatimSymlinks: true });
      this.onDitto?.();
      return output({});
    }
    if (file === "/usr/bin/open") {
      this.opened.push(last);
      if (this.readyOnOpen) {
        this.active = { status: "ready", engine: engineOf(this.readyOnOpen) };
        this.present = [engineOf(this.readyOnOpen)];
      }
      return output({});
    }
    return output({});
  }

  private spctl(args: readonly string[], path: string): CommandOutput {
    if (args[0] === "--status") return output({ stdout: `${this.gatekeeper}\n` });
    const dmg = path.endsWith(".dmg");
    const notarized = dmg ? this.dmgNotarized : this.appNotarized;
    const team = dmg ? this.dmgTeam : this.appTeam;
    return output({ stderr: `${path}: accepted\nsource=${notarized ? "Notarized Developer ID" : "Developer ID"}\norigin=Developer ID Application: Vendor, LLC (${team})\n` });
  }

  private codesign(args: readonly string[], path: string): CommandOutput {
    const requirement = args.find((arg) => arg.startsWith("-R")) ?? "";
    if (!existsSync(path)) return output({ code: 1, stderr: "no such file" });
    if (path.endsWith(".dmg")) return output({ code: requirement.includes(`"${this.dmgTeam}"`) ? 0 : 3 });
    const satisfied = requirement.includes(`"${this.appTeam}"`) && requirement.includes(`identifier "${this.signedId ?? this.appId}"`);
    return output({ code: satisfied ? 0 : 3, stderr: satisfied ? "" : "test-requirement: code failed to satisfy specified code requirement(s)" });
  }

  private hdiutil(args: readonly string[], last: string): CommandOutput {
    if (args[0] === "attach") {
      const mount = args[args.indexOf("-mountpoint") + 1] ?? "";
      this.layout(mount);
      this.mounted.add(mount);
      return output({ stdout: `ATTACH ${mount}` });
    }
    if (args[0] === "detach") {
      const target = args[1] ?? "";
      this.detached.push(target);
      this.mounted.delete(target);
      return output({});
    }
    if (args[0] === "info") return output({ stdout: "INFO" });
    return output({ code: 1, stderr: `unexpected hdiutil ${last}` });
  }

  private plutil(args: readonly string[], input: string | undefined, path: string): CommandOutput {
    if (args[0] === "-convert") {
      if (input === "INFO") return output({ stdout: JSON.stringify(this.info) });
      const mount = (input ?? "").replace(/^ATTACH /, "");
      const mounts = this.attachMounts ? this.attachMounts(mount) : [mount];
      return output({ stdout: JSON.stringify({ "system-entities": [{ "dev-entry": "/dev/disk9" }, ...mounts.map((point) => ({ "dev-entry": "/dev/disk9s1", "mount-point": point }))] }) });
    }
    try {
      const values: unknown = JSON.parse(readFileSync(path, "utf8"));
      const value = typeof values === "object" && values !== null ? Object.entries(values).find(([key]) => key === args[1])?.[1] : undefined;
      return typeof value === "string" ? output({ stdout: `${value}\n` }) : output({ code: 1 });
    } catch {
      return output({ code: 1 });
    }
  }

  readonly fetch: SetupFetch = async (url, init) => {
    this.fetched.push({ url, redirect: init.redirect });
    const respond = this.responses[url];
    if (!respond) return new Response("missing", { status: 404 });
    return respond();
  };

  effects(timers: Timers, overrides: Partial<SetupEffects> = {}): SetupEffects {
    const docker = fakeDocker();
    return {
      fetch: this.fetch,
      run: this.run,
      cacheRoot: this.cacheRoot,
      applicationsDir: this.applicationsDir,
      tag: "0b6f3c1e",
      freeBytes: () => this.free,
      timer: timers.timer,
      now: () => 1_800_000_000_000,
      engines: {
        active: async () => this.active,
        present: async () => this.present,
        refresh: () => undefined,
        runner: (): DockerRunner => docker.runner,
      },
      anyActive: () => false,
      paused: () => false,
      prepareImages: async (_runner, onProgress, signal) => {
        this.imageSignal = signal;
        const progress = { image: "hive/netns:test", step: 2, steps: 4 };
        this.built.push(progress);
        onProgress(progress);
        const gate = this.imagesGate;
        if (gate) await new Promise<void>((resolve) => {
          void gate.then(resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (signal.aborted) throw new Error("build killed");
      },
      log: (line) => this.logs.push(line),
      ...overrides,
    };
  }
}

function output(partial: Partial<CommandOutput>): CommandOutput {
  return { code: 0, stdout: "", stderr: "", timedOut: false, overflowed: false, ...partial };
}

/** A body that never sends data, so only a timer or a cancel can end the download. */
export function silentBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
}
