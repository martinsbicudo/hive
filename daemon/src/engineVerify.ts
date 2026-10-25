import { accessSync, constants, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CommandOptions, CommandRunner } from "./commandRunner.ts";
import { requirement } from "./engineAttest.ts";
import { atLeast } from "./engineSocket.ts";
import { LIMITS, SetupError, TOOLS, type Arch, type SetupPin } from "./engineSetupPins.ts";

export interface CheckDeps {
  run: CommandRunner;
  freeBytes: (path: string) => number;
  signal: AbortSignal;
}

const QUICK_MS = 60_000;
const LONG_MS = 10 * 60_000;

async function must(run: CommandRunner, file: string, args: readonly string[], options: CommandOptions, failure: string): Promise<string> {
  const result = await run(file, args, options);
  if (result.code !== 0 || result.timedOut) throw new SetupError(failure);
  return `${result.stdout}\n${result.stderr}`;
}

export function missing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

export function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** This Mac can take the engine: macOS 14+, Gatekeeper on, room on both volumes, Applications writable. */
export async function checkMac(deps: CheckDeps, pin: SetupPin, cacheRoot: string, applicationsDir: string): Promise<Arch> {
  const options = { timeoutMs: QUICK_MS, signal: deps.signal };
  const version = (await must(deps.run, TOOLS.swVers, ["-productVersion"], options, "Hive couldn't read this Mac's macOS version.")).trim();
  if (!atLeast(version, LIMITS.minMacos)) throw new SetupError(`${pin.spec.name} needs macOS 14 or newer; this Mac has ${version.slice(0, 20)}.`);
  const arm = await deps.run(TOOLS.sysctl, ["-n", "hw.optional.arm64"], options);
  const arch: Arch = arm.code === 0 && arm.stdout.trim() === "1" ? "arm64" : "amd64";
  const gatekeeper = await must(deps.run, TOOLS.spctl, ["--status"], options, "Hive couldn't read Gatekeeper's status.");
  if (!/assessments enabled/.test(gatekeeper)) throw new SetupError("Gatekeeper is turned off on this Mac, so Hive won't install apps. Turn it back on and try again.");
  for (const volume of [cacheRoot, applicationsDir]) {
    if (deps.freeBytes(volume) < LIMITS.minFreeBytes) throw new SetupError(`${pin.spec.name} needs at least 15 GB free on the disk that holds ${volume}.`);
  }
  try {
    accessSync(applicationsDir, constants.W_OK);
  } catch {
    throw new SetupError(`Hive can't write to ${applicationsDir}, so it can't install ${pin.spec.name}. Install it yourself from the vendor's site.`);
  }
  if (!missing(join(applicationsDir, pin.appName))) throw new SetupError(`${pin.appName} is already in ${applicationsDir}; use Start instead.`);
  return arch;
}

function notarized(output: string, team: string): boolean {
  const origin = /^origin=.*\(([A-Z0-9]{10})\)\s*$/m.exec(output);
  return /^source=Notarized Developer ID\s*$/m.test(output) && origin?.[1] === team;
}

/** The disk image itself must be signed by the vendor's team and notarized, before it is ever attached. */
export async function verifyDmg(run: CommandRunner, dmg: string, pin: SetupPin, signal: AbortSignal): Promise<void> {
  const options = { timeoutMs: LONG_MS, signal };
  const team = pin.spec.team;
  const wrong = `The downloaded ${pin.spec.name} disk image isn't signed by its vendor (Team ${team}), so Hive deleted it.`;
  await must(run, TOOLS.codesign, ["--verify", `-R=anchor apple generic and certificate leaf[subject.OU] = "${team}"`, dmg], options, wrong);
  const assessed = await must(run, TOOLS.spctl, ["-a", "-vv", "-t", "open", "--context", "context:primary-signature", dmg], options, `Gatekeeper refused the ${pin.spec.name} disk image, so Hive deleted it.`);
  if (!notarized(assessed, team)) throw new SetupError(`The ${pin.spec.name} disk image isn't notarized by Apple for its vendor, so Hive deleted it.`);
}

export interface AppCheck {
  strict: boolean;
  gatekeeper: boolean;
  bundle: boolean;
}

async function bundleValue(run: CommandRunner, app: string, key: string, signal: AbortSignal): Promise<string> {
  const result = await run(TOOLS.plutil, ["-extract", key, "raw", "-o", "-", join(app, "Contents", "Info.plist")], { timeoutMs: QUICK_MS, signal });
  return result.code === 0 ? result.stdout.trim() : "";
}

/** The app must satisfy the vendor's designated requirement, be notarized, and be the expected bundle at or above the floor. */
export async function verifyApp(run: CommandRunner, app: string, pin: SetupPin, check: AppCheck, signal: AbortSignal): Promise<void> {
  const { spec } = pin;
  const options = { timeoutMs: LONG_MS, signal };
  const strict = check.strict ? ["--deep", "--strict"] : [];
  await must(run, TOOLS.codesign, ["--verify", ...strict, `-R${requirement(spec.appId, spec.team)}`, app], options, `${pin.appName} isn't signed by ${spec.name}'s vendor (${spec.appId}, Team ${spec.team}), so Hive won't use it.`);
  if (check.gatekeeper) {
    const assessed = await must(run, TOOLS.spctl, ["-a", "-vv", "-t", "exec", app], options, `Gatekeeper refused ${pin.appName}, so Hive won't use it.`);
    if (!notarized(assessed, spec.team)) throw new SetupError(`${pin.appName} isn't notarized by Apple for its vendor, so Hive won't use it.`);
  }
  if (!check.bundle) return;
  if ((await bundleValue(run, app, "CFBundleIdentifier", signal)) !== spec.appId) throw new SetupError(`${pin.appName} isn't ${spec.name} (${spec.appId}), so Hive won't use it.`);
  const version = await bundleValue(run, app, "CFBundleShortVersionString", signal);
  if (!atLeast(version, spec.floor)) throw new SetupError(`This ${spec.name} (${version.slice(0, 20) || "unknown version"}) is older than ${spec.floor.join(".")}, which Hive needs.`);
  if (bundleBytes(app, LIMITS.maxBundleBytes) > LIMITS.maxBundleBytes) throw new SetupError(`${pin.appName} is larger than Hive allows (4 GB), so it won't copy it.`);
}

/** Sums file sizes without following links; stops counting once past `cap`. */
export function bundleBytes(root: string, cap: number): number {
  let total = 0;
  const pending = [root];
  for (let path = pending.pop(); path !== undefined && total <= cap; path = pending.pop()) {
    const entry = lstatSync(path);
    total += entry.size;
    if (entry.isDirectory()) for (const name of readdirSync(path)) pending.push(join(path, name));
  }
  return total;
}

/** Marks the image as downloaded, so Gatekeeper also checks the app when the owner first opens it. */
export async function quarantine(run: CommandRunner, path: string, nowSeconds: number, signal: AbortSignal): Promise<void> {
  const value = `0081;${Math.floor(nowSeconds).toString(16)};Hive;`;
  await must(run, TOOLS.xattr, ["-w", "com.apple.quarantine", value, path], { timeoutMs: QUICK_MS, signal }, "Hive couldn't mark the download for Gatekeeper, so it stopped.");
}
