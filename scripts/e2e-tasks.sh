#!/usr/bin/env bash
# End-to-end check for tasks and agent-to-agent runs with real Claude Code (haiku) on a scratch daemon.
# Needs a logged-in Claude Code. Costs a few cents.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${E2E_PORT:-47490}"
SCRATCH="$(mktemp -d)"
DAEMON_PID=""
FAILED=0

cleanup() {
  [[ -n "$DAEMON_PID" ]] && kill "$DAEMON_PID" 2>/dev/null && wait "$DAEMON_PID" 2>/dev/null
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
trap 'echo "e2e-tasks: stopped at line $LINENO"; FAILED=1' ERR

pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }

api() {
  local method="$1" path="$2" body="${3:-}"
  curl -sf -X "$method" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    ${body:+-d "$body"} "http://127.0.0.1:$PORT$path"
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
agent() {
  api POST /api/agents "{\"name\":\"$1\",\"role\":\"Tester\",\"engine\":\"claude-code\",\"model\":\"haiku\",\"useMySetup\":false}" | json "d['id']"
}

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

thread() { api GET "/api/tasks/$1" | json "'\n'.join(e['kind']+' | '+e['author']+' | '+e['text'] for e in d['events'])"; }

start_daemon() {
  HIVE_HOME="$SCRATCH" HIVE_PORT="$PORT" HIVE_TASK_MAX_HOP="$1" node "$ROOT/daemon/src/main.ts" >>"$SCRATCH/daemon.out" 2>&1 &
  DAEMON_PID=$!
  for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.2; done
  TOKEN="$(cat "$SCRATCH/token")"
}

echo "Starting a scratch daemon on port $PORT"
start_daemon 6

ANA="$(agent Ana)"
BOB="$(agent Bob)"

echo "Handoff: user → Ana → Bob → review"
TASK="$(api POST /api/tasks "{\"title\":\"Pick a color for the release banner\",\"description\":\"Hand this task to Bob with the note 'please pick blue or green'. Bob: add a comment with your pick, then move the task to review.\",\"assigneeId\":\"$ANA\"}" | json "d['id']")"
wait_idle
T="$(thread "$TASK")"
echo "$T" | sed 's/^/        /'
FINAL="$(api GET "/api/tasks/$TASK" | json "d['task']['status']+' '+str(d['task']['assigneeId'])")"
check "Ana handed the task off" grep -q "^handoff | " <<<"$T"
check "Bob commented" grep -q "^comment | $BOB" <<<"$T"
check "the task ended in review, assigned to Bob" test "$FINAL" == "review $BOB"
check "no chat session was used for the task" test "$(api GET "/api/agents/$ANA/messages" | json "len(d)")" == 0

echo "Loop guard: with the hop limit at 0, Ana's message to Bob is refused"
kill "$DAEMON_PID"; wait "$DAEMON_PID" 2>/dev/null || true
start_daemon 0
api POST "/api/agents/$ANA/messages" "{\"text\":\"Use the message_agent tool to send Bob the text 'hello'. Then tell me exactly what Hive answered.\"}" >/dev/null
wait_idle
ALL="$(api GET "/api/agents/$ANA/messages"; api GET "/api/agents/$BOB/messages")"
check "the message was refused at the hop limit" grep -q "hop limit" <<<"$ALL"
check "Bob never ran" test "$(api GET "/api/agents/$BOB/messages" | json "len([m for m in d if m['role']=='assistant'])")" == 0
check "no approvals were left pending" test "$(api GET /api/state | json "len(d['approvals'])")" == 0

echo "Cleanup"
api DELETE "/api/agents/$ANA" >/dev/null
api DELETE "/api/agents/$BOB" >/dev/null
check "agents removed" test "$(api GET /api/state | json "len(d['agents'])")" == 0

if [[ "$FAILED" -ne 0 ]]; then echo "e2e-tasks: FAILED"; exit 1; fi
echo "e2e-tasks: all checks passed"
