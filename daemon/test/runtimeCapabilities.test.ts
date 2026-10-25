import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EngineVerdict } from "../src/engineAttest.ts";
import {
  COMPUTER_PROFILE_INFO,
  RUNTIME_INSTALL_GUIDES,
  computerProfileSchema,
  computerRuntimeSchema,
  discoverComputerRuntimes,
  runtimeCapabilitySchema,
  runtimeGuidesForHost,
} from "../src/runtimeCapabilities.ts";

const discover = (verdict: EngineVerdict) => discoverComputerRuntimes({ active: async () => verdict });

describe("runtime capability discovery", () => {
  it("reports a missing engine when neither Docker Desktop nor OrbStack is installed", async () => {
    const [result] = await discover({ status: "missing", provider: "Docker-compatible engine", detail: "Docker Desktop or OrbStack isn't installed.", version: null });
    assert.equal(result?.status, "missing");
    assert.deepEqual(result?.capabilities, { profiles: [], persistentHome: false, networkGuard: "not-supported" });
  });

  it("marks a verified OrbStack ready with every profile and an attested network guard", async () => {
    const [result] = await discover({ status: "ready", engine: { provider: "orbstack", name: "OrbStack", endpoint: "unix:///Users/a/.orbstack/run/docker.sock", version: "2.2.5" } });
    assert.equal(result?.provider, "OrbStack");
    assert.equal(result?.version, "2.2.5");
    assert.equal(result?.status, "ready");
    assert.deepEqual(result?.capabilities, { profiles: ["terminal", "browser", "desktop"], persistentHome: true, networkGuard: "attested" });
  });

  it("passes a stopped or unsupported engine's reason through without enabling any profile", async () => {
    for (const status of ["stopped", "unsupported"] as const) {
      const [result] = await discover({ status, provider: "Docker Desktop", detail: "Docker Desktop 4.44.3 or newer is required.", version: "4.40.0" });
      assert.equal(result?.status, status);
      assert.equal(result?.detail, "Docker Desktop 4.44.3 or newer is required.");
      assert.deepEqual(result?.capabilities, { profiles: [], persistentHome: true, networkGuard: "not-attested" });
    }
  });

  it("strictly validates runtime/profile schemas and offers OrbStack and Docker Desktop on macOS only", () => {
    assert.equal(computerRuntimeSchema.safeParse("docker").success, true);
    assert.equal(computerRuntimeSchema.safeParse("apple-container").success, false);
    assert.equal(computerProfileSchema.safeParse("desktop").success, true);
    assert.equal(computerProfileSchema.safeParse("unknown").success, false);
    assert.equal(runtimeCapabilitySchema.safeParse({ runtime: "docker", extra: true }).success, false);
    assert.equal(COMPUTER_PROFILE_INFO.length, 3);
    assert.deepEqual(RUNTIME_INSTALL_GUIDES.map((guide) => [guide.provider, guide.maturity]), [["OrbStack", "supported"], ["Docker Desktop", "supported"]]);
    assert.equal(runtimeGuidesForHost("darwin").length, 2);
    assert.deepEqual(runtimeGuidesForHost("linux"), []);
  });
});
