#!/bin/bash
# Prepares a Claude Code cloud session (Linux container) to build, test and run Gossamr.
# Does nothing on a local machine.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Tauri's Linux webview, a virtual display and screenshot tools for driving the real app,
# and zsh, which some runs::control tests call as /bin/zsh.
packages=(
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
  libssl-dev libdbus-1-dev
  xvfb xdotool imagemagick
  zsh
)
missing=()
for p in "${packages[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
done
if [ ${#missing[@]} -gt 0 ]; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null
fi

pnpm install

# generate_context! embeds the frontend dist, so it has to exist for the crate to compile.
mkdir -p dist

# Warm the Rust build and clippy (CI runs it) so the first check in the session is quick.
(cd src-tauri && cargo build --all-targets && cargo clippy --all-targets)
