import assert from "node:assert/strict";
import { chmodSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { CommandOutput, CommandRunner } from "../src/commandRunner.ts";
import { attestActive, attestEndpoint, requirement, type EngineVerdict } from "../src/engineAttest.ts";
import { atLeast, PROVIDERS, type ProviderId } from "../src/engineSocket.ts";
import { removeTempDirs, tempDir } from "./fixtures.ts";

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
  removeTempDirs();
});

const UID = process.getuid?.() ?? -1;
const DOCKER_LISTENER = "/Applications/Docker.app/Contents/MacOS/com.docker.backend";
const ORB_LISTENER = "/Applications/OrbStack.app/Contents/Frameworks/OrbStack Helper.app/Contents/MacOS/OrbStack Helper";

// The temp folder sits behind /var -> /private/var; a real home has no symlink, so tests use the resolved path.
const realTemp = (prefix: string) => realpathSync(tempDir(prefix));
const out = (stdout = "", code = 0): CommandOutput => ({ code, stdout, stderr: code === 0 ? "" : "failed", timedOut: false, overflowed: false });

async function listen(path: string): Promise<void> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
}

async function homeWith(provider: ProviderId): Promise<{ home: string; socket: string }> {
  const home = realTemp("hive-attest-");
  const socket = join(home, PROVIDERS[provider].socket);
  mkdirSync(join(socket, ".."), { recursive: true, mode: 0o755 });
  await listen(socket);
  return { home, socket };
}

interface World {
  pids?: Record<string, string>;
  txt?: Record<string, string>;
  running?: Record<string, { id: string; team: string } | null>;
  signed?: Record<string, { id: string; team: string }>;
  versions?: Record<string, string>;
  platform?: string | null;
  system?: string;
  context?: { name: string; host: string } | null;
}

function runner(socket: string, world: World): { run: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const pids = world.pids ?? {};
  const run: CommandRunner = async (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "/usr/sbin/lsof" && args[0] === "-a") {
      const pid = args[2] ?? "";
      return out(world.txt?.[pid] ?? `p${pid}\nftxt\nn${pids[pid] ?? ""}\nftxt\nn/usr/lib/dyld\n`);
    }
    if (file === "/usr/sbin/lsof") return out(Object.keys(pids).map((pid) => `p${pid}\nn${socket}\n`).join(""));
    if (file === "/usr/bin/codesign") {
      const target = args.at(-1) ?? "";
      const running = /^\d+$/.test(target) && world.running && target in world.running ? world.running[target] : undefined;
      const signer = running === undefined ? world.signed?.[/^\d+$/.test(target) ? pids[target] ?? "" : target] : running;
      return out("", signer && args[1] === `-R${requirement(signer.id, signer.team)}` ? 0 : 3);
    }
    if (file === "/usr/bin/plutil") return out(`${world.versions?.[args.at(-1) ?? ""] ?? ""}\n`);
    if (args[0] === "context" && args[1] === "show") return world.context ? out(`${world.context.name}\n`) : out("", 1);
    if (args[0] === "context" && args[1] === "inspect") return out(`${world.context?.host ?? ""}\n`);
    if (args.includes("version")) return world.platform === null ? out("", 1) : out(`${JSON.stringify(world.platform ?? "")}\n`);
    if (args.includes("info")) return out(`${JSON.stringify(world.system ?? "")}\n`);
    return out("", 1);
  };
  return { run, calls };
}

const DOCKER_WORLD: World = {
  pids: { "101": DOCKER_LISTENER },
  signed: { [DOCKER_LISTENER]: { id: "com.docker.docker", team: "9BNSXJN65R" }, "/Applications/Docker.app": { id: "com.docker.docker", team: "9BNSXJN65R" } },
  versions: { "/Applications/Docker.app/Contents/Info.plist": "4.91.0" },
  platform: "Docker Desktop 4.91.0 (239619)",
};

const ORB_WORLD: World = {
  pids: { "202": ORB_LISTENER },
  signed: { [ORB_LISTENER]: { id: "dev.kdrag0n.MacVirt.vmgr", team: "HUAQ24HBR6" }, "/Applications/OrbStack.app": { id: "dev.kdrag0n.MacVirt", team: "HUAQ24HBR6" } },
  versions: { "/Applications/OrbStack.app/Contents/Info.plist": "2.2.5" },
  platform: "Docker Engine - Community",
  system: "OrbStack",
};

async function attestWithCalls(provider: ProviderId, world: World, endpoint?: (home: string, socket: string) => string, uid = UID): Promise<{ verdict: EngineVerdict; calls: string[] }> {
  const { home, socket } = await homeWith(provider);
  const { run, calls } = runner(socket, world);
  return { verdict: await attestEndpoint({ run, docker: "/docker", home, uid }, endpoint?.(home, socket) ?? `unix://${socket}`), calls };
}

const attest = async (...args: Parameters<typeof attestWithCalls>): Promise<EngineVerdict> => (await attestWithCalls(...args)).verdict;
const ORB_HELPER = { id: "dev.kdrag0n.MacVirt.vmgr", team: "HUAQ24HBR6" };

