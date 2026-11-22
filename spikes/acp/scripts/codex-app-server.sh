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
    echo "files under ~/.codex that hold the token: $(token_files "$HOME/.codex")" ;;

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

  10-push-r)
    # Review M1: the person's default (no sandbox, no approval flag), several runs, signing off for the agent's git only.
    for r in r1 r2 r3; do
      wt=$(new_worktree codex-r1-push-$r); f=$(fixture $P $W 10-push-nosign-default-$r)
      drive --cwd "$wt" --transcript "$f" --permission allow "${NOSIGN[@]}" --prompt "$PUSH_PROMPT" -- "${BASE[@]}"
      { echo "run $r: $(pushed "$wt" codex-r1-push-$r)"; push_report "$f"; } | tee "${f%.jsonl}.observed.txt"
    done
    # One run with the person's own signing in place.
    wt=$(new_worktree codex-r1-push-signed); f=$(fixture $P $W 10-push-default-r1)
    drive --cwd "$wt" --transcript "$f" --permission allow --prompt "$PUSH_PROMPT" -- "${BASE[@]}"
    { echo "signed run: $(pushed "$wt" codex-r1-push-signed)"
      echo "git log -1 --format=%G? in the worktree: $(git -C "$wt" log -1 --format=%G? 2>/dev/null) (subject: $(git -C "$wt" log -1 --format=%s))"
      push_report "$f"; } | tee "${f%.jsonl}.observed.txt" ;;

  10-push-signed-escalate)
    # The person's own signing, with the agent told to ask for escalation, so a commit is attempted.
    wt=$(new_worktree codex-r1-push-signed2); f=$(fixture $P $W 10-push-default-r2)
    drive --cwd "$wt" --transcript "$f" --permission allow --turn-timeout 300 \
      --prompt "$PUSH_PROMPT If the sandbox blocks a step, request approval to run it outside the sandbox instead of giving up." -- "${BASE[@]}"
    { echo "signed run, escalation asked for: $(pushed "$wt" codex-r1-push-signed2)"
      echo "git log -1 --format=%G? in the worktree: $(git -C "$wt" log -1 --format=%G? 2>/dev/null) (subject: $(git -C "$wt" log -1 --format=%s))"
      push_report "$f"; } | tee "${f%.jsonl}.observed.txt" ;;

  2-filechange-approval)
    # Review M2: an edit the read-only default sandbox blocks, under the default on-request policy; allow, then deny.
    wt=$(new_worktree codex-r1-fc); f=$(fixture $P $W 2-filechange-approval)
    drive --cwd "$wt" --transcript "$f" --permission alt \
      --prompt "Use your apply_patch tool (not a shell command) to create a.txt containing one. If the sandbox blocks the edit, request approval for it. Then do the same for b.txt containing two. Report what happened to each." \
      -- "${BASE[@]}"
    { echo "a.txt: $(test -e "$wt/a.txt" && echo present || echo absent); b.txt: $(test -e "$wt/b.txt" && echo present || echo absent)"
      approvals "$f"; } | tee "${f%.jsonl}.observed.txt" ;;

  2-permissions-approval)
    # Review M2: the request_permissions tool, turned on for this check only.
    wt=$(new_worktree codex-r1-perm); f=$(fixture $P $W 2-permissions-approval)
    drive --cwd "$wt" --transcript "$f" --permission alt --set-config 'features.request_permissions_tool=true' \
      --prompt "Use your request_permissions tool to ask for write access to the current folder. If it is granted, create a.txt containing one with a shell command. Then ask once more for network access. Report what each request returned." \
      -- "${BASE[@]}"
    { echo "a.txt: $(test -e "$wt/a.txt" && echo present || echo absent)"; approvals "$f"; } | tee "${f%.jsonl}.observed.txt" ;;

  3-cancel-chosen|4-kill-resume-chosen|5-hold-chosen)
    # Review minor 3: the chosen flag set. No sandbox, sandbox_mode or approvalPolicy anywhere; the tools endpoint in
    # config.mcp_servers with its token in http_headers, tool_timeout_sec 600 and default_tools_approval_mode approve.
    export MCP_SPIKE_TOKEN="$SPIKE_MCP_TOKEN"
    wt=$(new_worktree "codex-r1-$1"); mcp_start "r1-$1"
    chosen=(--mcp-url "$MCP_URL" --mcp-token-env MCP_SPIKE_TOKEN --mcp-tool-timeout 600)
    case $1 in
      3-cancel-chosen)
        f=$(fixture $P $W 3-cancel-chosen)
        drive --cwd "$wt" --transcript "$f" --permission allow --cancel-after 12 "${chosen[@]}" \
          --prompt "$CANCEL_PROMPT" --prompt "Reply with the single word ready." -- env -u SPIKE_MCP_TOKEN "${BASE[@]}"
        processes_report "$f" 'sleep 60' | tee "${f%.jsonl}.observed.txt" ;;
      4-kill-resume-chosen)
        f=$(fixture $P $W 4-kill-chosen); pidf="$SPIKE_SCRATCH/codex-r1-4.pid"
        drive --cwd "$wt" --transcript "$f" --permission allow --pid-file "$pidf" "${chosen[@]}" \
          --prompt "$KILL_PROMPT" -- env -u SPIKE_MCP_TOKEN "${BASE[@]}" &
        kill_driver_when '^sleep 120$' "$pidf" "${f%.jsonl}.observed.txt"
        tid=$(first_value "$f" 'd["result"]["thread"]["id"]')
        for p in $KW_CMDS; do kill "$p" 2>/dev/null || true; done
        drive --cwd "$wt" --transcript "$(fixture $P $W 4-resume-chosen)" --permission allow --resume "$tid" "${chosen[@]}" \
          --prompt "$RESUME_PROMPT" -- env -u SPIKE_MCP_TOKEN "${BASE[@]}" ;;
      5-hold-chosen)
        f=$(fixture $P $W 5-hold-chosen)
        drive --cwd "$wt" --transcript "$f" --permission allow "${chosen[@]}" --turn-timeout 900 \
          --prompt "Call the hold tool of the spike MCP server with seconds set to 540, then tell me exactly what it returned or what error you got." \
          -- env -u SPIKE_MCP_TOKEN "${BASE[@]}"
        keep_mcp_log "$f" ;;
    esac
    mcp_stop ;;

  5-mcp-at-rest)
    # Review M4: after a call through http_headers, does any file of the login hold the token? Count only.
    export MCP_SPIKE_TOKEN="$SPIKE_MCP_TOKEN"
    wt=$(new_worktree codex-r1-rest); mcp_start r1-rest; f=$(fixture $P $W 5-mcp-at-rest)
    drive --cwd "$wt" --transcript "$f" --permission allow --mcp-url "$MCP_URL" --mcp-token-env MCP_SPIKE_TOKEN --mcp-tool-timeout 600 \
      --prompt "Call the ping tool of the spike MCP server and tell me what it returned." -- env -u SPIKE_MCP_TOKEN "${BASE[@]}"
    keep_mcp_log "$f"; mcp_stop
    echo "files under ~/.codex that hold the token (auth.json and other credential files skipped): $(token_files "$HOME/.codex")" | tee "${f%.jsonl}.observed.txt" ;;

  4-kill-resume-mcp)
    # Review M4: the endpoint survives a resume only with a new token; the old one is refused.
    wt=$(new_worktree codex-r1-kmcp); f=$(fixture $P $W 4-kill-mcp); pidf="$SPIKE_SCRATCH/codex-r1-kmcp.pid"
    obs="${f%.jsonl}.observed.txt"
    export MCP_SPIKE_TOKEN="$SPIKE_MCP_TOKEN"; old_token="$SPIKE_MCP_TOKEN"
    mcp_start r1-kmcp-old; old_log="$MCP_LOG"; old_pid=$MCP_PID
    drive --cwd "$wt" --transcript "$f" --permission allow --pid-file "$pidf" --mcp-url "$MCP_URL" --mcp-token-env MCP_SPIKE_TOKEN --mcp-tool-timeout 600 \
      --prompt "Call the ping tool of the spike MCP server, then run the shell command 'sleep 120' and wait for it, then say done." \
      -- env -u SPIKE_MCP_TOKEN "${BASE[@]}" &
    kill_driver_when '^sleep 120$' "$pidf" "$obs"
    tid=$(first_value "$f" 'd["result"]["thread"]["id"]')
    for p in $KW_CMDS; do kill "$p" 2>/dev/null || true; done
    kill "$old_pid" 2>/dev/null || true; wait "$old_pid" 2>/dev/null || true
    echo "old server stopped: $(kill -0 "$old_pid" 2>/dev/null && echo no || echo yes)" | tee -a "$obs"
    # A new token and a new server, as a harness restart would mint.
    SPIKE_MCP_TOKEN="spk_$(openssl rand -hex 24)"; export SPIKE_MCP_TOKEN MCP_SPIKE_TOKEN="$SPIKE_MCP_TOKEN"
    mcp_start r1-kmcp-new
    drive --cwd "$wt" --transcript "$(fixture $P $W 4-resume-mcp)" --permission allow --resume "$tid" \
      --mcp-url "$MCP_URL" --mcp-token-env MCP_SPIKE_TOKEN --mcp-tool-timeout 600 --redact-env OLD_SPIKE_TOKEN \
      --prompt "Call the ping tool of the spike MCP server again and tell me what it returned." -- env -u SPIKE_MCP_TOKEN "${BASE[@]}"
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $old_token" -H 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$MCP_URL")
    { echo "old token sent to the new server: HTTP $code"
      echo "old server log: $(python3 -c 'import json,sys;l=[json.loads(x) for x in open(sys.argv[1])];print(sum(1 for e in l if e.get("tool")=="ping"),"ping call(s),",sum(1 for e in l if e.get("auth")=="ok"),"ok,",sum(1 for e in l if e.get("auth") not in (None,"ok")),"refused")' "$old_log")"
      echo "new server log (before the curl): $(python3 -c 'import json,sys;l=[json.loads(x) for x in open(sys.argv[1])][:-1];print(sum(1 for e in l if e.get("tool")=="ping"),"ping call(s),",sum(1 for e in l if e.get("auth")=="ok"),"ok,",sum(1 for e in l if e.get("auth") not in (None,"ok")),"refused")' "$MCP_LOG")"
    } | tee -a "$obs"
    cp "$old_log" "${f%.jsonl}.mcp-log.jsonl"; keep_mcp_log "$(fixture $P $W 4-resume-mcp)"; mcp_stop ;;


  r1-two-servers|r1-collision)
    # R1: a per-session endpoint name of letters and digits only, a second server, and a pair of names that collide
    # once joined with underscores (server a_b with tool c, server a with tool b_c).
    # Chosen flags; only the own endpoint carries default_tools_approval_mode.
    export MCP_SPIKE_TOKEN="$SPIKE_MCP_TOKEN"
    wt=$(new_worktree "codex-r2-$1"); f=$(fixture $P $W "$1"); obs="${f%.jsonl}.observed.txt"
    if [ "$1" = r1-two-servers ]; then
      own="spk$(rand_name)"; other="spkx$(rand_name)"
      mcp_start "cx-$1-own"; own_url=$MCP_URL; mcp_start "cx-$1-other"; other_url=$MCP_URL
      prompt="Call the ping tool of the $own MCP server, then the ping tool of the $other MCP server. Report both answers."
    else
      own="spka_b"; other="spka"
      mcp_start "cx-$1-own" --extra-tool c; own_url=$MCP_URL; mcp_start "cx-$1-other" --extra-tool b_c; other_url=$MCP_URL
      prompt="Call the tool c of the spka_b server and the tool b_c of the spka server, and report both answers."
    fi
    drive --cwd "$wt" --transcript "$f" --permission allow --mcp-token-env MCP_SPIKE_TOKEN --mcp-tool-timeout 600 \
      --mcp-server "$own=$own_url" --mcp-server "$other=$other_url" --own-server "$own" --prompt "$prompt" \
      -- env -u SPIKE_MCP_TOKEN "${BASE[@]}"
    { echo "own endpoint: $own (default_tools_approval_mode approve); other server: $other"
      echo "MCP tool calls (server/tool): $(python3 -c 'import json,sys
seen=[]
for l in open(sys.argv[1]):
    d=json.loads(l)["data"]
    it=(d.get("params") or {}).get("item") or {} if isinstance(d,dict) else {}
    if isinstance(d,dict) and d.get("method")=="item/started" and it.get("type")=="mcpToolCall": seen.append("%s/%s" % (it.get("server"), it.get("tool")))
print(" ".join(seen))' "$f")"
      echo "permission requests:"; permission_requests "$f"; } | tee "$obs" ;;

  r2-ask)
    # R2: ask returns "question pending, end your turn" after 20 s; the answer comes as the next prompt.
    export MCP_SPIKE_TOKEN="$SPIKE_MCP_TOKEN"
    wt=$(new_worktree codex-r2-ask); mcp_start cx-r2 --ask-after 20; f=$(fixture $P $W r2-ask)
    drive --cwd "$wt" --transcript "$f" --permission allow --mcp-url "$MCP_URL" --mcp-token-env MCP_SPIKE_TOKEN --mcp-tool-timeout 600 \
      --prompt "$ASK_PROMPT" --prompt "$ANSWER_PROMPT" -- env -u SPIKE_MCP_TOKEN "${BASE[@]}"
    ask_report "$f" "$wt" | tee "${f%.jsonl}.observed.txt"; keep_mcp_log "$f"; mcp_stop ;;

  *) echo "unknown check $1" >&2; exit 2 ;;
esac
