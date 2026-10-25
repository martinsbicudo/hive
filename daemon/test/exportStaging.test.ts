import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ExportError } from "../src/export.ts";
import { ExportStaging } from "../src/exportStaging.ts";
import type { DockerRunner } from "../src/docker.ts";
import { removeTempDirs, tar, tempDir } from "./fixtures.ts";

const AGENT = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const COMPUTER = "4f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const LEASE = "5f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const context = { computerId: COMPUTER, computerRevision: 3, computerLeaseId: LEASE };
const root = () => join(tempDir("hive-export-stage-"), "private");
after(removeTempDirs);

function tarRunner(contents: string): DockerRunner {
  const archive = tar([{ name: "report.txt", data: contents }]);
  return async () => ({ code: 0, stdout: archive, stderr: "" });
}

describe("staged computer exports", () => {
  it("exports the exact snapshot approved even if the source changes", async () => {
    const stageRoot = root();
    const downloadsRoot = join(tempDir("hive-export-stage-downloads-"), "Hive");
    const staging = new ExportStaging({ stageRoot, downloadsRoot });
    const snapshot = await staging.stage(AGENT, context, "report.txt", tarRunner("approved bytes"), () => true);
    assert.equal(snapshot.sha256.length, 64);
    assert.equal(staging.markAllowed(snapshot, "6f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c"), true);
    const result = await staging.consume(AGENT, context, "report.txt", true);
    assert.equal(readFileSync(result.path, "utf8"), "approved bytes");
    assert.equal(result.bytes, 14);
    assert.deepEqual(readdirSync(stageRoot), []);
  });

  it("refuses stale leases and revokes staged bytes on agent removal", async () => {
    const stageRoot = root();
    const staging = new ExportStaging({ stageRoot });
    const snapshot = await staging.stage(AGENT, context, "report.txt", tarRunner("private"), () => true);
    assert.equal(existsSync(join(stageRoot, `${snapshot.stagedExportId}.blob`)), true);
    staging.revokeAgent(AGENT);
    assert.equal(existsSync(join(stageRoot, `${snapshot.stagedExportId}.blob`)), false);
    await assert.rejects(staging.consume(AGENT, context, "report.txt", false), (error) => error instanceof ExportError && error.reason === "stale");
  });

  it("allows only one concurrent consumer to write an approved snapshot", async () => {
    const stageRoot = root();
    const downloadsRoot = join(tempDir("hive-export-stage-downloads-"), "Hive");
    const staging = new ExportStaging({ stageRoot, downloadsRoot });
    const snapshot = await staging.stage(AGENT, context, "report.txt", tarRunner("one copy"), () => true);
    assert.equal(staging.markAllowed(snapshot, "6f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c"), true);
    const results = await Promise.allSettled([
      staging.consume(AGENT, context, "report.txt", true),
      staging.consume(AGENT, context, "report.txt", true),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(readdirSync(join(downloadsRoot, AGENT)).length, 1);
  });

  it("drops a staged file if the lease ends while Docker is copying it", async () => {
    const stageRoot = root();
    let leaseCurrent = true;
    const gate: { release: (() => void) | null } = { release: null };
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const docker: DockerRunner = async () => {
      markStarted?.();
      await new Promise<void>((resolve) => { gate.release = resolve; });
      return { code: 0, stdout: tar([{ name: "report.txt", data: "private" }]), stderr: "" };
    };
    const staging = new ExportStaging({ stageRoot });
    const pending = staging.stage(AGENT, context, "report.txt", docker, () => leaseCurrent);
    await started;
    leaseCurrent = false;
    gate.release?.();
    await assert.rejects(pending, (error) => error instanceof ExportError && error.reason === "stale");
    assert.deepEqual(readdirSync(stageRoot), []);
  });

  it("reserves quota before reading another file from Docker", async () => {
    const stageRoot = root();
    let reads = 0;
    const gate: { release: (() => void) | null } = { release: null };
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const docker: DockerRunner = async () => {
      reads += 1;
      markStarted?.();
      await new Promise<void>((resolve) => { gate.release = resolve; });
      return { code: 0, stdout: tar([{ name: "small.txt", data: "x" }]), stderr: "" };
    };
    const staging = new ExportStaging({ stageRoot, totalLimitBytes: 150 * 1024 * 1024 });
    const first = staging.stage(AGENT, context, "one.txt", docker, () => true);
    await started;
    const otherContext = { ...context, computerId: "7f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c", computerLeaseId: "8f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c" };
    await assert.rejects(staging.stage(AGENT, otherContext, "two.txt", docker, () => true), (error) => error instanceof ExportError && error.reason === "quota");
    assert.equal(reads, 1);
    gate.release?.();
    await first;
  });
});