describe("engine attestation", () => {
  it("accepts Docker Desktop and OrbStack only when their signed program serves their own socket", async () => {
    const docker = await attest("docker-desktop", DOCKER_WORLD);
    assert.equal(docker.status, "ready");
    assert.deepEqual(docker.status === "ready" ? [docker.engine.provider, docker.engine.version] : [], ["docker-desktop", "4.91.0"]);
    const orb = await attest("orbstack", ORB_WORLD);
    assert.deepEqual(orb.status === "ready" ? [orb.engine.provider, orb.engine.version, orb.engine.name] : [], ["orbstack", "2.2.5", "OrbStack"]);
  });

  it("holds OrbStack to 2.2.5 from its app bundle, and Docker Desktop to 4.44.3 from what it reports", async () => {
    const orbAt = (version: string) => attest("orbstack", { ...ORB_WORLD, versions: { "/Applications/OrbStack.app/Contents/Info.plist": version } });
    assert.equal((await orbAt("2.3.0")).status, "ready");
    const old = await orbAt("2.2.4");
    assert.equal(old.status, "unsupported");
    assert.match(old.detail, /OrbStack 2\.2\.5 or newer/);
    const dockerAt = (platform: string) => attest("docker-desktop", { ...DOCKER_WORLD, platform });
    assert.equal((await dockerAt("Docker Desktop 4.44.3 (202357)")).status, "ready");
    const tooOld = await dockerAt("Docker Desktop 4.44.2 (201030)");
    assert.match(tooOld.status === "ready" ? "" : tooOld.detail, /Docker Desktop 4\.44\.3 or newer/);
  });

  it("refuses a listener signed by another team, under another identifier, or no listener at all", async () => {
    const wrongTeam = { ...ORB_WORLD, signed: { ...ORB_WORLD.signed, [ORB_LISTENER]: { id: "dev.kdrag0n.MacVirt.vmgr", team: "9BNSXJN65R" } } };
    const wrongId = { ...ORB_WORLD, signed: { ...ORB_WORLD.signed, [ORB_LISTENER]: { id: "com.example.helper", team: "HUAQ24HBR6" } } };
    for (const world of [wrongTeam, wrongId, { ...ORB_WORLD, pids: {} }]) {
      const verdict = await attest("orbstack", world);
      assert.equal(verdict.status, "unsupported");
      assert.match(verdict.detail, /couldn't confirm that OrbStack itself is serving its socket/);
    }
  });

  it("refuses when any one of the processes serving the socket isn't the vendor's", async () => {
    const verdict = await attest("docker-desktop", { ...DOCKER_WORLD, pids: { "101": DOCKER_LISTENER, "303": "/tmp/impostor" } });
    assert.match(verdict.status === "ready" ? "" : verdict.detail, /couldn't confirm that Docker Desktop itself/);
  });

  it("verifies the running process by pid and reads the bundle from the kernel's executable path", async () => {
    const { verdict, calls } = await attestWithCalls("orbstack", ORB_WORLD);
    assert.deepEqual(verdict.status === "ready" ? verdict.engine.version : null, "2.2.5");
    assert.ok(calls.includes(`/usr/bin/codesign --verify -R${requirement(ORB_HELPER.id, ORB_HELPER.team)} 202`));
    assert.ok(calls.includes("/usr/sbin/lsof -a -p 202 -d txt -F n"));
    assert.ok(calls.includes(`/usr/bin/codesign --verify -R${requirement("dev.kdrag0n.MacVirt", ORB_HELPER.team)} /Applications/OrbStack.app`));
    assert.equal(calls.some((call) => call.startsWith("/bin/ps")), false);
  });

  it("refuses a process that only names itself the vendor's helper (argv[0] spoof)", async () => {
    const node = { ...ORB_WORLD, pids: { "202": "/opt/homebrew/bin/node" } };
    const lying = { ...ORB_WORLD, running: { "202": null } };
    for (const world of [node, lying]) {
      const { verdict, calls } = await attestWithCalls("orbstack", world);
      assert.match(verdict.status === "ready" ? "" : verdict.detail, /couldn't confirm that OrbStack itself/);
      assert.equal(calls.some((call) => call.startsWith("/usr/bin/plutil")), false);
    }
  });

  it("takes the outer app from the kernel's executable path", async () => {
    const copy = "/Users/someone/Copies/OrbStack.app";
    const helper = `${copy}/Contents/Frameworks/OrbStack Helper.app/Contents/MacOS/OrbStack Helper`;
    const world = { ...ORB_WORLD, pids: { "202": helper }, running: { "202": ORB_HELPER }, signed: { [copy]: { id: "dev.kdrag0n.MacVirt", team: "HUAQ24HBR6" } }, versions: { [`${copy}/Contents/Info.plist`]: "2.4.0" } };
    const { verdict, calls } = await attestWithCalls("orbstack", world);
    assert.deepEqual(verdict.status === "ready" ? verdict.engine.version : null, "2.4.0");
    assert.ok(calls.includes(`/usr/bin/codesign --verify -R${requirement("dev.kdrag0n.MacVirt", ORB_HELPER.team)} ${copy}`));
    assert.equal(calls.some((call) => call.includes("/Applications/OrbStack.app")), false);
  });

  it("refuses when the kernel names no absolute executable inside an app", async () => {
    for (const txt of ["p202\n", "p202\nfcwd\nn/\n", "p202\nftxt\nnOrbStack Helper\n", "p202\nftxt\nn/usr/local/bin/helper\n"]) {
      const verdict = await attest("orbstack", { ...ORB_WORLD, txt: { "202": txt } });
      assert.equal(verdict.status, "unsupported", txt);
    }
  });

  it("refuses an engine whose own report disagrees with the socket it answers on", async () => {
    const docker = await attest("docker-desktop", { ...DOCKER_WORLD, platform: "Docker Engine - Community" });
    assert.match(docker.status === "ready" ? "" : docker.detail, /doesn't say it is Docker Desktop/);
    const orb = await attest("orbstack", { ...ORB_WORLD, system: "Docker Desktop" });
    assert.match(orb.status === "ready" ? "" : orb.detail, /doesn't say it is OrbStack/);
  });

  it("reports a signed engine that doesn't answer yet as stopped, with its version", async () => {
    const verdict = await attest("orbstack", { ...ORB_WORLD, platform: null });
    assert.deepEqual(verdict.status === "ready" ? null : [verdict.status, verdict.version], ["stopped", "2.2.5"]);
  });

  it("follows a symlink only when the chain ends exactly at the user's own engine socket", async () => {
    const linked = await attest("orbstack", ORB_WORLD, (home, socket) => {
      symlinkSync(socket, join(home, "docker.sock"));
      return `unix://${join(home, "docker.sock")}`;
    });
    assert.equal(linked.status, "ready");
    const elsewhere = realTemp("hive-attest-other-");
    await listen(join(elsewhere, "docker.sock"));
    const other = await attest("orbstack", ORB_WORLD, (home) => {
      symlinkSync(join(elsewhere, "docker.sock"), join(home, "docker.sock"));
      return `unix://${join(home, "docker.sock")}`;
    });
    assert.equal(other.status, "unsupported");
    const loop = await attest("orbstack", ORB_WORLD, (home) => {
      symlinkSync(join(home, "b"), join(home, "a"));
      symlinkSync(join(home, "a"), join(home, "b"));
      return `unix://${join(home, "a")}`;
    });
    assert.equal(loop.status, "unsupported");
  });

  it("refuses a socket owned by another user or in a folder others can write", async () => {
    const foreign = await attest("orbstack", ORB_WORLD, undefined, UID + 1);
    assert.match(foreign.status === "ready" ? "" : foreign.detail, /isn't owned and guarded by your user/);
    const open = await attest("orbstack", ORB_WORLD, (_home, socket) => {
      chmodSync(join(socket, ".."), 0o775);
      return `unix://${socket}`;
    });
    assert.match(open.status === "ready" ? "" : open.detail, /isn't owned and guarded by your user/);
  });

  it("refuses TCP, SSH and other users' sockets before running anything", async () => {
    for (const endpoint of ["tcp://127.0.0.1:2375", "ssh://mac", "unix:///tmp/docker.sock", "unix:///Users/someone/.orbstack/run/docker.sock"]) {
      const { run, calls } = runner("", ORB_WORLD);
      const verdict = await attestEndpoint({ run, docker: "/docker", home: realTemp("hive-attest-"), uid: UID }, endpoint);
      assert.equal(verdict.status, "unsupported", endpoint);
      assert.deepEqual(calls, [], endpoint);
    }
  });

  it("reports an engine whose socket is absent as stopped, and no Docker CLI as missing", async () => {
    const home = realTemp("hive-attest-");
    const { run } = runner("", ORB_WORLD);
    const verdict = await attestEndpoint({ run, docker: "/docker", home, uid: UID }, `unix://${join(home, PROVIDERS.orbstack.socket)}`);
    assert.deepEqual(verdict.status === "ready" ? null : [verdict.status, verdict.provider], ["stopped", "OrbStack"]);
    assert.equal((await attestActive({ run, docker: null, home, uid: UID })).status, "missing");
  });

  it("attests the engine of the selected Docker context and refuses a context it can't read", async () => {
    const { home, socket } = await homeWith("orbstack");
    const selected = runner(socket, { ...ORB_WORLD, context: { name: "orbstack", host: `unix://${socket}` } });
    assert.equal((await attestActive({ run: selected.run, docker: "/docker", home, uid: UID })).status, "ready");
    for (const context of [null, { name: "bad name; rm", host: `unix://${socket}` }]) {
      const { run } = runner(socket, { ...ORB_WORLD, context });
      assert.equal((await attestActive({ run, docker: "/docker", home, uid: UID })).status, "check-failed");
    }
  });

  it("compares versions part by part", () => {
    assert.equal(atLeast("2.2.5", [2, 2, 5]), true);
    assert.equal(atLeast("2.10.0", [2, 2, 5]), true);
    assert.equal(atLeast("2.2", [2, 2, 5]), false);
    assert.equal(atLeast("beta", [2, 2, 5]), false);
  });
});
