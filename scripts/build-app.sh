#!/usr/bin/env bash
# Builds the board, the notch app and bundles the daemon into build/Hive.app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

source "$ROOT/scripts/signing.env"
BUILD="$(date +%Y%m%d%H%M)"
APP="$ROOT/build/Hive.app"
RES="$APP/Contents/Resources"

(cd web && npm install --silent && npm run --silent build)
(cd daemon && npm install --silent)
(cd notch && swift build -c release --product HiveNotch)
BIN="$(cd notch && swift build -c release --show-bin-path)/HiveNotch"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES/daemon"
cp "$BIN" "$APP/Contents/MacOS/Hive"
sed -e "s/__BUILD__/$BUILD/" notch/Resources/Info.plist > "$APP/Contents/Info.plist"
[[ -f notch/Resources/AppIcon.icns ]] && cp notch/Resources/AppIcon.icns "$RES/" && /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon" "$APP/Contents/Info.plist"
cp -R daemon/src daemon/connectors daemon/screen daemon/package.json daemon/package-lock.json "$RES/daemon/"
(cd "$RES/daemon" && npm ci --silent --omit=dev)
cp -R web/dist "$RES/web"
cp -R sandbox "$RES/sandbox"

if [[ -f "$SIGN_KEYCHAIN" ]] && security find-identity -p codesigning "$SIGN_KEYCHAIN" | grep -q "\"$SIGN_IDENTITY\""; then
  security unlock-keychain -p "$SIGN_KEYCHAIN_PASSWORD" "$SIGN_KEYCHAIN"
  codesign --force --deep --keychain "$SIGN_KEYCHAIN" --sign "$SIGN_IDENTITY" --identifier local.hive.app "$APP"
else
  echo "warning: signing identity \"$SIGN_IDENTITY\" not found; using ad-hoc signing. Run 'make cert' once." >&2
  codesign --force --deep --sign - --identifier local.hive.app "$APP"
fi

echo "built $APP (build $BUILD)"
