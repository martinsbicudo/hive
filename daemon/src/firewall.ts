const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// 0.0.0.0/8 holds OrbStack's path to the Mac (0.250.250.254); nft prints 224.0.0.0/4 + 240.0.0.0/4 merged as 224.0.0.0/3.
export const BLOCKED_RANGES = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3",
] as const;
const DOCKER_RESOLVER = "127.0.0.11";
const PROTOCOL_NUMBERS: Readonly<Record<string, string>> = { tcp: "6", udp: "17" };

export interface FirewallPeers {
  resolver: string;
  gateway: string;
}

function isIpv4(value: string): boolean {
  const parts = IPV4.exec(value)?.slice(1);
  return parts !== undefined && parts.every((part) => Number(part) <= 255 && String(Number(part)) === part);
}

export function resolverFrom(resolvConf: string): string | null {
  const line = resolvConf.split("\n").find((candidate) => candidate.startsWith("nameserver"));
  const address = line?.trim().split(/\s+/)[1];
  return address !== undefined && isIpv4(address) ? address : null;
}

function toNumber(address: string): number {
  return address.split(".").reduce((total, part) => total * 256 + Number(part), 0);
}

function cidr(value: string): { base: number; bits: number } | null {
  const [address, prefix] = value.split("/");
  const bits = Number(prefix);
  if (address === undefined || !isIpv4(address) || !Number.isInteger(bits) || bits < 0 || bits > 32 || String(bits) !== prefix) return null;
  return { base: toNumber(address), bits };
}

function within(address: number, range: { base: number; bits: number }): boolean {
  const size = 2 ** (32 - range.bits);
  return Math.floor(address / size) === Math.floor(range.base / size);
}

export function isBlocked(address: string): boolean {
  return isIpv4(address) && BLOCKED_RANGES.some((range) => {
    const parsed = cidr(range);
    return parsed !== null && within(toNumber(address), parsed);
  });
}

function subnetBlocked(subnet: { base: number; bits: number }): boolean {
  return BLOCKED_RANGES.some((range) => {
    const parsed = cidr(range);
    return parsed !== null && parsed.bits <= subnet.bits && within(subnet.base, parsed);
  });
}

/**
 * The guard's peers, accepted only when its whole routing table is Docker's default plus the link route, the link's
 * subnet lies inside the blocked list, and the resolver is Docker's own or blocked. Anything else keeps the computer off.
 */
export function peersFrom(resolvConf: string, routes: string): FirewallPeers | null {
  const resolver = resolverFrom(resolvConf);
  if (!resolver || (resolver !== DOCKER_RESOLVER && !isBlocked(resolver))) return null;
  const lines = routes.split("\n").map((line) => line.trim()).filter(Boolean);
  const gatewayLine = lines.find((line) => line.startsWith("default "));
  const linkLine = lines.find((line) => !line.startsWith("default "));
  if (lines.length !== 2 || !gatewayLine || !linkLine) return null;
  const route = /^default via (\S+) dev (\S+)(?: proto \S+)?(?: metric \d+)?$/.exec(gatewayLine);
  const link = /^(\S+) dev (\S+) proto kernel scope link src (\S+)$/.exec(linkLine);
  const subnet = link?.[1] ? cidr(link[1]) : null;
  const gateway = route?.[1];
  const source = link?.[3];
  if (!route || !link || !subnet || !gateway || !source || route[2] !== link[2] || !isIpv4(gateway) || !isIpv4(source)) return null;
  if (!subnetBlocked(subnet) || !within(toNumber(gateway), subnet) || !within(toNumber(source), subnet)) return null;
  return { resolver, gateway };
}

function normalizedSet(members: string): string {
  const items = members.split(",").map((item) => item.trim()).map((item) => PROTOCOL_NUMBERS[item] ?? item);
  return `{ ${items.sort().join(", ")} }`;
}

function normalized(line: string): string {
  return line.trim().replace(/\s+/g, " ").replace(/\{ ([^{}]*) \}/g, (_, members: string) => normalizedSet(members));
}

export function expectedRuleset(peers: FirewallPeers): string[] {
  return [
    "table inet hive {",
    "chain output {",
    "type filter hook output priority filter; policy accept;",
    "ct state established,related accept",
    'oifname "lo" accept',
    "meta nfproto ipv6 drop",
    `ip daddr ${peers.resolver} meta l4proto { tcp, udp } th dport 53 accept`,
    `ip daddr ${peers.gateway} drop`,
    `ip daddr { ${BLOCKED_RANGES.join(", ")} } drop`,
    "}",
    "}",
  ].map(normalized);
}

export function firewallIsInPlace(ruleset: string, peers: FirewallPeers): boolean {
  if (!isIpv4(peers.resolver) || !isIpv4(peers.gateway)) return false;
  const lines = ruleset.split("\n").map(normalized).filter(Boolean);
  const expected = expectedRuleset(peers);
  return lines.length === expected.length && lines.every((line, index) => line === expected[index]);
}
