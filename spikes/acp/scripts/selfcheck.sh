#!/usr/bin/env bash
# Checks env.sh's exit trap against a scratch HOME holding stand-in login files, never a real one:
# a change made after mcp_start and mcp_stop must fail the script with exit 9, a run with no change must exit 0,
# and a change undone before the end must still fail it.
# Usage: bash scripts/selfcheck.sh   (needs SPIKE_SCRATCH, like every script)
set -u
: "${SPIKE_SCRATCH:?set SPIKE_SCRATCH to a scratch folder under your temp folder}"
DIR="$(cd "$(dirname "$0")" && pwd)"
home="$SPIKE_SCRATCH/selfcheck-home"; rm -rf "$home"
mkdir -p "$home/.claude" "$home/.codex" "$home/.gemini/antigravity-cli" "$home/.gemini/config"
printf '{}\n' > "$home/.claude/settings.json"; printf '{}\n' > "$home/.gemini/antigravity-cli/settings.json"
case_run() { # NAME BODY EXPECTED
  HOME="$home" SPIKE_SCRATCH="$SPIKE_SCRATCH/selfcheck" PATH="$PATH" bash -c "source '$DIR/env.sh'; $2" >/dev/null 2>&1
  local rc=$?
  if [ "$rc" = "$3" ]; then echo "ok   $1 (exit $rc)"; else echo "FAIL $1: exit $rc, expected $3"; FAILED=1; fi
}
FAILED=0
case_run "no change" 'mcp_start selfcheck; mcp_stop' 0
case_run "a change after mcp_start and mcp_stop" 'mcp_start selfcheck; mcp_stop; printf "{\"x\":1}\n" > "$HOME/.claude/settings.json"' 9
printf '{}\n' > "$home/.claude/settings.json"
case_run "a new codex config.toml" 'printf "x=1\n" > "$HOME/.codex/config.toml"' 9
rm -f "$home/.codex/config.toml"
case_run "a change undone before the end" 'printf "{\"y\":1}\n" > "$HOME/.gemini/antigravity-cli/settings.json"; sleep 5; printf "{}\n" > "$HOME/.gemini/antigravity-cli/settings.json"' 9
case_run "a failing check with no change keeps its own exit code" 'mcp_start selfcheck; mcp_stop; false' 1
rm -rf "$home" "$SPIKE_SCRATCH/selfcheck"
exit $FAILED
