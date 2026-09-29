#!/usr/bin/env bash
# One-time setup: a throwaway code-signing identity in its own keychain, so every local build of the app is signed
# the same way. macOS ties Keychain access to the app's code signature, and an unsigned dev binary changes signature
# on every rebuild, which brings the "allow access?" prompt back each time. Safe to run again.
set -euo pipefail

KC="$HOME/Library/Keychains/gossamr-dev.keychain-db"
NAME="Gossamr Dev Signing"

if [ -f "$KC" ] && security find-certificate -c "$NAME" "$KC" >/dev/null 2>&1; then
  echo "Already set up: \"$NAME\" in $KC"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/openssl.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$tmp/openssl.cnf" \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
# The older PKCS#12 algorithms, because macOS's `security import` rejects OpenSSL 3's defaults.
openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$NAME" -out "$tmp/id.p12" \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 -passout pass:gossamr

# An empty password is fine: this keychain holds only a key that signs local dev builds.
[ -f "$KC" ] || security create-keychain -p "" "$KC"
security set-keychain-settings "$KC"
security unlock-keychain -p "" "$KC"
security import "$tmp/id.p12" -k "$KC" -P gossamr -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KC" >/dev/null

echo "Created \"$NAME\" in $KC"
echo "Dev builds started with cargo run or pnpm tauri dev are now signed with it."
