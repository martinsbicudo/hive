import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { z } from "zod";
import type { CommandRunner } from "./commandRunner.ts";
import { SetupCancelled, SetupError, stagingPrefix, TOOLS, type SetupPin } from "./engineSetupPins.ts";
import { missing, verifyApp } from "./engineVerify.ts";

const ATTACH_MS = 5 * 60_000;
const COPY_MS = 20 * 60_000;
const QUICK_MS = 60_000;

const entitySchema = z.object({ "mount-point": z.string().optional(), "dev-entry": z.string().optional() });
const attachSchema = z.object({ "system-entities": z.array(entitySchema) });
const infoSchema = z.object({ images: z.array(z.object({ "image-path": z.string(), "system-entities": z.array(entitySchema) })).default([]) });

export type HdiutilInfo = z.infer<typeof infoSchema>;

async function plistJson(run: CommandRunner, plist: string): Promise<unknown> {
  const converted = await run(TOOLS.plutil, ["-convert", "json", "-o", "-", "-"], { input: plist, timeoutMs: QUICK_MS });
  if (converted.code !== 0) throw new SetupError("Hive couldn't read the disk image tool's answer, so it stopped.");
  try {
    return JSON.parse(converted.stdout);
  } catch {
    throw new SetupError("Hive couldn't read the disk image tool's answer, so it stopped.");
  }
}

/** Attaches read-only at our private mount point; exactly one volume, mounted exactly there. */
export async function attach(run: CommandRunner, dmg: string, mountPoint: string, signal: AbortSignal): Promise<void> {
  mkdirSync(mountPoint, { mode: 0o700 });
  const attached = await run(TOOLS.hdiutil, ["attach", "-plist", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountPoint, dmg], { timeoutMs: ATTACH_MS, signal });
  if (attached.code !== 0) throw new SetupError("macOS couldn't open the downloaded disk image, so Hive stopped.");
  const parsed = attachSchema.safeParse(await plistJson(run, attached.stdout));
  if (!parsed.success) throw new SetupError("Hive couldn't read the disk image tool's answer, so it stopped.");
  const mounts = parsed.data["system-entities"].flatMap((entity) => entity["mount-point"] ? [entity["mount-point"]] : []);
  const expected = new Set([mountPoint, realpathSync(mountPoint)]);
  if (mounts.length !== 1 || !mounts.every((mount) => expected.has(mount))) throw new SetupError("The disk image opened in an unexpected way, so Hive stopped.");
}

export async function detach(run: CommandRunner, target: string): Promise<boolean> {
  const first = await run(TOOLS.hdiutil, ["detach", target], { timeoutMs: QUICK_MS });
  if (first.code === 0) return true;
  const forced = await run(TOOLS.hdiutil, ["detach", target, "-force"], { timeoutMs: QUICK_MS });
  return forced.code === 0;
}

export async function hdiutilInfo(run: CommandRunner): Promise<HdiutilInfo> {
  const listed = await run(TOOLS.hdiutil, ["info", "-plist"], { timeoutMs: QUICK_MS });
  if (listed.code !== 0) throw new SetupError("hdiutil info failed");
  const parsed = infoSchema.safeParse(await plistJson(run, listed.stdout));
  if (!parsed.success) throw new SetupError("hdiutil info answered something Hive couldn't read");
  return parsed.data;
}

function inside(root: string, path: string): boolean {
  return path.startsWith(root + sep);
}

/** The image root may hold only the expected app (a real directory), the Applications link and Finder dot-files. */
export function inspectRoot(mountPoint: string, pin: SetupPin): string {
  const root = realpathSync(mountPoint);
  const odd = `The ${pin.spec.name} disk image holds something Hive doesn't expect, so it stopped.`;
  let app: string | null = null;
  for (const name of readdirSync(mountPoint)) {
    const path = join(mountPoint, name);
    const entry = lstatSync(path);
    if (name === pin.appName && entry.isDirectory() && inside(root, realpathSync(path))) app = path;
    else if (name === "Applications" && entry.isSymbolicLink() && readlinkSync(path) === "/Applications") continue;
    else if (name.startsWith(".") && !entry.isSymbolicLink() && !name.endsWith(".app")) continue;
    else throw new SetupError(odd);
  }
  if (!app) throw new SetupError(`The disk image doesn't hold ${pin.appName}, so Hive stopped.`);
  return app;
}

export interface MoveDeps {
  run: CommandRunner;
  tag: string;
  signal: AbortSignal;
  /** Called right before the move into Applications; from then on the setup can't be cancelled. */
  committing: () => void;
}

function appeared(pin: SetupPin): SetupError {
  return new SetupError(`${pin.appName} appeared in Applications while Hive was installing; Hive left it as it is.`);
}

function claim(target: string, pin: SetupPin): void {
  if (!missing(target)) throw appeared(pin);
  try {
    mkdirSync(target, { mode: 0o700 });
  } catch {
    throw appeared(pin);
  }
}

// mkdir claims the name atomically; rename then replaces only that empty directory, and fails if anything filled it.
function moveInto(staged: string, target: string, pin: SetupPin): void {
  claim(target, pin);
  try {
    renameSync(staged, target);
  } catch {
    try {
      rmdirSync(target);
    } catch {
      // not empty: someone else's content now lives there, and it stays.
    }
    throw appeared(pin);
  }
}

/** Copies the verified app to a private staging folder on the Applications volume, verifies it again, then moves it in. */
export async function installApp(deps: MoveDeps, mountedApp: string, applicationsDir: string, pin: SetupPin): Promise<string> {
  const staging = mkdtempSync(join(applicationsDir, stagingPrefix(deps.tag)));
  chmodSync(staging, 0o700);
  const staged = join(staging, pin.appName);
  const target = join(applicationsDir, pin.appName);
  try {
    // Without --noqtn the app keeps the DMG's quarantine and macOS runs it translocated, where OrbStack can't start
    // its engine (seen in E-S5); Hive's own codesign and spctl checks are the gate instead.
    const copied = await deps.run(TOOLS.ditto, ["--noqtn", mountedApp, staged], { timeoutMs: COPY_MS, signal: deps.signal });
    if (copied.code !== 0) throw new SetupError(`Hive couldn't copy ${pin.appName} out of the disk image.`);
    await verifyApp(deps.run, staged, pin, { strict: true, gatekeeper: true, bundle: true }, deps.signal);
    if (deps.signal.aborted) throw new SetupCancelled("cancelled");
    deps.committing();
    moveInto(staged, target, pin);
    try {
      await verifyApp(deps.run, target, pin, { strict: false, gatekeeper: false, bundle: true }, new AbortController().signal);
    } catch (error) {
      renameSync(target, staged);
      throw error;
    }
    return target;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
