#!/usr/bin/env bash
# Replaces /Applications/Hive.app with the fresh build and relaunches it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/build/Hive.app"
DEST="${INSTALL_DIR:-/Applications}/Hive.app"

[[ -d "$SRC" ]] || { echo "no build found; run 'make build' first" >&2; exit 1; }

if pgrep -x Hive >/dev/null; then
  osascript -e 'tell application id "local.hive.app" to quit' >/dev/null 2>&1 || true
  for _ in {1..20}; do pgrep -x Hive >/dev/null || break; sleep 0.25; done
  pgrep -x Hive >/dev/null && { echo "Hive is still running. Quit it from the menu bar first." >&2; exit 1; }
fi

rm -rf "$DEST"
ditto "$SRC" "$DEST"
open "$DEST"
echo "installed $DEST"
