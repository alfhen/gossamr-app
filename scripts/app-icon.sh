#!/usr/bin/env bash
# Regenerates src-tauri/icons from brand/. `tauri icon` draws every size from one source, but at 16 and 32 pt Pip's
# legs and thread blur, so icon.icns and 32x32.png are rebuilt from brand/gossamr-icon-small.svg afterwards.
set -euo pipefail

cd "$(dirname "$0")/.."
ICONS=src-tauri/icons
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pnpm -s tauri icon brand/gossamr-icon.svg -o "$ICONS" >/dev/null 2>&1
# Gossamr is macOS only.
rm -rf "$ICONS/android" "$ICONS/ios" "$ICONS/64x64.png"

pnpm -s tauri icon brand/gossamr-icon.svg -o "$WORK/full" -p 1024 -p 512 -p 256 -p 128 >/dev/null 2>&1
pnpm -s tauri icon brand/gossamr-icon-small.svg -o "$WORK/small" -p 64 -p 32 -p 16 >/dev/null 2>&1

SET="$WORK/Gossamr.iconset"
mkdir "$SET"
cp "$WORK/small/16x16.png" "$SET/icon_16x16.png"
cp "$WORK/small/32x32.png" "$SET/icon_16x16@2x.png"
cp "$WORK/small/32x32.png" "$SET/icon_32x32.png"
cp "$WORK/small/64x64.png" "$SET/icon_32x32@2x.png"
cp "$WORK/full/128x128.png" "$SET/icon_128x128.png"
cp "$WORK/full/256x256.png" "$SET/icon_128x128@2x.png"
cp "$WORK/full/256x256.png" "$SET/icon_256x256.png"
cp "$WORK/full/512x512.png" "$SET/icon_256x256@2x.png"
cp "$WORK/full/512x512.png" "$SET/icon_512x512.png"
cp "$WORK/full/1024x1024.png" "$SET/icon_512x512@2x.png"
iconutil -c icns "$SET" -o "$ICONS/icon.icns"
cp "$WORK/small/32x32.png" "$ICONS/32x32.png"

echo "Icons written to $ICONS"
