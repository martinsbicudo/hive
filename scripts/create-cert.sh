#!/usr/bin/env bash
# Creates a self-signed code-signing identity (once) in a dedicated keychain.
# Signing every build with the same identity lets macOS remember privacy permissions
# (Calendar, Accessibility…) across rebuilds. The keychain only holds
# this local certificate, so its password is a fixed value the build script can use.
set -euo pipefail

source "$(dirname "$0")/signing.env"

if security find-identity -p codesigning "$SIGN_KEYCHAIN" 2>/dev/null | grep -q "\"$SIGN_IDENTITY\""; then
  echo "signing identity \"$SIGN_IDENTITY\" already exists in $SIGN_KEYCHAIN"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $SIGN_IDENTITY
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$WORK/cert.cnf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -name "$SIGN_IDENTITY" -out "$WORK/identity.p12" -passout pass:hive

[[ -f "$SIGN_KEYCHAIN" ]] || security create-keychain -p "$SIGN_KEYCHAIN_PASSWORD" "$SIGN_KEYCHAIN"
security set-keychain-settings "$SIGN_KEYCHAIN"
security unlock-keychain -p "$SIGN_KEYCHAIN_PASSWORD" "$SIGN_KEYCHAIN"
security import "$WORK/identity.p12" -k "$SIGN_KEYCHAIN" -P hive -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$SIGN_KEYCHAIN_PASSWORD" "$SIGN_KEYCHAIN" >/dev/null

echo "created signing identity \"$SIGN_IDENTITY\" in $SIGN_KEYCHAIN"
