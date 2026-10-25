#!/usr/bin/env bash
# End-to-end isolation check for virtual computers: starts a scratch daemon, two virtual agents and probes them.
# Needs Docker Desktop or OrbStack as the selected Docker context, and a logged-in Claude Code. Leaves the hive/* images in place.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${E2E_PORT:-47480}"
SCRATCH="$(mktemp -d)"
DAEMON_PID=""
FAILED=0

cleanup() {
  [[ -n "$DAEMON_PID" ]] && kill "$DAEMON_PID" 2>/dev/null && wait "$DAEMON_PID" 2>/dev/null
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
refuse() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$name"; else pass "$name"; fi; }

api() {
  local method="$1" path="$2" body="${3:-}"
  curl -sf -X "$method" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    ${body:+-d "$body"} "http://127.0.0.1:$PORT$path"
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
in_box() { local id="$1"; shift; docker exec -u agent "hive-$id" "$@"; }
tcp_open() { in_box "$1" timeout 4 bash -c "exec 3<>/dev/tcp/$2/$3"; }
udp_answers() { in_box "$1" timeout 4 python3 -c "
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
s.sendto(bytes.fromhex('abcd01000001000000000000076578616d706c6503636f6d0000010001'), ('$2', 53))
sys.exit(0 if s.recv(512) else 1)"; }

PROVIDER="$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || true)"
case "$PROVIDER" in
  OrbStack) PROVIDER=orbstack ;;
  "Docker Desktop") PROVIDER=docker-desktop ;;
  *) echo "e2e-computer: the selected Docker context is neither Docker Desktop nor OrbStack ($PROVIDER)"; exit 1 ;;
esac
echo "Engine: $PROVIDER ($(docker context show))"

wait_running() {
  local id="$1"
  for _ in $(seq 1 360); do
    local state
    state="$(api GET "/api/agents/$id/computer" | json "d['state']")"
    [[ "$state" == running ]] && return 0
    [[ "$state" == error ]] && { api GET "/api/agents/$id/computer"; echo; return 1; }
    sleep 2
  done
  return 1
}

echo "Starting a scratch daemon on port $PORT"
HIVE_HOME="$SCRATCH" HIVE_PORT="$PORT" node "$ROOT/daemon/src/main.ts" >"$SCRATCH/daemon.out" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 50); do [[ -s "$SCRATCH/token" ]] && break; sleep 0.2; done
TOKEN="$(cat "$SCRATCH/token")"
# The daemon writes its token before it listens; start-up checks every engine first, which takes a few seconds.
for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.2; done

A="$(api POST /api/agents '{"name":"Ana","role":"Tester","engine":"claude-code","model":"haiku","computer":"virtual"}' | json "d['id']")"
B="$(api POST /api/agents '{"name":"Bob","role":"Tester","engine":"claude-code","model":"haiku","computer":"virtual"}' | json "d['id']")"
api POST "/api/agents/$A/computer/start" >/dev/null
api POST "/api/agents/$B/computer/start" >/dev/null
echo "Waiting for both computers (the first build takes a few minutes)"
wait_running "$A"
wait_running "$B"

echo "Guard and screen"
check "the guard's firewall table exists" docker exec "hive-netns-$A" nft list table inet hive
holder_started="$(docker inspect -f '{{.State.StartedAt}}' "hive-netns-$A")"
box_started="$(docker inspect -f '{{.State.StartedAt}}' "hive-$A")"
check "the guard started before the computer" test "$holder_started" \< "$box_started"
published="$(docker port "hive-netns-$A" 6080)"
check "the screen is published on 127.0.0.1 only" bash -c "! grep -qv '^127\.0\.0\.1:' <<<'$published'"
A_SCREEN_PORT="$(api GET "/api/agents/$A/computer/screen" | json "d['port']")"
no_token="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "http://127.0.0.1:$A_SCREEN_PORT/websockify" || true)"
check "websockify refuses a connection without the token" test "$no_token" != 101
A_SCREEN_TOKEN="$(api GET "/api/agents/$A/computer/screen" | json "d['token']")"
refuse "/api/state holds no screen secret" grep -q "$A_SCREEN_TOKEN" <<<"$(api GET /api/state)"

