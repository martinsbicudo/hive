import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { dockerRunner, type CommandResult, type DockerRunner, type RunOptions } from "../src/docker.ts";
import { containerPath, ExportError, sanitizedName, type ExportFailure, type ExportResult } from "../src/export.ts";
import { ExportStaging, type GuestExec } from "../src/exportStaging.ts";
import { pax, removeTempDirs, tar, tempDir } from "./fixtures.ts";

after(removeTempDirs);

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const CONTEXT = { computerId: "4f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c", computerRevision: 1, computerLeaseId: "5f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c" };
const APPROVAL = "6f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";

async function exportFile(agentId: string, path: string, exec: GuestExec, options: { downloadsRoot?: string; maxFileBytes?: number } = {}): Promise<ExportResult> {
  const stageRoot = join(tempDir("hive-export-stage-"), "private");
  const staging = new ExportStaging({ stageRoot, downloadsRoot: options.downloadsRoot, fileLimitBytes: options.maxFileBytes });
  const snapshot = await staging.stage(agentId, CONTEXT, path, exec, () => true);
  assert.equal(staging.markAllowed(snapshot, APPROVAL), true);
  return staging.consume(agentId, CONTEXT, path, true);
}

function fakeTar(stdout: Buffer, extra: Partial<CommandResult> = {}) {
  const calls: { args: readonly string[]; options: RunOptions }[] = [];
  const runner: DockerRunner = async (args, options = {}) => {
    calls.push({ args, options });
    return { code: 0, stdout, stderr: "", ...extra };
  };
  return { calls, runner };
}

function tempRoot(): string {
  return join(tempDir("hive-export-"), "Hive");
}

async function rejectsWith(promise: Promise<unknown>, reason: ExportFailure): Promise<void> {
  await assert.rejects(promise, (error) => error instanceof ExportError && error.reason === reason);
}

describe("container path validation", () => {
  it("resolves relative paths against the workspace and keeps absolute ones under /home/agent", () => {
    assert.equal(containerPath("out/report.pdf"), "/home/agent/workspace/out/report.pdf");
    assert.equal(containerPath("/home/agent/notes.txt"), "/home/agent/notes.txt");
    assert.equal(containerPath("../notes.txt"), "/home/agent/notes.txt");
  });

  for (const bad of ["", "../../etc/passwd", "/etc/passwd", "/home/agent", "/home/agentx/a", "/home/agent/../../etc/shadow", "a\nb", "a\u0000b", "dir/"]) {
    it(`rejects ${JSON.stringify(bad)} before docker runs`, async () => {
      const docker = fakeTar(tar([{ name: "a.txt", data: "x" }]));
      await rejectsWith(exportFile(ID, bad, docker.runner, { downloadsRoot: tempRoot() }), "invalid-path");
      assert.equal(docker.calls.length, 0);
    });
  }

  it("rejects agent ids that aren't UUIDs before docker runs", async () => {
    const docker = fakeTar(tar([{ name: "a.txt", data: "x" }]));
    await rejectsWith(exportFile("x; rm -rf /", "a.txt", docker.runner, { downloadsRoot: tempRoot() }), "invalid-path");
    assert.equal(docker.calls.length, 0);
  });
});

