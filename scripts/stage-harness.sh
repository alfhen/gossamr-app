#!/bin/sh
# Builds the harness for the app's bundle, for the target and profile the app is built for, and puts it where
# `bundle.macOS.files` in tauri.conf.json takes it from. Tauri runs it before a build and sets TAURI_ENV_DEBUG to
# "true" for `tauri build --debug`. Not an `externalBin`: tauri-build copies one to target/<profile>/harness on every
# cargo build of the app, over the workspace's own harness, and fails when it is missing.
set -eu
cd "$(dirname "$0")/.."
target="${TAURI_ENV_TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
if [ "${TAURI_ENV_DEBUG:-}" = "true" ]; then
  cargo build -p harness --target "$target"
  profile=debug
else
  cargo build -p harness --release --target "$target"
  profile=release
fi
mkdir -p target/sidecar
cp "target/$target/$profile/harness" target/sidecar/harness
