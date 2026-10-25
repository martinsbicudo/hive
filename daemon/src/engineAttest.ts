import type { CommandRunner } from "./commandRunner.ts";
import { atLeast, outerApp, PROVIDERS, socketFor, type ProviderId, type ProviderSpec } from "./engineSocket.ts";

export interface Engine {
  provider: ProviderId;
  name: string;
  endpoint: string;
  version: string;
}

export type EngineVerdict =
  | { status: "ready"; engine: Engine }
  | { status: "missing" | "stopped" | "unsupported" | "check-failed"; provider: string; detail: string; version: string | null };

export interface AttestDeps {
  run: CommandRunner;
  docker: string | null;
  home?: string;
  uid?: number;
}

const TOOLS = { lsof: "/usr/sbin/lsof", codesign: "/usr/bin/codesign", plutil: "/usr/bin/plutil" };
const QUICK = { timeoutMs: 5000 };
const GENERIC = "Docker-compatible engine";
const CONTEXT = /^[A-Za-z0-9_.-]{1,80}$/;

const refuse = (status: Exclude<EngineVerdict["status"], "ready">, detail: string, provider = GENERIC, version: string | null = null): EngineVerdict =>
  ({ status, provider, detail, version });

export function requirement(identifier: string, team: string): string {
  return `=anchor apple generic and identifier "${identifier}" and certificate leaf[subject.OU] = "${team}"`;
}

/** The kernel's record of the program a process runs; argv[0] (what `ps` shows) is chosen by the caller and can lie. */
async function executableOf(run: CommandRunner, pid: string): Promise<string> {
  const listed = await run(TOOLS.lsof, ["-a", "-p", pid, "-d", "txt", "-F", "n"], QUICK);
  const lines = listed.stdout.split("\n");
  const txt = lines.indexOf("ftxt");
  const name = txt >= 0 ? lines[txt + 1] ?? "" : "";
  return listed.code === 0 && name.startsWith("n") ? name.slice(1) : "";
}

/** Each process serving the socket must be the vendor's signed program; returns the vendor app's version. */
async function attestListener(run: CommandRunner, socket: string, spec: ProviderSpec): Promise<{ version: string } | { detail: string }> {
  const listed = await run(TOOLS.lsof, ["-F", "pn", "--", socket], QUICK);
  const pids = new Set<string>();
  let pid = "";
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line === `n${socket}` && /^\d+$/.test(pid)) pids.add(pid);
  }
  const unproven = { detail: `Hive couldn't confirm that ${spec.name} itself is serving its socket, so it won't use it.` };
  if (pids.size === 0) return unproven;
  let version = "";
  for (const id of pids) {
    // Given a pid, codesign checks the running code's dynamic signature, not a file that may differ from it.
    const listener = await run(TOOLS.codesign, ["--verify", `-R${requirement(spec.listenerId, spec.team)}`, id], QUICK);
    if (listener.code !== 0) return unproven;
    const executable = await executableOf(run, id);
    const app = outerApp(executable);
    if (!executable.startsWith("/") || !app) return unproven;
    const bundle = await run(TOOLS.codesign, ["--verify", `-R${requirement(spec.appId, spec.team)}`, app], QUICK);
    if (bundle.code !== 0) return unproven;
    version = (await run(TOOLS.plutil, ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", `${app}/Contents/Info.plist`], QUICK)).stdout.trim();
  }
  return { version };
}

async function dockerSays(deps: AttestDeps, endpoint: string, args: readonly string[]): Promise<string | null> {
  if (!deps.docker) return null;
  const result = await deps.run(deps.docker, ["--host", endpoint, ...args], { timeoutMs: 10_000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

function quoted(text: string | null): string | null {
  try {
    const value: unknown = JSON.parse(text ?? "");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Attests one endpoint: socket path, the signed program serving it, then what the engine says about itself. */
export async function attestEndpoint(deps: AttestDeps, given: string): Promise<EngineVerdict> {
  const socket = socketFor(given, deps.home, deps.uid);
  if (socket.kind === "refused") return refuse("unsupported", socket.detail);
  if (socket.kind === "absent") return refuse("stopped", `${socket.provider?.name ?? "The Docker engine"} isn't running.`, socket.provider?.name);
  const spec = socket.provider;
  const endpoint = `unix://${socket.path}`;
  const listener = await attestListener(deps.run, socket.path, spec);
  if ("detail" in listener) return refuse("unsupported", listener.detail, spec.name);
  const platform = quoted(await dockerSays(deps, endpoint, ["version", "--format", "{{json .Server.Platform.Name}}"]));
  if (platform === null) return refuse("stopped", `${spec.name} is installed but its engine isn't answering yet.`, spec.name, listener.version || null);
  if (spec.id === "docker-desktop") {
    const version = platform.startsWith("Docker Desktop ") ? platform.slice("Docker Desktop ".length).split(" ")[0] ?? "" : "";
    if (!version) return refuse("unsupported", "The engine on Docker Desktop's socket doesn't say it is Docker Desktop.", spec.name);
    if (!atLeast(version, spec.floor)) return refuse("unsupported", `Docker Desktop ${spec.floor.join(".")} or newer is required.`, spec.name, version);
    return { status: "ready", engine: { provider: spec.id, name: spec.name, endpoint, version } };
  }
  const system = quoted(await dockerSays(deps, endpoint, ["info", "--format", "{{json .OperatingSystem}}"]));
  if (system !== "OrbStack") return refuse("unsupported", "The engine on OrbStack's socket doesn't say it is OrbStack.", spec.name);
  if (!atLeast(listener.version, spec.floor)) return refuse("unsupported", `OrbStack ${spec.floor.join(".")} or newer is required.`, spec.name, listener.version || null);
  return { status: "ready", engine: { provider: spec.id, name: spec.name, endpoint, version: listener.version } };
}

export async function selectedEndpoint(deps: AttestDeps): Promise<string | null> {
  if (!deps.docker) return null;
  const shown = await deps.run(deps.docker, ["context", "show"], QUICK);
  const context = shown.stdout.trim();
  if (shown.code !== 0 || !CONTEXT.test(context)) return null;
  const inspected = await deps.run(deps.docker, ["context", "inspect", context, "--format", "{{(index .Endpoints \"docker\").Host}}"], QUICK);
  return inspected.code === 0 && inspected.stdout.trim() ? inspected.stdout.trim() : null;
}

/** The engine behind the user's selected Docker context; Hive never changes that selection. */
export async function attestActive(deps: AttestDeps): Promise<EngineVerdict> {
  if (!deps.docker) return refuse("missing", "Docker Desktop or OrbStack isn't installed. Set one up from the Computers page.");
  const endpoint = await selectedEndpoint(deps);
  if (!endpoint) return refuse("check-failed", "Hive couldn't read the selected Docker context.");
  return attestEndpoint(deps, endpoint);
}

export function knownEndpoints(home: string): string[] {
  return Object.values(PROVIDERS).map((provider) => `unix://${home}/${provider.socket}`);
}
