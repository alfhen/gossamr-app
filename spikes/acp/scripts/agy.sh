#!/usr/bin/env bash
# Gemini through the Antigravity CLI: (a) `agy acp`, (b) `agy -p` with stream-json in and out.
# Usage: bash scripts/agy.sh <check>. Checks marked (model) need `agy` signed in: run `agy` once yourself.
source "$(dirname "$0")/env.sh"

P=gemini
# The model is a config option (gemini-3.8-flash), the effort another (thought_level).
MODEL=${AGY_MODEL:-gemini-3.8-flash}
ACPM=(--model "$MODEL" --set-config thought_level=low)
acp() { "$SPIKE" acp "$@"; }

signed_in() { agy models </dev/null >/dev/null 2>&1; }

case "${1:?check}" in
  0-acp-list)
    # initialize and session/new only: capabilities, auth methods, modes, models.
    wt=$(new_worktree gemini-acp-0)
    "$SPIKE" acp --cwd "$wt" --transcript "$(fixture $P acp 0-list)" --list-only --keep-open 3 -- agy acp ;;

  0-print-signed-out)
    # What -p does when it cannot run a model, with stdout piped and no terminal (check 15 when signed out).
    wt=$(new_worktree gemini-print-0)
    # Not `agy -p --input-format ...`: -p takes the next argument as its prompt, and agy refuses (exit 2).
    "$SPIKE" agy-stream --cwd "$wt" --transcript "$(fixture $P print 0-signed-out-stream)" --turn-timeout 90 \
      --prompt "Reply with the single word ok." \
      -- agy --input-format stream-json --output-format stream-json
    "$SPIKE" raw --cwd "$wt" --transcript "$(fixture $P print 0-signed-out-text)" --turn-timeout 60 \
      -- agy -p "Reply with the single word ok." --output-format stream-json ;;

  7-login-folders)
    # Which variables or flags move agy's login. Each candidate gets an empty scratch folder.
    obs="$(fixture $P acp 7-login-folders)"; obs="${obs%.jsonl}.observed.txt"; : > "$obs"
    try() { # LABEL ENV... -- ARGS
      local label=$1; shift
      local out; out=$(env "$@" </dev/null 2>&1 | tail -1 | cut -c1-160) || true
      echo "$label: $out" | sed "s#$SPIKE_SCRATCH#\$SCRATCH#g; s#$HOME#\$HOME#g" | tee -a "$obs"
    }
    d="$SPIKE_SCRATCH/agy-home"; mkdir -p "$d/home" "$d/gcli" "$d/app" "$d/gem" "$d/gem2"
    try "real home" agy models
    try "HOME=empty" HOME="$d/home" agy models
    try "GEMINI_CLI_HOME=empty" GEMINI_CLI_HOME="$d/gcli" agy models
    try "acp --app-data-dir=empty (initialize only, see 7-acp-app-data-dir.jsonl)" true
    "$SPIKE" acp --cwd "$SPIKE_SCRATCH" --transcript "$(fixture $P acp 7-acp-app-data-dir)" --list-only \
      -- agy acp --app-data-dir "$d/app" --gemini-dir "$d/gem"
    # --app-data-dir must be relative ("must not be absolute"); it sits under --gemini-dir.
    "$SPIKE" acp --cwd "$SPIKE_SCRATCH" --transcript "$(fixture $P acp 7-acp-gemini-dir)" --list-only \
      -- agy acp --gemini-dir "$d/gem2" --app-data-dir second-login
    "$SPIKE" acp --cwd "$SPIKE_SCRATCH" --transcript "$(fixture $P acp 7-acp-home)" --list-only --env HOME="$d/home" \
      -- agy acp
    echo "files the empty folders gained:" | tee -a "$obs"
    (cd "$d" && find . -type f | sed 's#^#  #' | sort | head -40) | tee -a "$obs" ;;

  15-no-tty)
    # agy -p with stdout piped and stdin not a terminal: does it run or hang?
    wt=$(new_worktree gemini-print-15)
    obs="$(fixture $P print 15-no-tty)"; obs="${obs%.jsonl}.observed.txt"
    start=$(date +%s)
    (cd "$wt" && agy -p "Reply with the single word ok." </dev/null > "$SPIKE_SCRATCH/agy-15.out" 2> "$SPIKE_SCRATCH/agy-15.err" & echo $! > "$SPIKE_SCRATCH/agy-15.pid"; wait) &
    for _ in $(seq 120); do sleep 1; kill -0 "$(cat "$SPIKE_SCRATCH/agy-15.pid")" 2>/dev/null || break; done
    alive=$(kill -0 "$(cat "$SPIKE_SCRATCH/agy-15.pid")" 2>/dev/null && echo yes || echo no)
    [ "$alive" = yes ] && kill "$(cat "$SPIKE_SCRATCH/agy-15.pid")"
    { echo "still running after $(( $(date +%s) - start )) s: $alive"
      echo "stdout: $(head -c 300 "$SPIKE_SCRATCH/agy-15.out")"
      echo "stderr: $(head -c 300 "$SPIKE_SCRATCH/agy-15.err" | sed -E 's#(https://accounts.google.com/[^?]*)\?.*#\1?<query removed>#')"; } | sed "s#$HOME#\$HOME#g" | tee "$obs" ;;

  1-edit-run)
    wt=$(new_worktree gemini-acp-1)
    acp --cwd "$wt" --transcript "$(fixture $P acp 1-edit-run)" --permission allow "${ACPM[@]}" \
      --prompt "Create a file named note.txt containing the single word hello. Then run the shell command 'ls' and tell me its output in one short sentence." \
      -- agy acp
    ls "$wt" ;;

  2-permission)
    wt=$(new_worktree gemini-acp-2)
    acp --cwd "$wt" --transcript "$(fixture $P acp 2-permission)" --permission alt "${ACPM[@]}" \
      --prompt "Run the shell command 'echo one > a.txt'. Then, as a separate command, run 'echo two > b.txt'. Then read README.md and say how many lines it has. Report what happened to each step." \
      -- agy acp
    ls "$wt" ;;

  3-cancel)
    wt=$(new_worktree gemini-acp-3)
    acp --cwd "$wt" --transcript "$(fixture $P acp 3-cancel)" --permission allow "${ACPM[@]}" --cancel-after 15 \
      --prompt "Run the shell command 'ping -c 40 127.0.0.1 > ping.txt' in the foreground and wait for it to finish." \
      --prompt "Reply with the single word ready." \
      -- agy acp
    # From the driver's own notes: the agent's descendants after each turn, never other processes on the machine.
    tr=$(fixture $P acp 3-cancel)
    python3 -c 'import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l)["data"]
    if isinstance(d,dict) and d.get("note")=="processes": print(d["detail"]["when"], [x["comm"].split("/")[-1] for x in d["detail"]["descendants"]])' "$tr" | tee "${tr%.jsonl}.observed.txt" ;;

  4-kill-resume)
    wt=$(new_worktree gemini-acp-4)
    tr=$(fixture $P acp 4-kill); pidf="$SPIKE_SCRATCH/gemini-acp-4.pid"
    acp --cwd "$wt" --transcript "$tr" --permission allow "${ACPM[@]}" --pid-file "$pidf" \
      --prompt "Run the shell command 'ping -c 90 127.0.0.1 > ping.txt' in the foreground, wait for it, then say done." \
      -- agy acp &
    kill_watch "$pidf" 'ping -c 90' "${tr%.jsonl}.observed.txt"
    pkill -f '^ping -c 90' || true
    kill "$KW_AGENT" 2>/dev/null || true
    sid=$(python3 -c 'import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l)["data"]
    if isinstance(d,dict) and d.get("note")=="session": print(d["detail"]["id"]); break' "$tr")
    acp --cwd "$wt" --transcript "$(fixture $P acp 4-resume)" --permission allow --resume "$sid" \
      --prompt "What exactly did I ask you to do in my previous message, and did the command finish? Answer in two short sentences." \
      -- agy acp ;;

  5-mcp)
    wt=$(new_worktree gemini-acp-5); mcp_start gemini-acp-5
    tr=$(fixture $P acp 5-mcp)
    acp --cwd "$wt" --transcript "$tr" --permission allow "${ACPM[@]}" --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN \
      --prompt "Call the ping tool of the spike MCP server and tell me what it answered (say NO SPIKE if you have no such tool). Then run the shell command 'printenv SPIKE_MCP_TOKEN | wc -c' and tell me the number it printed (never print the variable itself)." \
      -- agy acp
    { echo "files under ~/.gemini/antigravity-cli holding the token: $(token_files "$HOME/.gemini/antigravity-cli")"
      echo "which (folder and kind, ids masked): $(grep -rlF --exclude='*creds*' --exclude=google_accounts.json -- "$SPIKE_MCP_TOKEN" "$HOME/.gemini/antigravity-cli" 2>/dev/null | sed "s#$HOME#\$HOME#; s#[0-9a-f]\{8\}-[0-9a-f-]\{27\}#<id>#g" | tr '\n' ' ')"
      sleep 30
      echo "30 s later: $(token_files "$HOME/.gemini/antigravity-cli")"; } | tee "${tr%.jsonl}.observed.txt"
    keep_mcp_log "$tr"; mcp_stop ;;

  4-kill-resume-mcp)
    # Kill the driver mid-turn with the tools endpoint on; session/load with a NEW server and token; call a tool.
    wt=$(new_worktree gemini-acp-4m); mcp_start gemini-acp-4m-old
    tr=$(fixture $P acp 4-kill-mcp); pidf="$SPIKE_SCRATCH/ga4m.pid"; obs="${tr%.jsonl}.observed.txt"
    old_token=$SPIKE_MCP_TOKEN; old_log=$MCP_LOG; old_pid=$MCP_PID
    acp --cwd "$wt" --transcript "$tr" --permission allow "${ACPM[@]}" --pid-file "$pidf" --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN \
      --prompt "Call the ping tool of the spike MCP server. Then run the shell command 'ping -c 90 127.0.0.1 > ping.txt' in the foreground, wait for it, then say done." \
      -- agy acp &
    kill_watch "$pidf" 'ping -c 90' "$obs"
    kill $KW_CMDS 2>/dev/null || true; kill "$KW_AGENT" 2>/dev/null || true
    kill "$old_pid" 2>/dev/null || true; cp "$old_log" "${tr%.jsonl}.mcp-log.jsonl"
    sid=$(python3 -c 'import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l)["data"]
    if isinstance(d,dict) and d.get("note")=="session": print(d["detail"]["id"]); break' "$tr")
    export OLD_SPIKE_TOKEN=$old_token SPIKE_MCP_TOKEN="spk_$(openssl rand -hex 24)"; mcp_start gemini-acp-4m-new
    tr2=$(fixture $P acp 4-resume-mcp)
    acp --cwd "$wt" --transcript "$tr2" --permission allow --resume "$sid" --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN \
      --redact-env OLD_SPIKE_TOKEN --prompt "Call the ping tool of the spike MCP server and tell me what it answered." -- agy acp
    before_curl=$(grep -c '"event":"request"' "$MCP_LOG"); ok_before=$(grep -c '"auth":"ok"' "$MCP_LOG"); wrong_before=$(grep -c '"auth":"wrong"' "$MCP_LOG" || true)
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $old_token" -H 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$MCP_URL")
    { echo "old server stopped after the kill"
      echo "new server, requests after resume and before the script's own curl: $before_curl, with the new token: $ok_before, with another token: $wrong_before"
      echo "tools/call ping after resume: $(grep -c '"tool":"ping"' "$MCP_LOG")"
      echo "the old token, sent by the script's own curl to the new server: HTTP $code (the spike server knows only the new token)"; } | tee -a "$obs"
    keep_mcp_log "$tr2"; mcp_stop ;;

  10-push-signing)
    wt=$(new_worktree gemini-acp-10s)
    tr=$(fixture $P acp 10-push-signing)
    acp --cwd "$wt" --transcript "$tr" --permission allow "${ACPM[@]}" --turn-timeout 300 \
      --prompt "Create pushed.txt containing the word pushed, commit it with the message 'spike push', and push the current branch to origin. Report each step." \
      -- agy acp
    { echo "commit: $(git -C "$wt" log -1 --format='%s / signature status %G?')"
      echo "on the remote: $(git -C "$SPIKE_SCRATCH/remote.git" rev-parse -q --verify refs/heads/spike/gemini-acp-10s >/dev/null && echo yes || echo no)"
      echo "agent commands that turn signing or hooks off: $(agent_commands "$tr" | grep -cE 'gpgsign=false|--no-gpg-sign|core\.hooksPath|--no-verify' || true)"; } | tee "${tr%.jsonl}.observed.txt" ;;

  5-mcp-workspace)
    # The token in the person's own way: a workspace .agents/mcp_config.json with a header naming nothing secret
    # is not possible, so the header holds the token; the file is in the scratch worktree only.
    wt=$(new_worktree gemini-acp-5w); mcp_start gemini-acp-5w; mkdir -p "$wt/.agents"
    printf '{"mcpServers":{"spike":{"serverUrl":"%s","headers":{"Authorization":"Bearer %s"}}}}\n' "$MCP_URL" "$SPIKE_MCP_TOKEN" > "$wt/.agents/mcp_config.json"
    tr=$(fixture $P acp 5-mcp-workspace)
    acp --cwd "$wt" --transcript "$tr" --permission allow "${ACPM[@]}" --redact-env SPIKE_MCP_TOKEN \
      --prompt "Call the ping tool of the spike MCP server and tell me what it answered (say NO SPIKE if you have no such tool)." \
      -- agy acp
    keep_mcp_log "$tr"; mcp_stop ;;

  5-hold)
    # A call held 540 s, through ACP's mcpServers (a workspace .agents/mcp_config.json is not offered to the model
    # in an untrusted workspace, see 5-mcp-workspace).
    wt=$(new_worktree gemini-acp-5h2); mcp_start gemini-acp-5h2
    tr=$(fixture $P acp 5-hold-default)
    acp --cwd "$wt" --transcript "$tr" --permission allow "${ACPM[@]}" --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN --turn-timeout 900 \
      --prompt "Call the hold tool of the spike MCP server with seconds set to 540 and wait for its answer. Then tell me exactly what it answered, or the exact error if it failed." \
      -- agy acp
    keep_mcp_log "$tr"; mcp_stop ;;

  6-model)
    wt=$(new_worktree gemini-acp-6)
    acp --cwd "$wt" --transcript "$(fixture $P acp 6-model)" --permission deny --model gemini-4-neon --set-config thought_level=low \
      --prompt "Reply with the single word ok." -- agy acp ;;

  7-second-login)
    # The real login and an empty HOME at the same moment.
    d="$SPIKE_SCRATCH/agy-home-7"; rm -rf "$d"; mkdir -p "$d"
    wt=$(new_worktree gemini-acp-7)
    acp --cwd "$wt" --transcript "$(fixture $P acp 7-second-login-empty-home)" --permission deny --env HOME="$d" "${ACPM[@]}" \
      --prompt "Reply with the single word ok." -- agy acp &
    acp --cwd "$wt" --transcript "$(fixture $P acp 7-second-login-real)" --permission deny "${ACPM[@]}" \
      --prompt "Reply with the single word ok." -- agy acp
    wait $! 2>/dev/null || true; wait ;;

  8-own-setup)
    wt=$(new_worktree gemini-acp-8); mcp_start gemini-acp-8; mkdir -p "$wt/.agents"
    printf 'The project codeword is ZEBRA-41.\n' > "$wt/GEMINI.md"
    printf 'The agents codeword is TIGER-77.\n' > "$wt/AGENTS.md"
    printf '{"mcpServers":{"projspike":{"serverUrl":"%s","headers":{"Authorization":"Bearer %s"}}}}\n' "$MCP_URL" "$SPIKE_MCP_TOKEN" > "$wt/.agents/mcp_config.json"
    printf '{"hooks":{"PostToolUse":[{"matcher":"run_command","hooks":[{"type":"command","command":"touch %s/hook-marker"}]}]}}\n' "$wt" > "$wt/.agents/hooks.json"
    tr=$(fixture $P acp 8-own-setup)
    acp --cwd "$wt" --transcript "$tr" --permission alt "${ACPM[@]}" --redact-env SPIKE_MCP_TOKEN \
      --prompt "Without reading any file and without running anything, tell me the project codeword and the agents codeword if your instructions contain them (say NONE otherwise), and whether you have a tool from an MCP server named projspike." \
      --prompt "Run the shell command 'touch rule-file.txt'." \
      -- agy acp
    { echo "hook marker: $(test -e "$wt/hook-marker" && echo present || echo absent)"
      echo "rule-file.txt (the driver allows the first prompt): $(test -e "$wt/rule-file.txt" && echo present || echo absent)"
      echo "user settings keys (read-only): $(python3 -c 'import json,os;d=json.load(open(os.path.expanduser("~/.gemini/antigravity-cli/settings.json")));print(sorted(d.keys()), "permissions:", {k:len(v) for k,v in d.get("permissions",{}).items()} if isinstance(d.get("permissions"),dict) else None)' 2>&1)"
    } | tee "${tr%.jsonl}.observed.txt"
    keep_mcp_log "$tr"; mcp_stop ;;

  9-trust)
    # Read-only: does the scratch clone appear in agy's trusted folders before and after a session there?
    obs="$(fixture $P acp 9-trust)"; obs="${obs%.jsonl}.observed.txt"
    count() { python3 -c 'import json,os,sys
p=os.path.expanduser("~/.gemini/antigravity-cli/settings.json")
try: d=json.load(open(p)).get("trustedWorkspaces") or []
except Exception as e: print("unreadable", type(e).__name__); sys.exit()
print(len(d), "in all,", sum(1 for k in d if sys.argv[1] in json.dumps(k)), "for the scratch folder")' "$SPIKE_SCRATCH"; }
    echo "trustedWorkspaces in ~/.gemini/antigravity-cli/settings.json before: $(count)" | tee "$obs"
    wt=$(new_worktree gemini-acp-9)
    acp --cwd "$wt" --transcript "$(fixture $P acp 9-trust)" --permission allow "${ACPM[@]}" \
      --prompt "Run the shell command 'pwd' and reply with its output only." -- agy acp
    echo "after: $(count)" | tee -a "$obs" ;;

  10-push)
    wt=$(new_worktree gemini-acp-10)
    acp --cwd "$wt" --transcript "$(fixture $P acp 10-push)" --permission allow "${ACPM[@]}" \
      --prompt "Create pushed.txt containing the word pushed, commit it with the message 'spike push', and push the current branch to origin. Report the push output." \
      -- agy acp
    git -C "$SPIKE_SCRATCH/remote.git" log --oneline -1 spike/gemini-acp-10 || echo "nothing pushed" ;;

  11-locked)
    # agy has no flag that removes its built-in tools. The closest: a workspace agent with an empty tool list,
    # chosen with --agent, and the spike server as the only MCP server.
    wt=$(new_worktree gemini-acp-11); mcp_start gemini-acp-11; mkdir -p "$wt/.agents/agents"
    printf -- '---\nname: locked\ndescription: Answers with the spike tools only.\ntools: []\nmainAgent: true\nsubagent: false\n---\nYou answer questions. You have no file, shell or web tools.\n' > "$wt/.agents/agents/locked.md"
    tr=$(fixture $P acp 11-locked)
    acp --cwd "$wt" --transcript "$tr" --permission allow "${ACPM[@]}" --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN \
      --prompt "Read the file README.md and quote it." \
      --prompt "Run the shell command 'echo hi > ran.txt' and tell me the result." \
      --prompt "Fetch https://example.com and tell me its title." \
      --prompt "List every tool you have, by exact name, one per line." \
      -- agy acp --agent locked
    echo "ran.txt: $(test -e "$wt/ran.txt" && echo present || echo absent)" | tee "${tr%.jsonl}.observed.txt"
    keep_mcp_log "$tr"; mcp_stop ;;

  13-agent)
    wt=$(new_worktree gemini-acp-13); mkdir -p "$wt/.agents/agents"
    printf -- '---\nname: reader\ndescription: Reads files only.\ntools:\n  - view_file\n  - grep_search\nmainAgent: true\nsubagent: false\n---\nYou read files and answer questions about them.\n' > "$wt/.agents/agents/reader.md"
    acp --cwd "$wt" --transcript "$(fixture $P acp 13-agent)" --permission allow "${ACPM[@]}" \
      --prompt "Run the shell command 'echo hi > ran.txt'. If you cannot, say NO SHELL and list your tools by exact name." \
      -- agy acp --agent reader
    ls "$wt" ;;

  1-print)
    # The stream-json path: edit and run, with no one to answer a permission (headless soft-denies).
    wt=$(new_worktree gemini-print-1)
    "$SPIKE" agy-stream --cwd "$wt" --transcript "$(fixture $P print 1-edit-run)" --turn-timeout 300 \
      --prompt "Create a file named note.txt containing the single word hello. Then run the shell command 'ls' and tell me its output in one short sentence." \
      --prompt "What file did you just create? One sentence." \
      -- agy --input-format stream-json --output-format stream-json --model "$MODEL"
    ls "$wt" ;;

  3-print-cancel)
    wt=$(new_worktree gemini-print-3)
    "$SPIKE" agy-stream --cwd "$wt" --transcript "$(fixture $P print 3-cancel)" --cancel-after 15 --turn-timeout 120 \
      --prompt "Run the shell command 'ping -c 40 127.0.0.1 > ping.txt' and wait for it to finish." \
      --prompt "Reply with the single word ready." \
      -- agy --input-format stream-json --output-format stream-json --model "$MODEL" --mode auto ;;

  11-print-locked)
    # The stream-json init event lists the session's tools: the default set, then a workspace agent with none.
    wt=$(new_worktree gemini-print-11); mkdir -p "$wt/.agents/agents"
    printf -- '---\nname: locked\ndescription: Answers questions only.\ntools: []\nmainAgent: true\nsubagent: false\n---\nYou answer questions. You have no file, shell or web tools.\n' > "$wt/.agents/agents/locked.md"
    "$SPIKE" agy-stream --cwd "$wt" --transcript "$(fixture $P print 11-locked)" --turn-timeout 120 \
      --prompt "Run the shell command 'echo hi > ran.txt' and tell me the result." \
      --prompt "Read the file README.md and quote it." \
      -- agy --input-format stream-json --output-format stream-json --model "$MODEL" --agent locked
    echo "ran.txt: $(test -e "$wt/ran.txt" && echo present || echo absent)" | tee "$(fixture $P print 11-locked | sed 's/.jsonl$/.observed.txt/')" ;;

  15-no-tty-signed-in)
    wt=$(new_worktree gemini-print-15s)
    obs="$(fixture $P print 15-no-tty-signed-in)"; obs="${obs%.jsonl}.observed.txt"
    start=$(date +%s)
    (cd "$wt" && agy -p "Reply with the single word ok." --model "$MODEL" </dev/null > "$SPIKE_SCRATCH/agy-15s.out" 2> "$SPIKE_SCRATCH/agy-15s.err" & echo $! > "$SPIKE_SCRATCH/agy-15s.pid"; wait) &
    for _ in $(seq 120); do sleep 1; kill -0 "$(cat "$SPIKE_SCRATCH/agy-15s.pid")" 2>/dev/null || break; done
    alive=$(kill -0 "$(cat "$SPIKE_SCRATCH/agy-15s.pid")" 2>/dev/null && echo yes || echo no)
    [ "$alive" = yes ] && kill "$(cat "$SPIKE_SCRATCH/agy-15s.pid")"
    { echo "ran for about $(( $(date +%s) - start )) s; still running at the end: $alive"
      echo "stdout: $(head -c 300 "$SPIKE_SCRATCH/agy-15s.out")"
      echo "stderr: $(head -c 300 "$SPIKE_SCRATCH/agy-15s.err")"; } | sed "s#$HOME#\$HOME#g" | tee "$obs" ;;


  r1-two-servers|r1-collision)
    # R1: a per-session endpoint name of letters and digits only, a second server, and a pair of names that collide
    # once joined with underscores (server a_b with tool c, server a with tool b_c).
    wt=$(new_worktree "gemini-acp-$1"); tr=$(fixture $P acp "$1"); obs="${tr%.jsonl}.observed.txt"
    if [ "$1" = r1-two-servers ]; then
      own="spk$(rand_name)"; other="spkx$(rand_name)"
      mcp_start "ga-$1-own"; own_url=$MCP_URL; mcp_start "ga-$1-other"; other_url=$MCP_URL
      prompt="Call the ping tool of the $own MCP server, then the ping tool of the $other MCP server. Report both answers."
    else
      own="spka_b"; other="spka"
      mcp_start "ga-$1-own" --extra-tool c; own_url=$MCP_URL; mcp_start "ga-$1-other" --extra-tool b_c; other_url=$MCP_URL
      prompt="Call the tool c of the spka_b server and the tool b_c of the spka server, and report both answers."
    fi
    acp --cwd "$wt" --transcript "$tr" --permission allow "${ACPM[@]}" --mcp-token-env SPIKE_MCP_TOKEN \
      --mcp-server "$own=$own_url" --mcp-server "$other=$other_url" --prompt "$prompt" -- agy acp
    { echo "own endpoint: $own; other server: $other"
      echo "permission requests (the driver allowed each):"; permission_requests "$tr"
      echo "tool_call names: $(python3 -c 'import json,sys
seen=[]
for l in open(sys.argv[1]):
    d=json.loads(l)["data"]
    u=((d.get("params") or {}).get("update") or {}) if isinstance(d,dict) else {}
    if u.get("sessionUpdate")=="tool_call": seen.append(str(u.get("name")))
print(" ".join(seen))' "$tr")"; } | tee "$obs" ;;

  r2-ask)
    # R2: ask returns "question pending, end your turn" after 20 s; the answer comes as the next prompt.
    wt=$(new_worktree gemini-acp-r2); mcp_start ga-r2 --ask-after 20
    tr=$(fixture $P acp r2-ask)
    acp --cwd "$wt" --transcript "$tr" --permission allow "${ACPM[@]}" --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN \
      --prompt "$ASK_PROMPT" --prompt "$ANSWER_PROMPT" -- agy acp
    ask_report "$tr" "$wt" | tee "${tr%.jsonl}.observed.txt"; keep_mcp_log "$tr"; mcp_stop ;;

  r7-background)
    # Verify major 3: a turn that ends while its command still runs, then 60 s idle: does agy start a turn by itself?
    wt=$(new_worktree gemini-acp-r7); tr=$(fixture $P acp r7-background)
    acp --cwd "$wt" --transcript "$tr" --permission allow "${ACPM[@]}" --keep-open 60 \
      --prompt "Run the shell command 'ping -c 30 127.0.0.1 > ping.txt'." -- agy acp
    # From the driver's own notes and what agy sent after the turn ended, with no prompt.
    python3 - "$tr" <<'PY' | tee "${tr%.jsonl}.observed.txt"
