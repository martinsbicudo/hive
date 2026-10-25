#!/usr/bin/env bash
# End-to-end check for wakes, budgets and the kill switch with real Claude Code (haiku) on a scratch daemon.
# Needs a logged-in Claude Code. Costs a few cents.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${E2E_PORT:-47492}"
SCRATCH="$(mktemp -d)"
DAEMON_PID=""
FAILED=0

cleanup() {
  [[ -n "$DAEMON_PID" ]] && kill "$DAEMON_PID" 2>/dev/null && wait "$DAEMON_PID" 2>/dev/null
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
trap 'echo "e2e-step4: stopped at line $LINENO"; FAILED=1' ERR

pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }

api() {
  local method="$1" path="$2" body="${3:-}"
  curl -sf -X "$method" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    ${body:+-d "$body"} "http://127.0.0.1:$PORT$path"
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

wait_idle() {
  local idle=0
  for _ in $(seq 1 100); do
    sleep 3
    local busy
    busy="$(api GET /api/state | json "len([a for a in d['agents'] if a['status'] in ('working','waiting-approval')])")"
    if [[ "$busy" == 0 ]]; then idle=$((idle + 1)); else idle=0; fi
    [[ "$idle" -ge 2 ]] && return 0
  done
  return 1
}

wait_for() {
  for _ in $(seq 1 60); do
    if [[ "$(api GET /api/state | json "$1")" == "True" ]]; then return 0; fi
    sleep 2
  done
  return 1
}

start_daemon() {
  HIVE_HOME="$SCRATCH" HIVE_PORT="$PORT" node "$ROOT/daemon/src/main.ts" >>"$SCRATCH/daemon.out" 2>&1 &
  DAEMON_PID=$!
  for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.2; done
  TOKEN="$(cat "$SCRATCH/token")"
}

stop_daemon() {
  kill "$DAEMON_PID"; wait "$DAEMON_PID" 2>/dev/null || true
  DAEMON_PID=""
}

messages() { api GET "/api/agents/$ANA/messages" | json "'\n'.join(m['role']+' | '+m['text'] for m in d)"; }
assistant_count() { api GET "/api/agents/$ANA/messages" | json "len([m for m in d if m['role']=='assistant'])"; }

echo "Starting a scratch daemon on port $PORT"
start_daemon
ANA="$(api POST /api/agents '{"name":"Ana","role":"Tester","engine":"claude-code","model":"haiku","useMySetup":false}' | json "d['id']")"

echo "Wake: an interval slot that came due while Hive was off runs once at startup"
SCHEDULE="$(api POST "/api/agents/$ANA/schedules" '{"kind":"interval","everyMinutes":15,"prompt":"Reply with exactly: WAKE-OK"}' | json "d['id']")"
stop_daemon
python3 - "$SCRATCH/hive.db" "$SCHEDULE" <<'EOF'
import sqlite3, sys
from datetime import datetime, timedelta, timezone
created = (datetime.now(timezone.utc) - timedelta(minutes=16)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
db = sqlite3.connect(sys.argv[1])
db.execute("UPDATE schedules SET created_at = ?, last_fired_at = NULL WHERE id = ?", (created, sys.argv[2]))
db.commit()
EOF
start_daemon
wait_idle
M="$(messages)"
echo "$M" | sed 's/^/        /'
check "the wake prompt reached Ana's chat" grep -q "^user | Scheduled wake: Reply with exactly: WAKE-OK" <<<"$M"
check "Ana answered the wake" grep -q "^assistant | .*WAKE-OK" <<<"$M"
check "the schedule recorded the slot" test "$(api GET "/api/agents/$ANA/schedules" | json "d[0]['lastFiredAt'] is not None")" == True
check "Ana shows a next wake" test "$(api GET /api/state | json "d['agents'][0]['nextWake'] is not None")" == True
stop_daemon
start_daemon
sleep 2
check "a restart doesn't run the same wake again" test "$(api GET "/api/agents/$ANA/messages" | json "len([m for m in d if m['text'].startswith('Scheduled wake')])")" == 1

SPENT="$(api GET /api/state | json "int(d['budgets']['agents'][0]['spent'])")"
echo "Budget: a daily limit at what Ana already spent (${SPENT} cents) blocks her next run"
api PATCH "/api/agents/$ANA" "{\"dailyBudget\":$SPENT}" >/dev/null
BEFORE="$(assistant_count)"
api POST "/api/agents/$ANA/messages" '{"text":"Reply with exactly: SHOULD-NOT-RUN"}' >/dev/null
sleep 3
check "the run was refused with the budget message" grep -q "reached its daily budget" <<<"$(messages)"
check "nothing ran" test "$(assistant_count)" == "$BEFORE"
api PATCH "/api/agents/$ANA" '{"dailyBudget":null}' >/dev/null

echo "Kill switch: pause stops a run waiting for approval, resume runs again"
api POST "/api/agents/$ANA/messages" '{"text":"Use the Bash tool to run exactly this command: sleep 45 && echo slept. Then tell me the output."}' >/dev/null
if wait_for "len(d['approvals']) > 0 or any(a['status'] == 'working' for a in d['agents'])"; then pass "Ana started working"; else fail "Ana started working"; fi
api POST /api/pause '{}' >/dev/null
sleep 3
check "Hive reports paused" test "$(api GET /api/state | json "d['paused']")" == True
check "no approvals are pending" test "$(api GET /api/state | json "len(d['approvals'])")" == 0
check "Ana isn't working" test "$(api GET /api/state | json "d['agents'][0]['status'] != 'working'")" == True
BEFORE="$(assistant_count)"
api POST "/api/agents/$ANA/messages" '{"text":"Reply with exactly: PAUSED-RUN"}' >/dev/null
sleep 3
check "a message while paused is refused" grep -q "^error | Hive is paused." <<<"$(messages)"
check "nothing ran while paused" test "$(assistant_count)" == "$BEFORE"
api POST /api/resume '{}' >/dev/null
api POST "/api/agents/$ANA/messages" '{"text":"Reply with exactly: RESUMED"}' >/dev/null
wait_idle
check "after Resume Ana runs again" grep -q "^assistant | .*RESUMED" <<<"$(messages)"

echo "Saved-rule probe (informational): does Claude Code ask Hive for grep -lo?"
api POST "/api/agents/$ANA/messages" '{"text":"Use the Bash tool to run exactly: grep -lo localhost /etc/hosts. Then tell me the output."}' >/dev/null
if wait_for "len(d['approvals']) > 0"; then
  echo "  info  Claude Code asked Hive (approval created); denying it"
  APPROVAL="$(api GET /api/state | json "d['approvals'][0]['id']")"
  api POST "/api/approvals/$APPROVAL" '{"allow":false}' >/dev/null
else
  echo "  info  Claude Code ran it without asking Hive"
fi
wait_idle

echo "Cleanup"
api DELETE "/api/agents/$ANA" >/dev/null
check "agent and schedules removed" test "$(api GET /api/state | json "len(d['agents'])")" == 0

if [[ "$FAILED" -ne 0 ]]; then echo "e2e-step4: FAILED"; exit 1; fi
echo "e2e-step4: all checks passed"
