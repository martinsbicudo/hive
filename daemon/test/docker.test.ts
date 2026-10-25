import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dockerArgsForEndpoint, dockerOperationEnv } from "../src/docker.ts";

describe("pinned Docker endpoint arguments", () => {
  it("uses the attested socket of Docker Desktop or OrbStack for every operation", () => {
    for (const endpoint of ["unix:///Users/alice/.docker/run/docker.sock", "unix:///Users/alice/.orbstack/run/docker.sock"]) {
      assert.deepEqual(dockerArgsForEndpoint(endpoint, ["ps", "-a"], "/Users/alice"), ["--host", endpoint, "ps", "-a"]);
    }
  });

  it("refuses remote, unresolved and other users' endpoints", () => {
    for (const endpoint of ["tcp://host:2376", "ssh://user@host", "unix:///tmp/docker.sock", "unix:///var/run/docker.sock", "unix:///Users/bob/.orbstack/run/docker.sock"]) {
      assert.throws(() => dockerArgsForEndpoint(endpoint, ["ps"], "/Users/alice"), /supported local socket/);
    }
  });

  it("removes environment overrides from pinned engine operations", () => {
    const env = dockerOperationEnv({
      PATH: "/bin", DOCKER_HOST: "tcp://remote:2376", DOCKER_CONTEXT: "remote", DOCKER_TLS: "1",
      DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "/tmp/certs", DOCKER_API_VERSION: "1.2", DOCKER_CONFIG: "/tmp/config",
    });
    for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_API_VERSION"]) assert.equal(env[name], undefined);
    assert.equal(env.DOCKER_CONFIG, "/tmp/config");
    assert.equal(env.PATH, "/bin");
  });
});
