import { stagingPrefix, tempPrefix } from "./engineSetupPins.ts";
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { CommandRunner } from "./commandRunner.ts";
import { detach, hdiutilInfo } from "./engineInstall.ts";

export interface CleanupDeps {
  run: CommandRunner;
  cacheRoot: string;
  applicationsDir: string;
  tag: string;
  log: (line: string) => void;
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function realDirectories(parent: string, prefix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  return names.filter((name) => name.startsWith(prefix) && lstatSync(join(parent, name)).isDirectory()).map((name) => join(parent, name));
}

function stillMounted(tmp: string): boolean {
  try {
    return lstatSync(join(tmp, "mnt")).dev !== lstatSync(tmp).dev;
  } catch {
    return false;
  }
}

/** Detaches every image whose file lives under Hive's setup folder; returns how many were detached. */
async function detachLeftovers(deps: CleanupDeps, root: string): Promise<number> {
  let count = 0;
  const roots = [root, resolve(deps.cacheRoot)].map((prefix) => join(prefix, tempPrefix(deps.tag)));
  for (const image of (await hdiutilInfo(deps.run)).images) {
    const paths = [realOrNull(image["image-path"]), resolve(image["image-path"])];
    if (!paths.some((path) => path !== null && roots.some((prefix) => path.startsWith(prefix)))) continue;
    const mounts = image["system-entities"].flatMap((entity) => entity["mount-point"] ? [entity["mount-point"]] : []);
    const targets = mounts.length > 0 ? mounts : image["system-entities"].flatMap((entity) => entity["dev-entry"] ? [entity["dev-entry"]] : []).slice(0, 1);
    for (const target of targets) {
      if (await detach(deps.run, target)) count += 1;
      else deps.log(`engine setup cleanup: couldn't detach ${target}`);
    }
  }
  return count;
}

/** On daemon start: detach images mounted from the setup folder, then remove leftover temp and staging folders. */
export async function cleanupLeftovers(deps: CleanupDeps): Promise<void> {
  const root = realOrNull(deps.cacheRoot);
  let detached = 0;
  if (root) {
    try {
      detached = await detachLeftovers(deps, root);
    } catch (error) {
      deps.log(`engine setup cleanup: couldn't list mounted images (${error instanceof Error ? error.message : String(error)}); temp folders kept`);
      return;
    }
  }
  const temps = (root ? realDirectories(deps.cacheRoot, tempPrefix(deps.tag)) : []).filter((path) => {
    if (!stillMounted(path)) return true;
    deps.log(`engine setup cleanup: kept ${path}, an image is still mounted inside it`);
    return false;
  });
  const staging = realDirectories(deps.applicationsDir, stagingPrefix(deps.tag));
  for (const path of [...temps, ...staging]) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      deps.log(`engine setup cleanup: couldn't remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (detached + temps.length + staging.length > 0) {
    deps.log(`engine setup cleanup: detached ${detached} image(s), removed ${temps.length} temp and ${staging.length} staging folder(s)`);
  }
}
