import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { claimHome, processStart, releaseHome, type HomeLockDeps } from "../src/homeLock.ts";
import { removeTempDirs, tempDir, writeWhole } from "./fixtures.ts";

after(removeTempDirs);

// Each running process is a pid and the time it started.
function deps(pid: number, running: Map<number, string>, waitMs = 1000): HomeLockDeps & { slept: number[] } {
  const slept: number[] = [];
  return { pid, alive: (other) => running.has(other), startOf: (other) => running.get(other) ?? null, sleep: async (ms) => void slept.push(ms), waitMs, slept };
}

const lockOf = (dir: string): string => readFileSync(join(dir, "daemon.lock"), "utf8");

describe("one daemon per Hive folder", () => {
  it("claims a free folder with its pid and start time, leaving no temp file", async () => {
    const dir = tempDir("hive-lock-");
    assert.equal(await claimHome(dir, deps(101, new Map([[101, "Sun 10:00"]]))), true);
    assert.equal(lockOf(dir), "101\nSun 10:00");
    assert.deepEqual(readdirSync(dir), ["daemon.lock"]);
  });

  it("refuses a second daemon while the first is alive, after waiting for it to finish", async () => {
    const dir = tempDir("hive-lock-");
    const running = new Map([[101, "Sun 10:00"], [202, "Sun 10:05"]]);
    await claimHome(dir, deps(101, running));
    const second = deps(202, running, 1000);
    assert.equal(await claimHome(dir, second), false);
    assert.equal(second.slept.reduce((sum, ms) => sum + ms, 0), 1000);
    assert.equal(lockOf(dir), "101\nSun 10:00");
  });

  it("takes over once the first daemon exits while it waits", async () => {
    const dir = tempDir("hive-lock-");
    const running = new Map([[101, "Sun 10:00"], [202, "Sun 10:05"]]);
    await claimHome(dir, deps(101, running));
    const second = deps(202, running, 8000);
    second.sleep = async () => {
      running.delete(101);
    };
    assert.equal(await claimHome(dir, second), true);
    assert.equal(lockOf(dir), "202\nSun 10:05");
  });

  it("takes over a lock whose pid now belongs to another process, after a crash and pid reuse", async () => {
    const dir = tempDir("hive-lock-");
    writeWhole(join(dir, "daemon.lock"), "101\nSat 09:00");
    const running = new Map([[101, "Sun 08:00"], [303, "Sun 10:00"]]);
    const claimer = deps(303, running);
    assert.equal(await claimHome(dir, claimer), true);
    assert.equal(lockOf(dir), "303\nSun 10:00");
    assert.deepEqual(claimer.slept, []);
  });

  it("takes over a lock left by a daemon that died, or one it can't read", async () => {
    const dir = tempDir("hive-lock-");
    writeWhole(join(dir, "daemon.lock"), "4242\nSat 09:00");
    assert.equal(await claimHome(dir, deps(303, new Map([[303, "Sun 10:00"]]))), true);
    assert.equal(lockOf(dir), "303\nSun 10:00");
    writeWhole(join(dir, "daemon.lock"), "garbage");
    assert.equal(await claimHome(dir, deps(404, new Map([[404, "Sun 11:00"]]))), true);
    assert.equal(lockOf(dir), "404\nSun 11:00");
  });

  it("keeps a live holder whose start can't be read, on either side, instead of taking it over", async () => {
    const dir = tempDir("hive-lock-");
    writeWhole(join(dir, "daemon.lock"), "101\nunknown");
    const running = new Map([[101, "Sun 10:00"], [202, "Sun 10:05"]]);
    assert.equal(await claimHome(dir, deps(202, running, 500)), false);
    writeWhole(join(dir, "daemon.lock"), "101\nSun 10:00");
    const blind = deps(202, running, 500);
    blind.startOf = (other) => other === 202 ? "Sun 10:05" : null;
    assert.equal(await claimHome(dir, blind), false);
    assert.equal(lockOf(dir), "101\nSun 10:00");
  });

  it("releases only its own lock", async () => {
    const dir = tempDir("hive-lock-");
    await claimHome(dir, deps(101, new Map([[101, "Sun 10:00"]])));
    releaseHome(dir, 999);
    assert.equal(lockOf(dir), "101\nSun 10:00");
    releaseHome(dir, 101);
    assert.equal(existsSync(join(dir, "daemon.lock")), false);
    releaseHome(dir, 101);
  });

  it("reads a running process's start time and nothing for a pid that isn't running", () => {
    assert.match(processStart(process.pid) ?? "", /\d{2}:\d{2}:\d{2} \d{4}$/);
    assert.equal(processStart(2 ** 22 + 12_345), null);
  });

  it("reads the same start whatever time zone and language the reading daemon runs with", () => {
    const script = `import { processStart } from ${JSON.stringify(new URL("../src/homeLock.ts", import.meta.url).href)}; console.log(processStart(${process.pid}));`;
    const read = (env: Record<string, string>) => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } }).trim();
    const plain = processStart(process.pid);
    assert.equal(read({ TZ: "Asia/Tokyo" }), plain);
    assert.equal(read({ LC_ALL: "pt_BR.UTF-8", LANG: "pt_BR.UTF-8" }), plain);
  });
});