import json, sys
end = None; after = []
for l in open(sys.argv[1]):
    e = json.loads(l); d = e["data"]
    if not isinstance(d, dict): continue
    if e["dir"] == "driver" and d.get("note") == "turn_end":
        end = e["ms"]; print("turn ended (end_turn) at %d ms" % e["ms"])
    if e["dir"] == "driver" and d.get("note") == "processes":
        print("%d ms %s: agy's descendants %s" % (e["ms"], d["detail"]["when"], [x["comm"].split("/")[-1] for x in d["detail"]["descendants"]]))
    if end and e["dir"] == "from_agent" and d.get("method") == "session/update":
        u = (d.get("params") or {}).get("update")
        k = u.get("sessionUpdate") if isinstance(u, dict) else None
        if k in ("tool_call_update", "agent_message_chunk") and (not after or after[-1] != k):
            print("%d ms, with no prompt sent: %s" % (e["ms"], k)); after.append(k)
PY
    echo "ping.txt lines: $(wc -l < "$wt/ping.txt" 2>/dev/null || echo none)" | tee -a "${tr%.jsonl}.observed.txt" ;;

  *)
    if ! signed_in; then echo "blocked: agy is not signed in (run agy once to sign in)"; exit 3; fi
    echo "unknown check $1" >&2; exit 2 ;;
esac
