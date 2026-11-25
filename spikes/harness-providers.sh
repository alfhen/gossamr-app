#!/bin/bash
# H4b's acceptance, by hand on the owner's logins: `harness providers` lists Claude and Codex as signed in and an empty
# scratch login folder as signed out, in one call, through each CLI's own status command. It never opens a credential
# file. Each login folder's config is recorded before and after (a hash of each config file; only the size and
# modification time of a credential file) and the script fails with exit 9 when one changed.
#
# Usage: spikes/harness-providers.sh [path to a built harness]. It makes the scratch login folder in the home folder,
# where the folder rules want it, as ~/.harness-scratch-<random>, and removes it at the end. Output has the home folder
# written ~ and email addresses masked.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
harness="${1:-$root/target/debug/harness}"
[ -x "$harness" ] || { echo "build it first: cargo build -p harness" >&2; exit 2; }

scratch_login="$HOME/.harness-scratch-$(openssl rand -hex 4)"
data="$(mktemp -d)/data"
mkdir "$scratch_login"

# The folders the CLIs keep their logins in, from the person's shell too.
shell_vars="$("${SHELL:-/bin/zsh}" -ilc 'printf "%s\n%s\n" "${CLAUDE_CONFIG_DIR:-}" "${CODEX_HOME:-}"' 2>/dev/null || true)"
claude_dir="$(sed -n 1p <<<"$shell_vars")"; codex_dir="$(sed -n 2p <<<"$shell_vars")"
claude_dir="${claude_dir:-$HOME/.claude}"; codex_dir="${codex_dir:-$HOME/.codex}"

snapshot() {
  local f
  for f in "$claude_dir/settings.json" "$claude_dir/settings.local.json" "$codex_dir/config.toml"; do
    if [ -f "$f" ]; then echo "$f $(shasum -a 256 < "$f" | cut -c1-16)"; else echo "$f absent"; fi
  done
  for f in "$codex_dir/auth.json" "$claude_dir/.credentials.json"; do
    if [ -e "$f" ]; then echo "$f $(stat -f '%z %m' "$f")"; else echo "$f absent"; fi
  done
}

mask() { sed -E "s#$HOME#~#g; s#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#<email>#g"; }

before="$(snapshot)"
finish() {
  local rc=$? after
  rm -rf "$scratch_login" "$(dirname "$data")"
  after="$(snapshot)"
  if [ "$after" != "$before" ]; then
    echo "LOGIN CONFIG CHANGED:" >&2
    diff <(echo "$before") <(echo "$after") | mask >&2 || true
    exit 9
  fi
  echo "login config unchanged ($(wc -l <<<"$before" | tr -d ' ') files checked)"
  exit "$rc"
}
trap finish EXIT

out="$("$harness" providers --data "$data" --login "codex=~/${scratch_login##*/}")"
mask <<<"$out"

state() { awk -v p="$1" -v f="$2" '$1 == p && $2 == f { print $4 }' <<<"$out"; }
fail=0
[ "$(state claude '(usual)')" = "ready:" ] || { echo "FAIL: Claude is not signed in" >&2; fail=1; }
[ "$(state codex '(usual)')" = "ready:" ] || { echo "FAIL: Codex is not signed in" >&2; fail=1; }
[ "$(state codex "~/${scratch_login##*/}")" = "not_signed_in:" ] || { echo "FAIL: the scratch folder is not signed out" >&2; fail=1; }
[ "$fail" = 0 ] && echo "PASS: Claude and Codex signed in, the scratch login signed out, in one call"
exit "$fail"
