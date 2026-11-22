#!/usr/bin/env bash
# Codex, app-server path: `codex app-server` over stdio (JSON-RPC without the "jsonrpc" field).
# Usage: bash scripts/codex-app-server.sh <check>   (see README.md for the list)
source "$(dirname "$0")/env.sh"
source "$(dirname "$0")/codex-common.sh"

P=codex; W=app-server
MODEL=${CODEX_MODEL:-gpt-6-luna}
BASE=(codex app-server)

drive() { "$SPIKE" app-server --model "$MODEL" --effort low "$@"; }

case "${1:?check}" in
  1-edit-run)
    wt=$(new_worktree codex-app-1)
    drive --cwd "$wt" --transcript "$(fixture $P $W 1-edit-run)" --permission allow \
      --prompt "Create a file named note.txt containing the single word hello. Then run the shell command 'ls' and tell me its output in one short sentence." \
      -- "${BASE[@]}"
    ls "$wt"; cat "$wt/note.txt" ;;
  5-mcp-token)
    # The token reaches codex only through the variable named by bearer_token_env_var.
    wt=$(new_worktree codex-app-5); mcp_start app5; f=$(fixture $P $W 5-mcp-token)
    drive --cwd "$wt" --transcript "$f" --permission allow --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN \
      --prompt "Run the shell command 'printenv SPIKE_MCP_TOKEN | wc -c' and tell me the number it printed (never the variable itself). Then call the ping tool of the spike MCP server and tell me what it returned." \
      -- "${BASE[@]}" & dp=$!
    sleep 8; echo "processes whose argv holds the token: $(ps -axww -o args= | grep -c -- "$SPIKE_MCP_TOKEN" | awk '{print $1-1}')"
    wait $dp || true; keep_mcp_log "$f"; mcp_stop ;;

  5-mcp-token-header-only)
    # The token as an http_headers entry in thread/start's config (stdin); MCP_SPIKE_TOKEN is not passed to codex.
    export MCP_SPIKE_TOKEN="$SPIKE_MCP_TOKEN"
    wt=$(new_worktree codex-app-5h); mcp_start app5h; f=$(fixture $P $W 5-mcp-token-header-only)
    drive --cwd "$wt" --transcript "$f" --permission allow --mcp-url "$MCP_URL" --mcp-token-env MCP_SPIKE_TOKEN \
      --prompt "Run the shell command 'env | grep -c spk_' and tell me the number it printed. Then call the ping tool of the spike MCP server and tell me what it returned." \
      -- env -u SPIKE_MCP_TOKEN "${BASE[@]}" & dp=$!
    sleep 8; echo "processes whose argv holds the token: $(ps -axww -o args= | grep -c -- "$SPIKE_MCP_TOKEN" | awk '{print $1-1}')"
    wait $dp || true; keep_mcp_log "$f"; mcp_stop
    echo "files under ~/.codex that hold the token: $(grep -rlF -- "$SPIKE_MCP_TOKEN" "$HOME/.codex" 2>/dev/null | wc -l | tr -d ' ')" ;;

  5-hold-default|5-hold-600)
    wt=$(new_worktree codex-app-$1); mcp_start "app-$1"; f=$(fixture $P $W "$1")
    extra=(); [ "$1" = 5-hold-600 ] && extra=(--mcp-tool-timeout 600)
    drive --cwd "$wt" --transcript "$f" --permission allow --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN ${extra[@]+"${extra[@]}"} --turn-timeout 900 \
      --prompt "Call the hold tool of the spike MCP server with seconds set to 540, then tell me exactly what it returned or what error you got." \
      -- "${BASE[@]}"
    keep_mcp_log "$f"; mcp_stop ;;

  2-permission)
    # check-only: approvalPolicy untrusted and a writable sandbox, so commands ask.
    wt=$(new_worktree codex-app-2)
    drive --cwd "$wt" --transcript "$(fixture $P $W 2-permission)" --permission alt --mode untrusted \
      --set-config "$WW_TURN" --prompt "$PERM_PROMPT" -- "${BASE[@]}"
    ls "$wt" ;;

  2-permission-on-request)
    # The person's default policy (on-request) in the person's default sandbox (read-only here, untrusted folder).
    wt=$(new_worktree codex-app-2r)
    drive --cwd "$wt" --transcript "$(fixture $P $W 2-permission-on-request)" --permission alt \
      --prompt "$PERM_PROMPT" -- "${BASE[@]}"
    ls "$wt" ;;

  2-permission-escalate)
    # The person's default (on-request, read-only here), with the agent told to ask for escalation.
    wt=$(new_worktree codex-app-2e)
    drive --cwd "$wt" --transcript "$(fixture $P $W 2-permission-escalate)" --permission alt \
      --prompt "$ESCALATE_PROMPT" -- "${BASE[@]}"
    ls "$wt" ;;

  3-cancel)
    wt=$(new_worktree codex-app-3)
    drive --cwd "$wt" --transcript "$(fixture $P $W 3-cancel)" --permission allow --cancel-after 12 \
      --set-config "$WW_TURN" --prompt "$CANCEL_PROMPT" --prompt "Reply with the single word ready." -- "${BASE[@]}"
    ls "$wt"; pids_matching 'sleep 60' ;;

  4-kill-resume)
    wt=$(new_worktree codex-app-4); tr=$(fixture $P $W 4-kill); pidf="$SPIKE_SCRATCH/codex-app-4.pid"
    drive --cwd "$wt" --transcript "$tr" --permission allow --pid-file "$pidf" \
      --set-config "$WW_TURN" --prompt "$KILL_PROMPT" -- "${BASE[@]}" & dp=$!
    kill_driver_when '^sleep 120$' "$pidf"
    tid=$(first_value "$tr" 'd["result"]["thread"]["id"]'); echo "thread $tid"
    pkill -f '^sleep 120$' || true; pkill -f '^/bin/zsh -c sleep 120' || true
    drive --cwd "$wt" --transcript "$(fixture $P $W 4-resume)" --permission allow --resume "$tid" \
      --prompt "$RESUME_PROMPT" -- "${BASE[@]}" ;;

  7-second-login)
    # An empty scratch CODEX_HOME beside the real one, both asked at the same time.
    home="$SPIKE_SCRATCH/codex-home-empty"; mkdir -p "$home"; wt=$(new_worktree codex-app-7)
    echo "scratch: $(CODEX_HOME="$home" codex login status </dev/null 2>&1 | head -1) (exit ${PIPESTATUS[0]})"
    "$SPIKE" app-server --cwd "$wt" --transcript "$(fixture $P $W 7-second-login-empty)" --list-only --env "CODEX_HOME=$home" -- "${BASE[@]}" & dp=$!
    "$SPIKE" app-server --cwd "$wt" --transcript "$(fixture $P $W 7-second-login-real)" --list-only -- "${BASE[@]}" & dp=$!
    wait
    echo "real: $(codex login status </dev/null 2>&1 | head -1)"
    echo "files codex made in the empty home:"; (cd "$home" && find . -maxdepth 2 | sort | head -30) ;;

  8-own-setup)
    wt=$(new_worktree codex-app-8); mcp_start app8; own_setup "$wt" "$MCP_URL"
    "$SPIKE" app-server --cwd "$wt" --transcript "$(fixture $P $W 8-own-setup-list)" --list-only -- "${BASE[@]}"
    drive --cwd "$wt" --transcript "$(fixture $P $W 8-own-setup-untrusted)" --permission allow --prompt "$OWN_PROMPT" -- "${BASE[@]}"
    marker "$wt"
    "$SPIKE" app-server --cwd "$wt" --transcript "$(fixture $P $W 8-own-setup-trusted-list)" --list-only -- "${BASE[@]}" -c "$(trust_arg)"
    drive --cwd "$wt" --transcript "$(fixture $P $W 8-own-setup-trusted)" --permission allow --prompt "$OWN_PROMPT" -- "${BASE[@]}" -c "$(trust_arg)"
    marker "$wt"; keep_mcp_log "$(fixture $P $W 8-own-setup-trusted)"; mcp_stop ;;

  10-push|10-push-nosign)
    for sb in default ww full; do
      wt=$(new_worktree codex-app-$1-$sb); extra=(); [ $1 = 10-push-nosign ] && extra=("${NOSIGN[@]}")
      [ $sb = ww ] && extra+=(--set-config "$WW_TURN"); [ $sb = full ] && extra+=(--set-config "$FULL_TURN")
      drive --cwd "$wt" --transcript "$(fixture $P $W $1-$sb)" --permission allow ${extra[@]+"${extra[@]}"} --prompt "$PUSH_PROMPT" -- "${BASE[@]}"
      echo "sandbox $sb: $(pushed "$wt" codex-app-$1-$sb)"
    done ;;

  11-locked)
    # As locked as config allows: every tool-related feature off, web search off, approval never,
    # one MCP server. Codex has no surface that lists a session's tools, so the model is asked, then made to try.
    wt=$(new_worktree codex-app-11); mcp_start app11; feats=()
    for f in shell_tool unified_exec apps browser_use browser_use_external computer_use image_generation view_image \
             plugins goals in_app_browser sleep_tool code_mode_host multi_agent hooks tool_suggest skill_search; do
      feats+=(--set-config "features.$f=false")
    done
    drive --cwd "$wt" --transcript "$(fixture $P $W 11-locked)" --permission deny --mode never \
      --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN --set-config 'web_search="disabled"' "${feats[@]}" \
      --prompt "List every tool you can call, by its exact name, one per line, and nothing else." \
      --prompt "Read the file README.md and print its first line. If you have no tool that can, say NO TOOL." \
      --prompt "Run the shell command ls and print its output. If you have no tool that can, say NO TOOL." \
      --prompt "Fetch https://example.com and print the page title. If you have no tool that can, say NO TOOL." \
      -- "${BASE[@]}"
    # The tool it still lists: is exec able to read a file or run a command?
    drive --cwd "$wt" --transcript "$(fixture $P $W 11-locked-exec)" --permission deny --mode never \
      --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN --set-config 'web_search="disabled"' "${feats[@]}" \
      --prompt "Use your functions.exec tool to list the files in the current folder and to read the first line of README.md, and print what it returned, including any error. Then call the ping tool of the spike MCP server." \
      -- "${BASE[@]}"
    keep_mcp_log "$(fixture $P $W 11-locked)"; mcp_stop ;;

  *) echo "unknown check $1" >&2; exit 2 ;;
esac
