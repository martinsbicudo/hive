import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentRunArgs, commandArgv, holderRunArgs, InvalidAgentIdError, namesFor, networkCreateArgs, volumeCreateArgs,
} from "../src/computerArgs.ts";
import { Computers, ComputerError } from "../src/computers.ts";
import type { DockerRunner } from "../src/docker.ts";
import { fakeDocker, ok, type Call } from "./fixtures.ts";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const INSTANCE = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const images = { computer: "hive/computer:test", netns: "hive/netns:test" };

function computers(runner: DockerRunner, now = () => 0) {
  return new Computers(runner, {
    instanceId: INSTANCE, images, buildContexts: { computer: "/ctx/computer", netns: "/ctx/netns" }, idleMs: 15 * 60_000, now, onChange: () => undefined,
  });
}

function indexOfCall(calls: Call[], predicate: (args: readonly string[]) => boolean): number {
  return calls.findIndex((call) => predicate(call.args));
}

describe("computer names", () => {
  it("only accepts agent ids that are UUIDs, so container names can't be steered", () => {
    assert.equal(namesFor(ID).agent, `hive-${ID}`);
    assert.throws(() => namesFor("../etc"), InvalidAgentIdError);
    assert.throws(() => namesFor(`${ID} --privileged`), InvalidAgentIdError);
  });
});

describe("docker arguments", () => {
  it("gives only the network guard NET_ADMIN and publishes the screen on 127.0.0.1 only", () => {
    const args = holderRunArgs(ID, images, INSTANCE);
    assert.deepEqual(args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 4), ["--cap-drop", "ALL", "--cap-add", "NET_ADMIN"]);
    assert.ok(args.includes("127.0.0.1::6080"));
    assert.ok(!args.some((arg) => /^0\.0\.0\.0|^::\d/.test(arg)));
  });

  it("runs the computer with no capabilities, read-only, inside the guard's network, without host paths or env", () => {
    const args = agentRunArgs(ID, images, INSTANCE);
    assert.equal(args[args.indexOf("--network") + 1], `container:hive-netns-${ID}`);
    assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
    assert.ok(!args.includes("--cap-add"));
    assert.ok(!args.includes("--privileged"));
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("no-new-privileges"));
    assert.ok(args.includes("--init"), "an init reaps the processes a lease kill leaves behind");
    assert.ok(!args.includes("-e") && !args.includes("--env") && !args.includes("-p"));
    const mounts = args.filter((_, index) => args[index - 1] === "-v");
    assert.deepEqual(mounts, [`hive-home-${ID}:/home/agent`]);
  });

  it("caps command time inside the container and passes the command as one argument", () => {
    assert.deepEqual(commandArgv("echo hi; uname -a", 9999), ["timeout", "-s", "KILL", "600", "bash", "-lc", "echo hi; uname -a"]);
  });
});

describe("ownership labels", () => {
  it("labels every container, the network and the volume with the agent and this Hive's instance", () => {
    for (const args of [holderRunArgs(ID, images, INSTANCE), agentRunArgs(ID, images, INSTANCE), networkCreateArgs(ID, INSTANCE), volumeCreateArgs(ID, INSTANCE)]) {
      const labels = args.filter((_, index) => args[index - 1] === "--label");
      assert.ok(labels.includes(`hive.agent=${ID}`), args.join(" "));
      assert.ok(labels.includes(`hive.instance=${INSTANCE}`), args.join(" "));
    }
    assert.deepEqual(volumeCreateArgs(ID, INSTANCE).slice(0, 2).concat(volumeCreateArgs(ID, INSTANCE).slice(-1)), ["volume", "create", `hive-home-${ID}`]);
    assert.throws(() => volumeCreateArgs(ID, "x --label y"), InvalidAgentIdError);
  });
});


