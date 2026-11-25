#!/bin/sh
# Builds the harness for the app's bundle, for the target and profile the app is built for, and puts it where
# `bundle.macOS.files` in tauri.conf.json takes it from. Tauri runs it before a build and sets TAURI_ENV_DEBUG to
# "true" for `tauri build --debug`. Not an `externalBin`: tauri-build copies one to target/<profile>/harness on every
# cargo build of the app, over the workspace's own harness, and fails when it is missing. A universal build is the two
# Apple targets joined with lipo, as Tauri builds the app.
set -eu
cd "$(dirname "$0")/.."
target="${TAURI_ENV_TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
if [ "${TAURI_ENV_DEBUG:-}" = "true" ]; then profile=debug; release=""; else profile=release; release="--release"; fi
mkdir -p target/sidecar
if [ "$target" = "universal-apple-darwin" ]; then
  for arch in aarch64-apple-darwin x86_64-apple-darwin; do cargo build -p harness $release --target "$arch"; done
  lipo -create -output target/sidecar/harness "target/aarch64-apple-darwin/$profile/harness" "target/x86_64-apple-darwin/$profile/harness"
else
  cargo build -p harness $release --target "$target"
  cp "target/$target/$profile/harness" target/sidecar/harness
fi
