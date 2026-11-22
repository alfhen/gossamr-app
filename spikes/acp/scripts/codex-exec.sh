#!/usr/bin/env bash
# Codex, exec path: `codex exec --json`, one process per turn, events on stdout.
# Usage: bash scripts/codex-exec.sh <check>   (see README.md for the list)
source "$(dirname "$0")/env.sh"
source "$(dirname "$0")/codex-common.sh"

P=codex; W=exec
MODEL=${CODEX_MODEL:-gpt-6-luna}
BASE=(codex exec --json -m "$MODEL" -c 'model_reasoning_effort="low"')

drive() { "$SPIKE" raw "$@"; }

case "${1:?check}" in
  1-edit-run)
    wt=$(new_worktree codex-exec-1)
    drive --cwd "$wt" --transcript "$(fixture $P $W 1-edit-run)" \
      -- "${BASE[@]}" -C "$wt" "Create a file named note.txt containing the single word hello. Then run the shell command 'ls' and tell me its output in one short sentence."
    ls "$wt"; cat "$wt/note.txt" ;;
  5-mcp-token)
    wt=$(new_worktree codex-exec-5); mcp_start exec5; f=$(fixture $P $W 5-mcp-token)
    drive --cwd "$wt" --transcript "$f" -- "${BASE[@]}" -C "$wt" \
      -c "mcp_servers.spike.url=\"$MCP_URL\"" -c 'mcp_servers.spike.bearer_token_env_var="SPIKE_MCP_TOKEN"' \
      -c 'mcp_servers.spike.default_tools_approval_mode="approve"' \
      "Run the shell command 'printenv SPIKE_MCP_TOKEN | wc -c' and tell me the number it printed (never the variable itself). Then call the ping tool of the spike MCP server and tell me what it returned." & dp=$!
    sleep 8; echo "processes whose argv holds the token: $(ps -axww -o args= | grep -c -- "$SPIKE_MCP_TOKEN" | awk '{print $1-1}')"
    wait $dp || true; keep_mcp_log "$f"; mcp_stop ;;

  5-hold-default|5-hold-600)
    wt=$(new_worktree codex-exec-$1); mcp_start "exec-$1"; f=$(fixture $P $W "$1")
    extra=(); [ "$1" = 5-hold-600 ] && extra=(-c 'mcp_servers.spike.tool_timeout_sec=600')
    drive --cwd "$wt" --transcript "$f" --turn-timeout 900 -- "${BASE[@]}" -C "$wt" \
      -c "mcp_servers.spike.url=\"$MCP_URL\"" -c 'mcp_servers.spike.bearer_token_env_var="SPIKE_MCP_TOKEN"' \
      -c 'mcp_servers.spike.default_tools_approval_mode="approve"' ${extra[@]+"${extra[@]}"} \
      "Call the hold tool of the spike MCP server with seconds set to 540, then tell me exactly what it returned or what error you got."
    keep_mcp_log "$f"; mcp_stop ;;

  2-permission)
    # exec has no one to ask. check-only: approval untrusted with a writable sandbox, to see what a request becomes.
    wt=$(new_worktree codex-exec-2)
    drive --cwd "$wt" --transcript "$(fixture $P $W 2-permission)" -- "${BASE[@]}" -C "$wt" -s workspace-write \
      -c 'approval_policy="untrusted"' "$PERM_PROMPT"
    ls "$wt" ;;

  2-permission-escalate)
    # exec cannot be answered: the default on-request policy, with the agent told to ask for escalation.
    wt=$(new_worktree codex-exec-2e)
    drive --cwd "$wt" --transcript "$(fixture $P $W 2-permission-escalate)" -- "${BASE[@]}" -C "$wt" \
      -c 'approval_policy="on-request"' "$ESCALATE_PROMPT"
    ls "$wt" ;;

  3-cancel)
    # Cancel is SIGINT to the process; the next prompt is `exec resume`.
    wt=$(new_worktree codex-exec-3); tr=$(fixture $P $W 3-cancel)
    drive --cwd "$wt" --transcript "$tr" --cancel-after 12 -- "${BASE[@]}" -C "$wt" -s workspace-write "$CANCEL_PROMPT"
    pids_matching 'sleep 60'
    tid=$(first_value "$tr" 'd["thread_id"]')
    drive --cwd "$wt" --transcript "$(fixture $P $W 3-cancel-next)" -- "${BASE[@]}" resume "$tid" "Reply with the single word ready."
    ls "$wt" ;;

  4-kill-resume)
    wt=$(new_worktree codex-exec-4); tr=$(fixture $P $W 4-kill); pidf="$SPIKE_SCRATCH/codex-exec-4.pid"
    drive --cwd "$wt" --transcript "$tr" --pid-file "$pidf" -- "${BASE[@]}" -C "$wt" -s workspace-write "$KILL_PROMPT" &
    kill_driver_when '^sleep 120$' "$pidf"
    tid=$(first_value "$tr" 'd["thread_id"]'); echo "thread $tid"
    pkill -f '^sleep 120$' || true; pkill -f '^/bin/zsh -c sleep 120' || true
    sleep 3; echo "codex exec of the killed driver alive: $(pgrep -f "exec --json.*$wt" >/dev/null && echo yes || echo no)"
    pkill -f "exec --json -m .* -C $wt" || true
    drive --cwd "$wt" --transcript "$(fixture $P $W 4-resume)" -- "${BASE[@]}" resume "$tid" "$RESUME_PROMPT" ;;

  8-own-setup)
    wt=$(new_worktree codex-exec-8); mcp_start exec8; own_setup "$wt" "$MCP_URL"
    drive --cwd "$wt" --transcript "$(fixture $P $W 8-own-setup-untrusted)" -- "${BASE[@]}" -C "$wt" "$OWN_PROMPT"
    marker "$wt"
    drive --cwd "$wt" --transcript "$(fixture $P $W 8-own-setup-trusted)" -- "${BASE[@]}" -C "$wt" -c "$(trust_arg)" "$OWN_PROMPT"
    marker "$wt"
    # check-only: the hook as if the person had trusted it.
    drive --cwd "$wt" --transcript "$(fixture $P $W 8-own-setup-trusted-hooks)" -- "${BASE[@]}" -C "$wt" -c "$(trust_arg)" --dangerously-bypass-hook-trust "$OWN_PROMPT"
    marker "$wt"; keep_mcp_log "$(fixture $P $W 8-own-setup-trusted-hooks)"; mcp_stop ;;

  10-push|10-push-nosign)
    for sb in default workspace-write danger-full-access; do
      wt=$(new_worktree codex-exec-$1-$sb); extra=(); [ $sb != default ] && extra=(-s $sb)
      env=(); [ $1 = 10-push-nosign ] && env=("${NOSIGN[@]}")
      drive --cwd "$wt" --transcript "$(fixture $P $W $1-$sb)" ${env[@]+"${env[@]}"} -- "${BASE[@]}" -C "$wt" ${extra[@]+"${extra[@]}"} "$PUSH_PROMPT"
      echo "sandbox $sb: $(pushed "$wt" codex-exec-$1-$sb)"
    done ;;

  8-hooks-scratch-home)
    # Hook mechanics without the real login: a scratch CODEX_HOME (signed out) whose config.toml trusts the clone.
    wt=$(new_worktree codex-exec-8h); own_setup "$wt" "http://127.0.0.1:9/mcp"
    for bypass in no yes; do
      home=$(mktemp -d "$SPIKE_SCRATCH/codex-home-hooks.XXXX")
      printf '[projects."%s"]\ntrust_level = "trusted"\n' "$SPIKE_SCRATCH/clone" > "$home/config.toml"
      extra=(); [ $bypass = yes ] && extra=(--dangerously-bypass-hook-trust)
      CODEX_HOME=$home codex exec --json -C "$wt" ${extra[@]+"${extra[@]}"} "hi" </dev/null > "$home/out.jsonl" 2>"$home/err.log" || true
      echo "bypass $bypass: $(marker "$wt"); stderr: $(grep -i hook "$home/err.log" | head -2 | sed "s#$SPIKE_SCRATCH#\$SCRATCH#g" | cut -c1-200)"
      rm -f "$wt/hook-marker"
    done ;;

  7-second-login)
    home=$(mktemp -d "$SPIKE_SCRATCH/codex-home-exec7.XXXX"); wt=$(new_worktree codex-exec-7)
    echo "scratch login: $(CODEX_HOME=$home codex login status </dev/null 2>&1 | head -1)"
    drive --cwd "$wt" --transcript "$(fixture $P $W 7-second-login-empty)" --env "CODEX_HOME=$home" -- "${BASE[@]}" -C "$wt" "Reply with the word ok." &
    drive --cwd "$wt" --transcript "$(fixture $P $W 7-second-login-real)" -- "${BASE[@]}" -C "$wt" "Reply with the word ok." &
    wait; echo "real login: $(codex login status </dev/null 2>&1 | head -1)" ;;

  6-models)
    # exec has no model list of its own; `codex debug models` reads the catalog.
    codex debug models </dev/null 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin)["models"]; [print(m["slug"], m.get("visibility"), [e.get("effort") for e in m.get("supported_reasoning_levels",[])]) for m in d]' ;;

  *) echo "unknown check $1" >&2; exit 2 ;;
esac
