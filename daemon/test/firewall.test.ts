import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { firewallIsInPlace, isBlocked, peersFrom, resolverFrom } from "../src/firewall.ts";
import { GATEWAY, RESOLVER, ROUTES, RULESET } from "./fixtures.ts";

const peers = { resolver: RESOLVER, gateway: GATEWAY };
const DNS = "ip daddr 127.0.0.11 meta l4proto { 6, 17 } th dport 53 accept";
const PRIVATE = "ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 } drop";
const RESOLV = "nameserver 127.0.0.11\n";
// As OrbStack 2.2.5 printed it for a Hive-style user network (docs/PLAN.md, Engines).
const ORB_ROUTES = "default via 192.168.97.1 dev eth0 \n192.168.97.0/24 dev eth0 proto kernel scope link src 192.168.97.2 \n";

describe("firewall peers", () => {
  it("reads the resolver and gateway the way the guard's script does", () => {
    assert.equal(resolverFrom("# comment\nnameserver 127.0.0.11\nnameserver 1.1.1.1\n"), "127.0.0.11");
    assert.equal(resolverFrom("nameserver ::1\n"), null);
    assert.equal(resolverFrom(""), null);
  });

  it("accepts Docker's default and link routes on Docker Desktop and OrbStack", () => {
    assert.deepEqual(peersFrom(RESOLV, ROUTES), peers);
    assert.deepEqual(peersFrom(RESOLV, ORB_ROUTES), { resolver: RESOLVER, gateway: "192.168.97.1" });
  });

  it("keeps the computer off when the guard's subnet is outside the blocked list", () => {
    assert.equal(peersFrom(RESOLV, "default via 203.0.113.1 dev eth0 \n203.0.113.0/24 dev eth0 proto kernel scope link src 203.0.113.2 \n"), null);
    assert.equal(peersFrom(RESOLV, "default via 172.30.0.1 dev eth0 \n172.0.0.0/8 dev eth0 proto kernel scope link src 172.30.0.2 \n"), null);
  });

  it("keeps the computer off when the guard has an extra route or an odd default", () => {
    assert.equal(peersFrom(RESOLV, `${ROUTES}10.9.0.0/16 via 172.30.0.1 dev eth0 \n`), null);
    assert.equal(peersFrom(RESOLV, "172.30.0.0/16 dev eth0 proto kernel scope link src 172.30.0.2 \n"), null);
    assert.equal(peersFrom(RESOLV, "default via 172.31.0.1 dev eth0 \n172.30.0.0/16 dev eth0 proto kernel scope link src 172.30.0.2 \n"), null);
    assert.equal(peersFrom(RESOLV, "default via 172.30.0.1 dev eth1 \n172.30.0.0/16 dev eth0 proto kernel scope link src 172.30.0.2 \n"), null);
    assert.equal(peersFrom(RESOLV, "default via 300.1.1.1 dev eth0\n172.30.0.0/16 dev eth0 proto kernel scope link src 172.30.0.2"), null);
    assert.equal(peersFrom(RESOLV, ""), null);
  });

  it("keeps the computer off when the resolver is neither Docker's own nor inside the blocked list", () => {
    assert.equal(peersFrom("nameserver 8.8.8.8\n", ROUTES), null);
    assert.deepEqual(peersFrom("nameserver 0.250.250.200\n", ROUTES), { resolver: "0.250.250.200", gateway: GATEWAY });
    assert.equal(peersFrom("", ROUTES), null);
  });

  it("blocks OrbStack's way to the Mac, the private and special ranges, and nothing public", () => {
    for (const address of ["0.250.250.254", "10.1.2.3", "100.64.0.1", "169.254.169.254", "172.31.255.255", "192.168.1.10", "198.19.249.1", "224.0.0.251", "255.255.255.255"]) {
      assert.equal(isBlocked(address), true, address);
    }
    for (const address of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "198.20.0.1", "223.255.255.255", "not an ip"]) assert.equal(isBlocked(address), false, address);
  });
});

describe("firewall check", () => {
  it("accepts the ruleset exactly as nft prints it for this resolver and gateway", () => {
    assert.ok(firewallIsInPlace(RULESET, peers));
    assert.ok(firewallIsInPlace(RULESET.replace("{ 6, 17 }", "{ tcp, udp }"), peers));
  });

  it("rejects a DNS allow without a destination or with the wrong one", () => {
    assert.ok(!firewallIsInPlace(RULESET.replace(DNS, "meta l4proto { 6, 17 } th dport 53 accept"), peers));
    assert.ok(!firewallIsInPlace(RULESET.replace(DNS, DNS.replace("127.0.0.11", "8.8.8.8")), peers));
    assert.ok(!firewallIsInPlace(RULESET, { ...peers, resolver: "8.8.8.8" }));
    assert.ok(!firewallIsInPlace(RULESET.replace(DNS, DNS.replace("{ 6, 17 }", "{ 6, 17, 132 }")), peers));
  });

  it("rejects the wrong gateway", () => {
    assert.ok(!firewallIsInPlace(RULESET.replace("ip daddr 172.30.0.1 drop", "ip daddr 172.30.0.2 drop"), peers));
    assert.ok(!firewallIsInPlace(RULESET, { ...peers, gateway: "172.31.0.1" }));
  });

  it("rejects a private-range set with an entry missing, changed or added", () => {
    for (const changed of [
      RULESET.replace(", 224.0.0.0/3 }", " }"),
      RULESET.replace("{ 0.0.0.0/8, ", "{ "),
      RULESET.replace("10.0.0.0/8, ", "10.0.0.0/9, "),
      RULESET.replace("224.0.0.0/3 }", "224.0.0.0/3, 203.0.113.0/24 }"),
    ]) {
      assert.notEqual(changed, RULESET);
      assert.ok(!firewallIsInPlace(changed, peers));
    }
  });

  it("rejects any extra rule, a reordered rule or a missing rule", () => {
    assert.ok(!firewallIsInPlace(RULESET.replace(PRIVATE, `${PRIVATE}\n\t\tip daddr 10.1.2.3 accept`), peers));
    assert.ok(!firewallIsInPlace(RULESET.replace("\t\tct state established,related accept", "\t\tip daddr 10.0.0.1 accept\n\t\tct state established,related accept"), peers));
    assert.ok(!firewallIsInPlace(RULESET.replace(`${DNS}\n\t\tip daddr 172.30.0.1 drop`, `ip daddr 172.30.0.1 drop\n\t\t${DNS}`), peers));
    assert.ok(!firewallIsInPlace(RULESET.replace("\t\tmeta nfproto ipv6 drop\n", ""), peers));
    assert.ok(!firewallIsInPlace(RULESET.replace("\t}\n}", "\t}\n\tchain other {\n\t}\n}"), peers));
    assert.ok(!firewallIsInPlace("", peers));
  });

  it("rejects a drop policy or another hook", () => {
    assert.ok(!firewallIsInPlace(RULESET.replace("policy accept;", "policy drop;"), peers));
    assert.ok(!firewallIsInPlace(RULESET.replace("hook output", "hook input"), peers));
  });
});
