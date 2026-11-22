#!/usr/bin/env bash
# Codex, ACP path: @agentclientprotocol/codex-acp 2.9.0 (a Node adapter over `codex app-server`).
# Usage: bash scripts/codex-acp.sh <check>   (see README.md for the list)
# CODEX_PATH unset: the adapter runs its bundled @openai/codex. Set CODEX_ACP_OWN=1 to point it at your own codex.
source "$(dirname "$0")/env.sh"
source "$(dirname "$0")/codex-common.sh"

P=codex; W=acp
MODEL=${CODEX_MODEL:-gpt-6-luna}
ADAPTER=(node "$ADAPTERS/@agentclientprotocol/codex-acp/dist/index.js")
ENV=()
[ "${CODEX_ACP_OWN:-}" = 1 ] && ENV=(--env "CODEX_PATH=$(command -v codex)")

drive() { "$SPIKE" acp ${ENV[@]+"${ENV[@]}"} "$@"; }

case "${1:?check}" in
  1-edit-run)
    wt=$(new_worktree codex-acp-1)
    drive --cwd "$wt" --transcript "$(fixture $P $W 1-edit-run)" --permission allow \
      --prompt "Create a file named note.txt containing the single word hello. Then run the shell command 'ls' and tell me its output in one short sentence." \
      -- "${ADAPTER[@]}"
    ls "$wt"; cat "$wt/note.txt" ;;
  5-mcp-token)
    # The token travels in the session/new request (stdin), as an HTTP header.
    wt=$(new_worktree codex-acp-5); mcp_start acp5; f=$(fixture $P $W 5-mcp-token)
    drive --cwd "$wt" --transcript "$f" --permission allow --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN --model gpt-6-luna \
      --prompt "Run the shell command 'printenv SPIKE_MCP_TOKEN | wc -c' and tell me the number it printed (never the variable itself). Then call the ping tool of the spike MCP server and tell me what it returned." \
      -- "${ADAPTER[@]}" & dp=$!
    sleep 12; echo "processes whose argv holds the token: $(ps -axww -o args= | grep -c -- "$SPIKE_MCP_TOKEN" | awk '{print $1-1}')"
    wait $dp || true; keep_mcp_log "$f"; mcp_stop ;;

  5-mcp-token-header-only)
    # The token only in the session/new header: MCP_SPIKE_TOKEN is read by the driver and not passed to the adapter
    # (the driver strips MCP_* variables). Then: can the agent's commands find it in their environment?
    export MCP_SPIKE_TOKEN="$SPIKE_MCP_TOKEN"
    wt=$(new_worktree codex-acp-5h); mcp_start acp5h; f=$(fixture $P $W 5-mcp-token-header-only)
    drive --cwd "$wt" --transcript "$f" --permission allow --mcp-url "$MCP_URL" --mcp-token-env MCP_SPIKE_TOKEN --model gpt-6-luna \
      --prompt "Run the shell command 'env | grep -c spk_' and tell me the number it printed. Then call the ping tool of the spike MCP server and tell me what it returned." \
      -- env -u SPIKE_MCP_TOKEN "${ADAPTER[@]}" & dp=$!
    sleep 12; echo "processes whose argv holds the token: $(ps -axww -o args= | grep -c -- "$SPIKE_MCP_TOKEN" | awk '{print $1-1}')"
    wait $dp || true; keep_mcp_log "$f"; mcp_stop
    echo "files under ~/.codex that hold the token: $(token_files "$HOME/.codex")" ;;

  5-hold-default)
    wt=$(new_worktree codex-acp-$1); mcp_start "acp-$1"; f=$(fixture $P $W "$1")
    drive --cwd "$wt" --transcript "$f" --permission allow --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN --model gpt-6-luna --turn-timeout 900 \
      --prompt "Call the hold tool of the spike MCP server with seconds set to 540, then tell me exactly what it returned or what error you got." \
      -- "${ADAPTER[@]}"
    keep_mcp_log "$f"; mcp_stop ;;

  2-permission)
    # The adapter's read-only mode: on-request approvals, read-only sandbox, so a write asks.
    wt=$(new_worktree codex-acp-2)
    drive --cwd "$wt" --transcript "$(fixture $P $W 2-permission)" --permission alt --mode read-only --model gpt-6-luna \
      --prompt "$PERM_PROMPT" -- "${ADAPTER[@]}"
    ls "$wt" ;;

  2-permission-escalate)
    wt=$(new_worktree codex-acp-2e)
    drive --cwd "$wt" --transcript "$(fixture $P $W 2-permission-escalate)" --permission alt --mode read-only --model gpt-6-luna \
      --prompt "$ESCALATE_PROMPT" -- "${ADAPTER[@]}"
    ls "$wt" ;;

  3-cancel)
    wt=$(new_worktree codex-acp-3)
    drive --cwd "$wt" --transcript "$(fixture $P $W 3-cancel)" --permission allow --cancel-after 12 --model gpt-6-luna \
      --prompt "$CANCEL_PROMPT" --prompt "Reply with the single word ready." -- "${ADAPTER[@]}"
    ls "$wt"; pids_matching 'sleep 60' ;;

  4-kill-resume)
    wt=$(new_worktree codex-acp-4); tr=$(fixture $P $W 4-kill); pidf="$SPIKE_SCRATCH/codex-acp-4.pid"
    drive --cwd "$wt" --transcript "$tr" --permission allow --pid-file "$pidf" --model gpt-6-luna \
      --prompt "$KILL_PROMPT" -- "${ADAPTER[@]}" & dp=$!
    kill_driver_when '^sleep 120$' "$pidf"
    sid=$(first_value "$tr" 'd["result"]["sessionId"]'); echo "session $sid"
    pkill -f '^sleep 120$' || true; pkill -f '^/bin/zsh -c sleep 120' || true
    for m in load resume; do
      drive --cwd "$wt" --transcript "$(fixture $P $W 4-resume-$m)" --permission allow --resume "$sid" --resume-method $m \
        --prompt "$RESUME_PROMPT" -- "${ADAPTER[@]}"
    done ;;

  5-hold-600)
    # ACP's mcpServers entry has no timeout, and CODEX_CONFIG holding only tool_timeout_sec for that name fails
    # session/new ("invalid transport in mcp_servers.spike"). So the whole server goes in CODEX_CONFIG instead of ACP.
    wt=$(new_worktree codex-acp-$1); mcp_start "acp-$1"; f=$(fixture $P $W "$1")
    cfg=$(printf '{"mcp_servers":{"spike":{"url":"%s","bearer_token_env_var":"SPIKE_MCP_TOKEN","tool_timeout_sec":600,"default_tools_approval_mode":"approve"}}}' "$MCP_URL")
    drive --cwd "$wt" --transcript "$f" --permission allow --model gpt-6-luna --turn-timeout 900 --env "CODEX_CONFIG=$cfg" \
      --prompt "Call the hold tool of the spike MCP server with seconds set to 540, then tell me exactly what it returned or what error you got." \
      -- "${ADAPTER[@]}"
    keep_mcp_log "$f"; mcp_stop ;;

  12-program)
    # Which codex the adapter starts: run with CODEX_ACP_OWN unset (bundled) and =1 (your own); the processes note says.
    wt=$(new_worktree codex-acp-12); suffix=bundled; [ "${CODEX_ACP_OWN:-}" = 1 ] && suffix=own
    drive --cwd "$wt" --transcript "$(fixture $P $W 12-program-$suffix)" --list-only -- "${ADAPTER[@]}" & dp=$!
    sleep 6; pgrep -fl 'codex' | grep -v acp-spike | sed "s#$HOME#~#g; s#$SPIKE_SCRATCH#\$SCRATCH#g" | cut -c1-200
    wait $dp || true ;;

  8-own-setup)
    # The adapter trusts the session's folder itself (a runtime override), so this is its only case.
    wt=$(new_worktree codex-acp-8); mcp_start acp8; own_setup "$wt" "$MCP_URL"
    drive --cwd "$wt" --transcript "$(fixture $P $W 8-own-setup)" --permission allow --model gpt-6-luna --prompt "$OWN_PROMPT" -- "${ADAPTER[@]}"
    marker "$wt"; keep_mcp_log "$(fixture $P $W 8-own-setup)"; mcp_stop ;;

  10-push|10-push-nosign)
    for mode in default workspace-write agent-full-access; do
      wt=$(new_worktree codex-acp-$1-$mode); extra=(); [ $mode != default ] && extra=(--mode $mode)
      [ $1 = 10-push-nosign ] && extra+=("${NOSIGN[@]}")
      drive --cwd "$wt" --transcript "$(fixture $P $W $1-$mode)" --permission allow --model gpt-6-luna ${extra[@]+"${extra[@]}"} --prompt "$PUSH_PROMPT" -- "${ADAPTER[@]}"
      echo "mode $mode: $(pushed "$wt" codex-acp-$1-$mode)"
    done ;;

  7-second-login)
    home=$(mktemp -d "$SPIKE_SCRATCH/codex-home-acp7.XXXX"); wt=$(new_worktree codex-acp-7)
    drive --cwd "$wt" --transcript "$(fixture $P $W 7-second-login-empty)" --list-only --env "CODEX_HOME=$home" -- "${ADAPTER[@]}" &
    drive --cwd "$wt" --transcript "$(fixture $P $W 7-second-login-real)" --list-only -- "${ADAPTER[@]}" &
    wait ;;

  6-models)
    wt=$(new_worktree codex-acp-6)
    drive --cwd "$wt" --transcript "$(fixture $P $W 6-models)" --model gpt-6-luna --set-config reasoning_effort=low --list-only -- "${ADAPTER[@]}" ;;

  *) echo "unknown check $1" >&2; exit 2 ;;
esac
