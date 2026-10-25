#!/usr/bin/env node
// Dev-only check of the guided setup against a vendor's real DMG: download, verify, mount, inspect, verify the app and a
// staged copy, then detach and delete. It never moves anything into /Applications. Usage:
//   node scripts/check-engine-download.mjs [docker-desktop|orbstack]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileRunner } from "../daemon/src/commandRunner.ts";
import { download, realTimer } from "../daemon/src/engineDownload.ts";
import { attach, detach, inspectRoot } from "../daemon/src/engineInstall.ts";
import { pinFor, TOOLS } from "../daemon/src/engineSetupPins.ts";
import { quarantine, verifyApp, verifyDmg } from "../daemon/src/engineVerify.ts";

const provider = process.argv[2] ?? "docker-desktop";
const pin = pinFor(provider);
const arch = (await execFileRunner("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"])).stdout.trim() === "1" ? "arm64" : "amd64";
const signal = new AbortController().signal;
const tmp = mkdtempSync(join(tmpdir(), "hive-engine-check-"));
const dmg = join(tmp, "engine.dmg");
const mount = join(tmp, "mnt");
const step = (text) => console.log(`- ${text}`);
let mounted = false;

try {
  step(`downloading ${pin.urls[arch]}`);
  let shown = 0;
  await download(fetch, realTimer, {
    url: pin.urls[arch], hosts: pin.hosts, dest: dmg, signal,
    onBytes: (received, total) => {
      const mb = Math.floor(received / 50e6);
      if (mb > shown) { shown = mb; console.log(`  ${(received / 1e6).toFixed(0)} MB of ${total ? (total / 1e6).toFixed(0) : "?"} MB`); }
    },
  });
  await quarantine(execFileRunner, dmg, Math.floor(Date.now() / 1000), signal);
  step(`quarantine: ${(await execFileRunner("/usr/bin/xattr", ["-p", "com.apple.quarantine", dmg])).stdout.trim()}`);
  await verifyDmg(execFileRunner, dmg, pin, signal);
  step("DMG signature and notarization verified");
  await attach(execFileRunner, dmg, mount, signal);
  mounted = true;
  const app = inspectRoot(mount, pin);
  step(`mounted read-only; root holds only ${pin.appName}`);
  await verifyApp(execFileRunner, app, pin, { strict: true, gatekeeper: true, bundle: true }, signal);
  step("app in the DMG verified (strict, notarized, bundle id, version floor, size)");
  const staged = join(tmp, "staging", pin.appName);
  const copied = await execFileRunner(TOOLS.ditto, ["--noqtn", app, staged], { timeoutMs: 600_000 });
  if (copied.code !== 0) throw new Error(`ditto failed: ${copied.stderr}`);
  await verifyApp(execFileRunner, staged, pin, { strict: true, gatekeeper: true, bundle: true }, signal);
  step("staged copy verified again; stopping before the move into /Applications");
  console.log("check-engine-download: all checks passed");
} catch (error) {
  console.error(`check-engine-download: FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (mounted && !(await detach(execFileRunner, mount))) console.error(`couldn't detach ${mount}`);
  rmSync(tmp, { recursive: true, force: true });
}
