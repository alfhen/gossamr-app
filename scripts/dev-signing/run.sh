#!/usr/bin/env bash
# Cargo runner (see src-tauri/.cargo/config.toml): signs the app binary with the local dev identity, then runs it.
# Without the identity (a fresh clone, CI) it just runs the binary unsigned. Set it up with setup.sh.
KC="$HOME/Library/Keychains/gossamr-dev.keychain-db"
NAME="Gossamr Dev Signing"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin="$1"

if [ "$(basename "$bin")" = "gossamr" ] && [ -f "$KC" ]; then
  id=$(sed -n 's/.*"identifier": *"\([^"]*\)".*/\1/p' "$DIR/../../src-tauri/tauri.conf.json")
  security unlock-keychain -p "" "$KC" 2>/dev/null
  codesign --force --keychain "$KC" --sign "$NAME" --identifier "$id" "$bin" 2>/dev/null \
    || echo "dev signing failed, running unsigned" >&2
fi

exec "$@"
