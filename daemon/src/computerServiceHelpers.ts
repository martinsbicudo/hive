import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Images } from "./computerArgs.ts";
import type { CommandResult } from "./docker.ts";
import { log } from "./log.ts";
import { VERSION } from "./version.ts";

export class ComputerToolError extends Error {}

export const SCREENSHOT_LIMIT_BYTES = 20 * 1024 * 1024;
export const DISPLAY = ["env", "DISPLAY=:1"];
export const BUTTONS = { left: "1", middle: "2", right: "3" } as const;
export const WRITE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';

export function lastLine(result: CommandResult): string {
  return result.stderr.trim().split("\n").pop() || `exit code ${result.code}`;
}

// The tag carries a hash of the build context, so a changed guest script rebuilds on existing installs.
export function contextHash(directory: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(directory).sort()) {
    hash.update(name).update("\0").update(readFileSync(join(directory, name))).update("\0");
  }
  return hash.digest("hex").slice(0, 8);
}

export function defaultImages(contexts: Images = defaultBuildContexts()): Images {
  const computer = `${VERSION}-${contextHash(contexts.computer)}`;
  return {
    computer: `hive/computer:${computer}`,
    netns: `hive/netns:${VERSION}-${contextHash(contexts.netns)}`,
    profiles: { terminal: `hive/computer:${computer}-terminal`, browser: `hive/computer:${computer}-browser` },
  };
}

export function defaultBuildContexts(): Images {
  const computer = fileURLToPath(new URL("../../sandbox/computer", import.meta.url));
  return { computer, netns: fileURLToPath(new URL("../../sandbox/netns", import.meta.url)), profiles: { terminal: computer, browser: computer } };
}

export const PROFILE_DOCKERFILES = { terminal: "Dockerfile.terminal", browser: "Dockerfile.browser" } as const;

export const BROWSER_SCRIPT = '[ -s /tmp/agent-runtime/dbus-address ] || exit 1; export DISPLAY=:1 XDG_RUNTIME_DIR=/tmp/agent-runtime DBUS_SESSION_BUS_ADDRESS="$(cat /tmp/agent-runtime/dbus-address)"; exec chromium --ozone-platform=x11 --disable-gpu --no-sandbox --disable-dev-shm-usage --no-first-run --hide-crash-restore-bubble -- "$1"';
// Bounded and never fatal: a screenshot taken before the window manager or Chromium has drawn is just black.
export const DESKTOP_READY_SCRIPT = 'export DISPLAY=:1; for _ in $(seq 1 75); do xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id" && { sleep 1; exit 0; }; sleep 0.2; done; exit 0';
export const BROWSER_READY_SCRIPT = 'export DISPLAY=:1; for _ in $(seq 1 50); do xdotool search --onlyvisible --class chromium >/dev/null 2>&1 && { sleep 1; exit 0; }; sleep 0.2; done; exit 0';

/** Cleanup work whose failure is logged, so one engine or computer can't stop the rest. */
export async function quietly(work: Promise<void>): Promise<void> {
  try {
    await work;
  } catch (error) {
    log(`computer cleanup: ${String(error)}`);
  }
}
