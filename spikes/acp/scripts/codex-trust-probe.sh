#!/usr/bin/env bash
# Which Codex path writes `projects.<repo>.trust_level` into its config.toml? Each try gets a fresh, empty CODEX_HOME
# (signed out, so no model runs); the real ~/.codex is never used.
source "$(dirname "$0")/env.sh"
wt=$(new_worktree codex-trustprobe)
probe() {
  local name=$1; shift
  local home; home=$(mktemp -d "$SPIKE_SCRATCH/codex-home-probe-$name.XXXX")
  "$@" "$home" >/dev/null 2>&1 || true
  if [ -f "$home/config.toml" ]; then echo "$name: config.toml written:"; sed "s#$SPIKE_SCRATCH#\$SCRATCH#g" "$home/config.toml"
  else echo "$name: no config.toml"; fi
}
t_exec()      { CODEX_HOME=$1 codex exec --json -C "$wt" "hi" </dev/null; }
t_exec_untr() { CODEX_HOME=$1 codex exec --json -C "$wt" -c 'approval_policy="untrusted"' "hi" </dev/null; }
t_app()       { "$SPIKE" app-server --cwd "$wt" --transcript "$1/probe.jsonl" --list-only --env "CODEX_HOME=$1" -- codex app-server; }
t_app_untr()  { "$SPIKE" app-server --cwd "$wt" --transcript "$1/probe.jsonl" --list-only --mode untrusted --env "CODEX_HOME=$1" -- codex app-server; }
t_acp()       { "$SPIKE" acp --cwd "$wt" --transcript "$1/probe.jsonl" --list-only --env "CODEX_HOME=$1" -- node "$ADAPTERS/@agentclientprotocol/codex-acp/dist/index.js"; }
t_acp_own()   { "$SPIKE" acp --cwd "$wt" --transcript "$1/probe.jsonl" --list-only --env "CODEX_HOME=$1" --env "CODEX_PATH=$(command -v codex)" -- node "$ADAPTERS/@agentclientprotocol/codex-acp/dist/index.js"; }
t_app_ww()    { "$SPIKE" app-server --cwd "$wt" --transcript "$1/probe.jsonl" --list-only --mode untrusted --set-config 'sandbox_mode="workspace-write"' --env "CODEX_HOME=$1" -- codex app-server; }
t_app_ww_on() { "$SPIKE" app-server --cwd "$wt" --transcript "$1/probe.jsonl" --list-only --set-config 'sandbox_mode="workspace-write"' --env "CODEX_HOME=$1" -- codex app-server; }
t_app_tsb()   { "$SPIKE" app-server --cwd "$wt" --transcript "$1/probe.jsonl" --list-only --set-config 'thread.sandbox="workspace-write"' --env "CODEX_HOME=$1" -- codex app-server; }
t_app_tsbf()  { "$SPIKE" app-server --cwd "$wt" --transcript "$1/probe.jsonl" --list-only --set-config 'thread.sandbox="danger-full-access"' --env "CODEX_HOME=$1" -- codex app-server; }
t_exec_sww()  { CODEX_HOME=$1 codex exec --json -C "$wt" -s workspace-write "hi" </dev/null; }
t_exec_sfa()  { CODEX_HOME=$1 codex exec --json -C "$wt" -s danger-full-access "hi" </dev/null; }
t_app_turn()  { "$SPIKE" app-server --cwd "$wt" --transcript "$1/probe.jsonl" --turn-timeout 20 --prompt hi --set-config 'turn.sandboxPolicy={"type":"workspaceWrite","writableRoots":[],"networkAccess":false}' --env "CODEX_HOME=$1" -- codex app-server; }
t_app_ctrust() { "$SPIKE" app-server --cwd "$wt" --transcript "$1/probe.jsonl" --turn-timeout 20 --prompt hi --env "CODEX_HOME=$1" -- codex app-server -c "projects.\"$SPIKE_SCRATCH/clone\".trust_level=\"trusted\""; }
t_app_cfgtrust() { "$SPIKE" app-server --cwd "$wt" --transcript "$1/probe.jsonl" --turn-timeout 20 --prompt hi --set-config "projects={\"$SPIKE_SCRATCH/clone\":{\"trust_level\":\"trusted\"}}" --env "CODEX_HOME=$1" -- codex app-server; }
t_exec_ctrust() { CODEX_HOME=$1 codex exec --json -C "$wt" -c "projects.\"$SPIKE_SCRATCH/clone\".trust_level=\"trusted\"" "hi" </dev/null; }
t_acp_ro()    { "$SPIKE" acp --cwd "$wt" --transcript "$1/probe.jsonl" --list-only --mode read-only --env "CODEX_HOME=$1" -- node "$ADAPTERS/@agentclientprotocol/codex-acp/dist/index.js"; }
t_acp_full()  { "$SPIKE" acp --cwd "$wt" --transcript "$1/probe.jsonl" --list-only --mode agent-full-access --env "CODEX_HOME=$1" -- node "$ADAPTERS/@agentclientprotocol/codex-acp/dist/index.js"; }
for t in ${PROBES:-exec exec_untr app app_untr app_ww app_ww_on acp acp_own acp_ro acp_full}; do probe "$t" "t_$t"; done