echo "Inside Ana's computer"
check "it runs Linux" bash -c "docker exec -u agent hive-$A uname -s | grep -qx Linux"
check "DNS works" in_box "$A" getent hosts example.com
check "the web works" in_box "$A" curl -sfI --max-time 10 https://example.com
GATEWAY="$(in_box "$A" python3 -c "
import socket, struct
for line in open('/proc/net/route').read().splitlines()[1:]:
    f = line.split()
    if f[1] == '00000000': print(socket.inet_ntoa(struct.pack('<L', int(f[2], 16))))")"
check "the TCP probe reaches the open web (control)" tcp_open "$A" example.com 443
refuse "the gateway ($GATEWAY:80) is blocked" tcp_open "$A" "$GATEWAY" 80
refuse "the Mac's Hive port through the gateway is blocked" tcp_open "$A" "$GATEWAY" 47321
refuse "host.docker.internal:47321 is blocked" tcp_open "$A" host.docker.internal 47321
refuse "the cloud metadata address is blocked" tcp_open "$A" 169.254.169.254 80
LAN_IP="$(ipconfig getifaddr en0 || ipconfig getifaddr en1 || true)"
[[ -n "$LAN_IP" ]] && refuse "the Mac's LAN address ($LAN_IP:47321) is blocked" tcp_open "$A" "$LAN_IP" 47321
if [[ "$PROVIDER" == docker-desktop ]]; then
  refuse "192.168.65.254 is blocked" tcp_open "$A" 192.168.65.254 80
  refuse "Docker's API at 192.168.65.7:2375 is blocked" tcp_open "$A" 192.168.65.7 2375
else
  for port in 22 5000 7000 47321; do refuse "OrbStack's path to the Mac (0.250.250.254:$port) is blocked" tcp_open "$A" 0.250.250.254 "$port"; done
  for name in host.internal host.orb.internal docker.orb.internal; do refuse "$name:47321 is blocked" tcp_open "$A" "$name" 47321; done
  refuse "198.19.249.1 is blocked" tcp_open "$A" 198.19.249.1 80
  refuse "UDP to OrbStack's resolver 0.250.250.200 is blocked" udp_answers "$A" 0.250.250.200
  refuse "UDP to 0.250.250.254 is blocked" udp_answers "$A" 0.250.250.254
fi
refuse "UDP to the gateway is blocked" udp_answers "$A" "$GATEWAY"
refuse "IPv6 to OrbStack's host range is blocked" in_box "$A" timeout 4 bash -c "exec 3<>/dev/tcp/fd07:b51a:cc66::fe/47321"
B_SCREEN_PORT="$(api GET "/api/agents/$B/computer/screen" | json "d['port']")"
refuse "Bob's screen port is unreachable from Ana" tcp_open "$A" host.docker.internal "$B_SCREEN_PORT"
refuse "Ana can't change the firewall" in_box "$A" nft flush ruleset
refuse "Ana can't read the screen secrets" in_box "$A" cat /run/vnc/tokens
check "PID 1 has no secret in its environment" bash -c \
  "! docker exec -u agent hive-$A cat /proc/1/environ | tr '\0' '\n' | grep -qiE 'token|secret|password|key='"

echo "A real run"
api POST "/api/agents/$A/messages" '{"text":"Run uname -a on your computer and tell me the result."}' >/dev/null
for _ in $(seq 1 60); do
  sleep 3
  status="$(api GET /api/state | json "[a['status'] for a in d['agents'] if a['id']=='$A'][0]")"
  [[ "$status" == sleeping || "$status" == error ]] && break
done
messages="$(api GET "/api/agents/$A/messages")"
check "the agent used computer_run" grep -q "computer_run" <<<"$messages"
check "the reply mentions Linux" grep -q "Linux" <<<"$messages"
refuse "the init guard didn't stop the run" grep -q "Hive stopped this run" <<<"$messages"

echo "Deleting both agents"
api DELETE "/api/agents/$A" >/dev/null
api DELETE "/api/agents/$B" >/dev/null
sleep 5
for id in "$A" "$B"; do
  check "no containers left for $id" test -z "$(docker ps -aq --filter "label=hive.agent=$id")"
  check "no network left for $id" test -z "$(docker network ls -q --filter "label=hive.agent=$id")"
  check "no volume left for $id" test -z "$(docker volume ls -q --filter "name=hive-home-$id")"
done

if [[ "$FAILED" -ne 0 ]]; then echo "e2e-computer: FAILED"; exit 1; fi
echo "e2e-computer: all checks passed"