describe("computer_export", () => {
  it("copies one regular file out with mode 0644 and the quarantine flag", async () => {
    const root = tempRoot();
    const docker = fakeTar(tar([{ name: "report.sh", data: "#!/bin/sh\necho hi\n", mode: 0o755 }]));
    const result = await exportFile(ID, "report.sh", docker.runner, { downloadsRoot: root });
    assert.deepEqual(docker.calls[0]?.args, ["/bin/tar", "-cf", "-", "-C", "/home/agent/workspace", "--", "report.sh"]);
    assert.equal(docker.calls[0]?.options.maxStdoutBytes, 100 * 1024 * 1024 + 1024 * 1024);
    assert.equal(result.path, join(root, ID, "report.sh"));
    assert.equal(result.bytes, 18);
    assert.equal(readFileSync(result.path, "utf8"), "#!/bin/sh\necho hi\n");
    assert.equal(lstatSync(result.path).mode & 0o7777, 0o644);
    assert.equal(lstatSync(join(root, ID)).mode & 0o777, 0o755);
    if (process.platform === "darwin") {
      const flag = execFileSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", result.path], { encoding: "utf8" }).trim();
      assert.match(flag, /^0081;[0-9a-f]+;Hive;$/);
    }
  });

  it("rejects a symlink entry", async () => {
    const docker = fakeTar(tar([{ name: "link", type: "2", linkname: "/etc/passwd" }]));
    await rejectsWith(exportFile(ID, "link", docker.runner, { downloadsRoot: tempRoot() }), "not-a-file");
  });

  it("rejects a hardlink entry", async () => {
    const docker = fakeTar(tar([{ name: "hard", type: "1", linkname: "a.txt" }]));
    await rejectsWith(exportFile(ID, "hard", docker.runner, { downloadsRoot: tempRoot() }), "not-a-file");
  });

  it("rejects a folder", async () => {
    const docker = fakeTar(tar([{ name: "d/", type: "5", mode: 0o755 }]));
    await rejectsWith(exportFile(ID, "d", docker.runner, { downloadsRoot: tempRoot() }), "not-a-file");
  });

  it("rejects a folder whose only content is one file", async () => {
    const docker = fakeTar(tar([{ name: "d/", type: "5" }, { name: "d/a.txt", data: "x" }]));
    await rejectsWith(exportFile(ID, "d", docker.runner, { downloadsRoot: tempRoot() }), "not-a-file");
  });

  it("rejects two files", async () => {
    const root = tempRoot();
    const docker = fakeTar(tar([{ name: "a.txt", data: "a" }, { name: "b.txt", data: "b" }]));
    await rejectsWith(exportFile(ID, "a.txt", docker.runner, { downloadsRoot: root }), "not-a-file");
    assert.equal(existsSync(join(root, ID)), false);
  });

  it("rejects a bad checksum", async () => {
    const archive = tar([{ name: "a.txt", data: "hello" }]);
    archive[0] = "b".charCodeAt(0);
    await rejectsWith(exportFile(ID, "a.txt", fakeTar(archive).runner, { downloadsRoot: tempRoot() }), "not-a-file");
  });

  it("rejects truncated archives", async () => {
    const archive = tar([{ name: "a.txt", data: Buffer.alloc(2000, 1) }]);
    for (const length of [300, 512 + 1000, 512 + 2048]) {
      await rejectsWith(exportFile(ID, "a.txt", fakeTar(archive.subarray(0, length)).runner, { downloadsRoot: tempRoot() }), "not-a-file");
    }
  });

  it("rejects a file whose header size is beyond the cap and leaves nothing behind", async () => {
    const root = tempRoot();
    const docker = fakeTar(tar([{ name: "big.bin", data: Buffer.alloc(4096, 7) }]));
    await rejectsWith(exportFile(ID, "big.bin", docker.runner, { downloadsRoot: root, maxFileBytes: 1024 }), "too-large");
    assert.equal(existsSync(join(root, ID)), false);
  });

  it("rejects a pax size beyond the cap", async () => {
    const docker = fakeTar(tar([pax({ size: "99999999999" }), { name: "a.txt", data: "x", size: 1 }]));
    await rejectsWith(exportFile(ID, "a.txt", docker.runner, { downloadsRoot: tempRoot(), maxFileBytes: 1024 }), "too-large");
  });

  it("reports an overflowing stream as too large", async () => {
    const root = tempRoot();
    const docker = fakeTar(Buffer.alloc(512), { code: -1, overflowed: true });
    await rejectsWith(exportFile(ID, "a.txt", docker.runner, { downloadsRoot: root }), "too-large");
    assert.equal(existsSync(join(root, ID)), false);
  });

  it("reads as the agent user without following a symlink, so a swapped parent only reaches what the agent can read", async () => {
    const docker = fakeTar(tar([{ name: "a.txt", data: "x" }]));
    await exportFile(ID, "/home/agent/out/../workspace/a.txt", docker.runner, { downloadsRoot: tempRoot() });
    const args = docker.calls[0]?.args ?? [];
    assert.equal(args[0], "/bin/tar");
    assert.ok(!args.includes("cp"));
    assert.ok(!args.some((arg) => arg === "-h" || arg === "--dereference" || arg.startsWith("--hard-dereference")));
    assert.deepEqual(args.slice(-4), ["-C", "/home/agent/workspace", "--", "a.txt"]);
  });

  it("reports a failed copy inside the computer", async () => {
    const docker = fakeTar(Buffer.alloc(0), { code: 2, stderr: "/bin/tar: secret: Cannot open: Permission denied" });
    await rejectsWith(exportFile(ID, "a.txt", docker.runner, { downloadsRoot: tempRoot() }), "docker");
  });

  it("adds (2) on a name collision and never follows a planted symlink", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ID), { recursive: true });
    writeFileSync(join(root, ID, "a.txt"), "old");
    const target = join(root, "..", "target.txt");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(root, ID, "a (2).txt"));
    const result = await exportFile(ID, "a.txt", fakeTar(tar([{ name: "a.txt", data: "new" }])).runner, { downloadsRoot: root });
    assert.equal(result.path, join(root, ID, "a (3).txt"));
    assert.equal(readFileSync(join(root, ID, "a.txt"), "utf8"), "old");
    assert.equal(readFileSync(target, "utf8"), "untouched");
    assert.equal(readFileSync(result.path, "utf8"), "new");
  });

  it("refuses when the agent folder is a symlink", async () => {
    const root = tempRoot();
    const elsewhere = join(root, "..", "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(root);
    symlinkSync(elsewhere, join(root, ID));
    await rejectsWith(exportFile(ID, "a.txt", fakeTar(tar([{ name: "a.txt", data: "x" }])).runner, { downloadsRoot: root }), "destination");
    assert.deepEqual(readdirSync(elsewhere), []);
  });

  it("refuses when the Hive folder is a symlink", async () => {
    const root = tempRoot();
    const elsewhere = join(root, "..", "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, root);
    await rejectsWith(exportFile(ID, "a.txt", fakeTar(tar([{ name: "a.txt", data: "x" }])).runner, { downloadsRoot: root }), "destination");
    assert.deepEqual(readdirSync(elsewhere), []);
  });

  it("honors the pax path and size", async () => {
    const root = tempRoot();
    const long = `${"n".repeat(150)}-ñame.txt`;
    const docker = fakeTar(tar([pax({ path: long, size: "5", mtime: "1.5" }), { name: "PaxHeaders-truncated", data: "hello", size: 0 }]));
    const result = await exportFile(ID, long, docker.runner, { downloadsRoot: root });
    assert.equal(result.bytes, 5);
    assert.equal(result.path, join(root, ID, long.slice(0, 120)));
    assert.equal(readFileSync(result.path, "utf8"), "hello");
  });

  it("honors a GNU long name", async () => {
    const docker = fakeTar(tar([{ name: "././@LongLink", type: "L", data: "dir/long-name.txt\0" }, { name: "long-na", data: "x" }]));
    const result = await exportFile(ID, "dir/long-name.txt", docker.runner, { downloadsRoot: tempRoot() });
    assert.match(result.path, /\/long-name\.txt$/);
  });

  it("rejects a global pax header", async () => {
    const docker = fakeTar(tar([{ ...pax({ path: "x" }), type: "g" }, { name: "a.txt", data: "x" }]));
    await rejectsWith(exportFile(ID, "a.txt", docker.runner, { downloadsRoot: tempRoot() }), "not-a-file");
  });

  it("sanitizes the file name", async () => {
    const result = await exportFile(ID, "..hidden", fakeTar(tar([{ name: "..hidden", data: "x" }])).runner, { downloadsRoot: tempRoot() });
    assert.match(result.path, /\/hidden$/);
    assert.equal(sanitizedName("a\u0007b\nc‮txt.exe"), "abctxt.exe");
    assert.equal(sanitizedName("x/y/  we  ird:\tname.txt "), "we irdname.txt");
    assert.equal(sanitizedName(".."), "export");
    assert.equal(sanitizedName("--help.txt"), "help.txt");
    assert.equal(sanitizedName(" -.-rf"), "rf");
    assert.equal(sanitizedName("-"), "export");
    assert.equal(sanitizedName("a-b.txt"), "a-b.txt");
    assert.equal(sanitizedName("\u0001"), "export");
    assert.equal(Array.from(sanitizedName("é".repeat(300))).length, 100);
  });
});

describe("docker runner output cap", () => {
  it("kills a child that streams past the cap and reports the overflow", async () => {
    const result = await dockerRunner("/usr/bin/yes")([], { maxStdoutBytes: 64 * 1024, timeoutMs: 10_000 });
    assert.equal(result.overflowed, true);
    assert.ok(result.stdout.length <= 64 * 1024);
  });

  it("keeps full output when the cap is not passed", async () => {
    const result = await dockerRunner("/bin/cat")([], { input: Buffer.alloc(200_000, 0x61) });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, 200_000);
    assert.equal(result.overflowed, undefined);
  });
});
