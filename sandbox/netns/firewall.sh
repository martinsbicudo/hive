#!/bin/sh
# Egress policy for one agent's network namespace. Runs in the holder, the only container with NET_ADMIN.
set -eu

resolver=$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf)
gateway=$(ip -4 route show default | awk '{ print $3; exit }')
[ -n "$resolver" ] && [ -n "$gateway" ] || { echo "firewall: missing resolver or gateway" >&2; exit 1; }

nft -f - <<RULES
table inet hive {
  chain output {
    type filter hook output priority 0; policy accept;
    ct state established,related accept
    oifname "lo" accept
    meta nfproto ipv6 drop
    ip daddr $resolver meta l4proto { udp, tcp } th dport 53 accept
    ip daddr $gateway drop
    ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 } drop
  }
}
RULES

nft list table inet hive >/dev/null
echo "firewall: ready (resolver $resolver, gateway $gateway)"
exec sleep infinity
