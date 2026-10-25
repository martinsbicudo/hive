import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanDetail, DETAIL_LIMIT } from "../src/engineSetupPins.ts";
import { overallProgress, setupRequestSchema, setupStatusSchema } from "../src/engineSetupStatus.ts";

describe("engine setup status", () => {
  it("weights an install's steps as check .02, download .60, verify .08, install .05, start .10, images .15", () => {
    assert.equal(overallProgress("install", "check", 0), 0);
    assert.ok(Math.abs(overallProgress("install", "download", 0.5) - 0.32) < 1e-9);
    assert.ok(Math.abs(overallProgress("install", "verify", 0) - 0.62) < 1e-9);
    assert.ok(Math.abs(overallProgress("install", "images", 0) - 0.85) < 1e-9);
    assert.equal(overallProgress("install", "ready", 0), 1);
  });

  it("spreads Start over its own steps and clamps odd fractions", () => {
    assert.ok(Math.abs(overallProgress("start", "start", 0) - 0.02 / 0.27) < 1e-9);
    assert.equal(overallProgress("start", "download", 0.5), 0);
    assert.ok(Math.abs(overallProgress("install", "check", 7) - 0.02) < 1e-9);
    assert.equal(overallProgress("install", "check", Number.NaN), 0);
  });

  it("strips ANSI and control characters and bounds the detail", () => {
    assert.equal(cleanDetail("\u001b[31m#5 [2/4] RUN apt\u001b[0m\r\n\u0007done\u2028"), "#5 [2/4] RUN apt done");
    assert.equal(cleanDetail("x".repeat(1000)).length, DETAIL_LIMIT);
  });

  it("is strict: the board mirrors exactly these fields", () => {
    const status = { state: "idle", provider: null, action: null, step: null, progress: 0, detail: "", cancellable: false, providers: [] };
    assert.equal(setupStatusSchema.safeParse(status).success, true);
    assert.equal(setupStatusSchema.safeParse({ ...status, extra: 1 }).success, false);
    assert.equal(setupStatusSchema.safeParse({ ...status, progress: 1.5 }).success, false);
    assert.equal(setupRequestSchema.safeParse({ provider: "orbstack", force: true }).success, false);
  });
});