describe("computer lifecycle", () => {
  it("starts the guard, confirms the firewall, then the computer, then the screen", async () => {
    const docker = fakeDocker(undefined, INSTANCE);
    const machine = computers(docker.runner);
    await machine.ensureRunning(ID);
    const guard = indexOfCall(docker.calls, (args) => args[0] === "run" && args.includes(`hive-netns-${ID}`));
    const verify = indexOfCall(docker.calls, (args) => args.includes("nft"));
    const computer = indexOfCall(docker.calls, (args) => args[0] === "run" && args.includes(`hive-${ID}`));
    const screen = indexOfCall(docker.calls, (args) => args.includes("hive-screen"));
    assert.ok(guard >= 0 && guard < verify && verify < computer && computer < screen);
    assert.equal(machine.statusOf(ID).state, "running");
    assert.equal(machine.screen(ID)?.port, 61234);
  });

  it("never starts the computer when the firewall can't be confirmed", async () => {
    const docker = fakeDocker((args) => (args.includes("nft") ? ok("table inet hive { }") : args[0] === "inspect" ? ok("false") : null), INSTANCE);
    const machine = computers(docker.runner);
    await assert.rejects(machine.ensureRunning(ID), ComputerError);
    assert.equal(indexOfCall(docker.calls, (args) => args[0] === "run" && args.includes(`hive-${ID}`)), -1);
    assert.ok(indexOfCall(docker.calls, (args) => args[0] === "rm" && args.includes(`hive-netns-${ID}`)) >= 0);
    assert.equal(machine.statusOf(ID).state, "error");
  });

  it("hands screen secrets to the vnc user over stdin, never as arguments or env", async () => {
    const docker = fakeDocker(undefined, INSTANCE);
    const machine = computers(docker.runner);
    await machine.ensureRunning(ID);
    const screen = machine.screen(ID);
    assert.ok(screen);
    const writes = docker.calls.filter((call) => call.args.includes("-i") && call.args.includes("vnc"));
    assert.equal(writes.length, 2);
    assert.ok(writes.some((call) => String(call.input).includes(screen.token)));
    assert.ok(!docker.calls.some((call) => call.args.some((arg) => arg.includes(screen.token) || arg.includes(screen.password))));
  });

  it("refuses a screen port that isn't bound to 127.0.0.1", async () => {
    const docker = fakeDocker((args) => (args[0] === "port" ? ok("0.0.0.0:61234") : null), INSTANCE);
    await assert.rejects(computers(docker.runner).ensureRunning(ID), /127\.0\.0\.1/);
  });

  it("builds missing images once before starting", async () => {
    const docker = fakeDocker((args) => (args[0] === "image" ? { code: 1, stdout: Buffer.alloc(0), stderr: "No such image" } : null), INSTANCE);
    await computers(docker.runner).ensureRunning(ID);
    const builds = docker.calls.filter((call) => call.args[0] === "build");
    assert.deepEqual(builds.map((call) => call.args.at(-1)), ["/ctx/netns", "/ctx/computer"]);
  });

  it("stops computers that have been idle too long", async () => {
    let now = 0;
    const docker = fakeDocker(undefined, INSTANCE);
    const machine = computers(docker.runner, () => now);
    await machine.ensureRunning(ID);
    now = 14 * 60_000;
    await machine.stopIdle();
    assert.equal(machine.statusOf(ID).state, "running");
    now = 15 * 60_000;
    await machine.stopIdle();
    assert.equal(machine.statusOf(ID).state, "stopped");
    assert.equal(machine.screen(ID), null);
  });

  it("creates the labelled volume before the computer mounts it", async () => {
    const docker = fakeDocker(undefined, INSTANCE);
    await computers(docker.runner).ensureRunning(ID);
    const volume = indexOfCall(docker.calls, (args) => args[0] === "volume" && args[1] === "create" && args.includes(`hive.instance=${INSTANCE}`));
    const computer = indexOfCall(docker.calls, (args) => args[0] === "run" && args.includes(`hive-${ID}`));
    assert.ok(volume >= 0 && volume < computer);
  });

  it("on startup lists only this Hive's own objects, removes deleted agents' and stops the others", async () => {
    const docker = fakeDocker((args) => {
      if (args[0] === "ps") return ok(`c1\t${ID}\tcomputer\nh1\t${ID}\tnetns\nc2\t${OTHER}\tcomputer\n`);
      if (args[0] === "network") return ok(`n2\t${OTHER}\n`);
      if (args[0] === "volume") return ok(`hive-home-${ID}\t${ID}\nhive-home-${OTHER}\t${OTHER}\n`);
      return null;
    });
    await computers(docker.runner).reconcile(new Set([ID]));
    const listings = docker.calls.filter((call) => call.args.includes("--format"));
    assert.equal(listings.length, 3);
    for (const listing of listings) {
      assert.ok(listing.args.includes("label=hive.agent"));
      assert.ok(listing.args.includes(`label=hive.instance=${INSTANCE}`));
    }
    const flat = docker.calls.filter((call) => !call.args.includes("--format")).map((call) => call.args.join(" "));
    assert.deepEqual(flat, ["stop -t 3 c1", "rm -f h1", "rm -f c2", "network rm n2", `volume rm -f hive-home-${OTHER}`]);
  });

  it("never touches another Hive's computers, even for an agent id it doesn't know", async () => {
    const docker = fakeDocker((args) => {
      const own = args.includes(`label=hive.instance=${INSTANCE}`);
      if (args[0] === "ps") return ok(own ? "" : `f1\t${OTHER}\tcomputer\n`);
      if (args[0] === "network") return ok(own ? "" : `fn\t${OTHER}\n`);
      if (args[0] === "volume") return ok(own ? "" : `hive-home-${OTHER}\t${OTHER}\n`);
      return null;
    });
    await computers(docker.runner).reconcile(new Set());
    assert.deepEqual(docker.calls.filter((call) => !call.args.includes("--format")), []);
  });

  it("refuses an instance id that isn't a UUID", () => {
    assert.throws(() => new Computers(fakeDocker(undefined, INSTANCE).runner, {
      instanceId: "", images, buildContexts: images, idleMs: 1, now: () => 0, onChange: () => undefined,
    }), ComputerError);
  });

  it("removing an agent's computer deletes containers, network and volume", async () => {
    const docker = fakeDocker(undefined, INSTANCE);
    await computers(docker.runner).remove(ID);
    const flat = docker.calls.map((call) => call.args.join(" "));
    assert.ok(flat.includes(`rm -f hive-${ID} hive-netns-${ID}`));
    assert.ok(flat.includes(`network rm hive-net-${ID}`));
    assert.ok(flat.includes(`volume rm -f hive-home-${ID}`));
  });

  it("leaves resources with this computer's names alone when another Hive instance labelled them", async () => {
    const docker = fakeDocker(undefined, OTHER);
    await computers(docker.runner).remove(ID);
    const removals = docker.calls.map((call) => call.args).filter((args) => args[0] === "rm" || args[1] === "rm");
    assert.deepEqual(removals, []);
    assert.equal(docker.calls.filter((call) => call.args[1] === "inspect").length, 4);
  });

  it("doesn't clear another instance's containers before starting, so the start fails on the name instead", async () => {
    const docker = fakeDocker((args) => (args[0] === "run" && args.includes(`hive-netns-${ID}`) ? { code: 125, stdout: Buffer.alloc(0), stderr: "name already in use" } : null), OTHER);
    await assert.rejects(computers(docker.runner).ensureRunning(ID), ComputerError);
    assert.equal(indexOfCall(docker.calls, (args) => args[0] === "rm" && (args.includes(`hive-${ID}`) || args.includes(`hive-netns-${ID}`))), -1);
  });

  for (const kind of ["network", "volume"] as const) {
    it(`won't reuse a ${kind} with this computer's name that another Hive labelled, and leaves it untouched`, async () => {
      const docker = fakeDocker((args) => (args[0] === kind && args[1] === "inspect" ? ok(`${OTHER}\n`) : null), INSTANCE);
      const machine = computers(docker.runner);
      await assert.rejects(machine.ensureRunning(ID), new RegExp(`a Docker ${kind} named hive-(net|home)-${ID} doesn't belong to this Hive`));
      const touched = docker.calls.filter((call) => call.args[0] === kind && call.args[1] !== "inspect");
      assert.deepEqual(touched.filter((call) => call.args.includes(`hive-${kind === "network" ? "net" : "home"}-${ID}`)), []);
      assert.equal(indexOfCall(docker.calls, (args) => args[0] === "run"), -1);
      assert.equal(machine.statusOf(ID).state, "error");
    });
  }

  it("fails the start when the network can't be created and isn't ours", async () => {
    const missing = { code: 1, stdout: Buffer.alloc(0), stderr: "No such network" };
    const docker = fakeDocker((args) => {
      if (args[0] === "network" && args[1] === "inspect") return missing;
      if (args[0] === "network" && args[1] === "create") return { code: 1, stdout: Buffer.alloc(0), stderr: "network create refused" };
      return null;
    }, INSTANCE);
    await assert.rejects(computers(docker.runner).ensureRunning(ID), /network couldn't be prepared: network create refused/);
    assert.equal(indexOfCall(docker.calls, (args) => args[0] === "run"), -1);
  });

  it("stop leaves containers with this computer's names alone when another Hive labelled them", async () => {
    const docker = fakeDocker(undefined, OTHER);
    await computers(docker.runner).stop(ID);
    assert.deepEqual(docker.calls.map((call) => call.args).filter((args) => args[0] === "stop" || args[0] === "rm"), []);
    const own = fakeDocker(undefined, INSTANCE);
    await computers(own.runner).stop(ID);
    assert.deepEqual(own.calls.map((call) => call.args.join(" ")).filter((line) => /^(stop|rm) /.test(line)), [`stop -t 3 hive-${ID}`, `rm -f hive-netns-${ID}`]);
  });
});
