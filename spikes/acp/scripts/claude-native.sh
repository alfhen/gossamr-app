#!/usr/bin/env bash
# Claude, native path: claude -p with stream-json both ways and the SDK control protocol.
# Usage: bash scripts/claude-native.sh <check>   (see README.md for the list)
source "$(dirname "$0")/env.sh"

P=claude; W=native
MODEL=${CLAUDE_MODEL:-haiku}
BASE=(claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
      --permission-prompt-tool stdio --model "$MODEL")

drive() { "$SPIKE" claude "$@"; }

# The token is named, not included: claude expands ${VAR} in header values from its own environment.
mcp_config() { # URL [TIMEOUT_MS]
  local t=""; [ -n "${2:-}" ] && t=", \"timeout\": $2"
  printf '{"mcpServers":{"spike":{"type":"http","url":"%s","headers":{"Authorization":"Bearer ${SPIKE_MCP_TOKEN}"}%s}}}' "$1" "$t"
}

case "${1:?check}" in
  1-edit-run)
    wt=$(new_worktree claude-native-1)
    drive --cwd "$wt" --transcript "$(fixture $P $W 1-edit-run)" --permission allow \
      --prompt "Create a file named note.txt containing the single word hello. Then run the shell command 'ls' and tell me its output in one short sentence." \
      -- "${BASE[@]}" --permission-mode manual
    ls "$wt"; cat "$wt/note.txt" ;;

  2-permission)
    wt=$(new_worktree claude-native-2)
    drive --cwd "$wt" --transcript "$(fixture $P $W 2-permission)" --permission alt \
      --prompt "Run the shell command 'echo one > a.txt'. Then, as a separate command, run 'echo two > b.txt'. Then read README.md and say how many lines it has. Report what happened to each step." \
      -- "${BASE[@]}" --permission-mode manual
    ls "$wt" ;;

  2-permission-default-mode)
    # The person's own mode: no --permission-mode at all.
    wt=$(new_worktree claude-native-2d)
    drive --cwd "$wt" --transcript "$(fixture $P $W 2-permission-default-mode)" --permission alt \
      --prompt "Run the shell command 'echo one > a.txt'. Then create b.txt containing two with your file-writing tool. Report what happened." \
      -- "${BASE[@]}"
    ls "$wt" ;;

  3-cancel)
    wt=$(new_worktree claude-native-3)
    # Claude moves a long command to a background task by itself, and blocks a foreground `sleep N`, so: ping.
    drive --cwd "$wt" --transcript "$(fixture $P $W 3-cancel)" --permission allow --cancel-after 12 \
      --prompt "Run the shell command 'ping -c 40 127.0.0.1 > ping.txt' in the foreground (not in the background, timeout 120000) and wait for it to finish." \
      --prompt "Reply with the single word ready." \
      -- "${BASE[@]}" --permission-mode manual
    ls "$wt"; pids_matching 'ping -c 40' ;;

  3-background-exit)
    # A command the agent put in the background, then stdin closed: does claude exit?
    wt=$(new_worktree claude-native-3b)
    drive --cwd "$wt" --transcript "$(fixture $P $W 3-background-exit)" --permission allow --exit-wait 20 \
      --prompt "Run the shell command 'sleep 60; echo slept > slept.txt' in the background and tell me when you started it." \
      -- "${BASE[@]}" --permission-mode manual
    pids_matching 'sleep 60' ;;

  4-kill-resume)
    # kill_watch writes what it saw to 4-kill.observed.txt.
    wt=$(new_worktree claude-native-4)
    tr=$(fixture $P $W 4-kill); pidf="$SPIKE_SCRATCH/claude-native-4.pid"
    drive --cwd "$wt" --transcript "$tr" --permission allow --pid-file "$pidf" \
      --prompt "Run the shell command 'ping -c 90 127.0.0.1 > ping.txt' in the foreground (not in the background, timeout 200000), wait for it, then say done." \
      -- "${BASE[@]}" --permission-mode manual &
    kill_watch "$pidf" 'ping -c 90' "${tr%.jsonl}.observed.txt"
    pkill -f '^ping -c 90' || true
    kill "$KW_AGENT" 2>/dev/null || true
    sid=$(python3 -c 'import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l)["data"]
    if isinstance(d,dict) and d.get("session_id"): print(d["session_id"]); break' "$tr")
    echo "ping.txt lines: $(wc -l < "$wt/ping.txt" 2>/dev/null || echo none)" | tee -a "${tr%.jsonl}.observed.txt"
    drive --cwd "$wt" --transcript "$(fixture $P $W 4-resume)" --permission allow \
      --prompt "What exactly did I ask you to do in my previous message, and did the command finish? Answer in two short sentences." \
      -- "${BASE[@]}" --permission-mode manual --resume "$sid" ;;

  5-mcp)
    wt=$(new_worktree claude-native-5); mcp_start claude-native-5
    tr=$(fixture $P $W 5-mcp)
    drive --cwd "$wt" --transcript "$tr" --permission allow --mcp-token-env SPIKE_MCP_TOKEN \
      --prompt "Call the ping tool of the spike MCP server and tell me what it answered. Then run the shell command 'printenv SPIKE_MCP_TOKEN | wc -c' and tell me the number it printed (never print the variable itself)." \
      -- "${BASE[@]}" --permission-mode manual --mcp-config "$(mcp_config "$MCP_URL")"
    echo "files under ~/.claude/projects holding the token: $(token_files "$HOME/.claude/projects")" | tee "${tr%.jsonl}.observed.txt"
    keep_mcp_log "$tr"; mcp_stop ;;

  5-hold-default|5-hold-600)
    # A tool call the server holds for 540 s (9 minutes). Run both in the background; each takes about 10 minutes.
    wt=$(new_worktree "claude-native-$1"); mcp_start "claude-native-$1"
    timeout=""; [ "$1" = 5-hold-600 ] && timeout=600000
    tr=$(fixture $P $W "$1")
    drive --cwd "$wt" --transcript "$tr" --permission allow --turn-timeout 900 \
      --prompt "Call the hold tool of the spike MCP server with seconds set to 540 and wait for its answer. Then tell me exactly what it answered, or the exact error if it failed." \
      -- "${BASE[@]}" --permission-mode manual --allowedTools mcp__spike__hold --mcp-config "$(mcp_config "$MCP_URL" $timeout)"
    keep_mcp_log "$tr"; mcp_stop ;;

  6-model)
    # Model and effort per session; the models come from the initialize answer.
    wt=$(new_worktree claude-native-6)
    drive --cwd "$wt" --transcript "$(fixture $P $W 6-model)" --permission deny \
      --prompt "Reply with the single word ok." \
      -- claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio \
         --model sonnet --effort low ;;

  7-second-login)
    # An empty scratch config folder beside the real login, at the same time.
    empty="$SPIKE_SCRATCH/claude-config-empty"; mkdir -p "$empty"
    obs="$(fixture $P $W 7-second-login)"; obs="${obs%.jsonl}.observed.txt"
    { echo "empty CLAUDE_CONFIG_DIR: $(CLAUDE_CONFIG_DIR="$empty" claude auth status --json </dev/null 2>&1 | python3 -c 'import json,sys;d=json.load(sys.stdin);print({k:d.get(k) for k in ("loggedIn","authMethod")})'; echo "exit ${PIPESTATUS[0]}")"
      echo "real login (variable unset): $(env -u CLAUDE_CONFIG_DIR claude auth status --json </dev/null 2>&1 | python3 -c 'import json,sys;d=json.load(sys.stdin);print({k:d.get(k) for k in ("loggedIn","authMethod")})')"
    } | tee "$obs"
    wt=$(new_worktree claude-native-7)
    drive --cwd "$wt" --transcript "$(fixture $P $W 7-second-login)" --permission deny --env CLAUDE_CONFIG_DIR="$empty" \
      --prompt "Reply with the single word ok." -- "${BASE[@]}" &
    drive --cwd "$wt" --transcript "$(fixture $P $W 7-real-login-same-time)" --permission deny \
      --prompt "Reply with the single word ok." -- "${BASE[@]}"
    wait
    echo "files the empty folder gained: $(cd "$empty" && find . -type f | sort | tr '\n' ' ')" | tee -a "$obs" ;;

  8-own-setup|8-own-setup-trusted)
    # Project-level setup in the worktree: settings with an allow rule and a hook, .mcp.json, CLAUDE.md, AGENTS.md.
    if [ "$1" = 8-own-setup-trusted ]; then
      # A folder inside this repo's own worktree, which the owner's login already trusts (target/ is ignored by git).
      wt="$SPIKE_DIR/target/trusted-probe"; rm -rf "$wt"; mkdir -p "$wt"
    else
      wt=$(new_worktree claude-native-8)
    fi
    mcp_start "claude-native-$1"
    mkdir -p "$wt/.claude"
    cat > "$wt/.claude/settings.json" <<JSON
{ "permissions": { "allow": ["Bash(touch rule-file.txt)"] },
  "hooks": { "PostToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "touch \"\$CLAUDE_PROJECT_DIR/hook-marker\"" } ] } ] } }
JSON
    printf '{"mcpServers":{"projspike":{"type":"http","url":"%s","headers":{"Authorization":"Bearer ${SPIKE_MCP_TOKEN}"}}}}\n' "$MCP_URL" > "$wt/.mcp.json"
    printf 'The project codeword is ZEBRA-41.\n' > "$wt/CLAUDE.md"
    printf 'The agents codeword is TIGER-77.\n' > "$wt/AGENTS.md"
    tr=$(fixture $P $W "$1")
    drive --cwd "$wt" --transcript "$tr" --permission deny \
      --prompt "Without reading any file, tell me the project codeword and the agents codeword if your instructions contain them (say NONE otherwise). Then run the shell command 'touch rule-file.txt'. Then call the ping tool of the projspike MCP server if you have it, otherwise say NO PROJSPIKE. Report each step." \
      -- "${BASE[@]}" --permission-mode manual
    { echo "hook marker: $(test -e "$wt/hook-marker" && echo present || echo absent)"
      echo "rule-file.txt (allow rule; the driver denies every prompt): $(test -e "$wt/rule-file.txt" && echo present || echo absent)"; } | tee "${tr%.jsonl}.observed.txt"
    keep_mcp_log "$tr"; mcp_stop ;;

  9-trust-scratch-login)
    # Trust lives in the login's .claude.json. With a scratch login (signed out), does a trust entry silence the warning?
    for trusted in no yes; do
      cfg="$SPIKE_SCRATCH/claude-config-trust-$trusted"; rm -rf "$cfg"; mkdir -p "$cfg"
      wt=$(new_worktree claude-native-9s); mkdir -p "$wt/.claude"
      printf '{"permissions":{"allow":["Bash(touch x)"]}}\n' > "$wt/.claude/settings.json"
      [ $trusted = yes ] && printf '{"projects":{"%s":{"hasTrustDialogAccepted":true}}}\n' "$SPIKE_SCRATCH/clone" > "$cfg/.claude.json"
      drive --cwd "$wt" --transcript "$(fixture $P $W 9-trust-scratch-login-$trusted)" --permission deny --env CLAUDE_CONFIG_DIR="$cfg" \
        --prompt "Reply ok." -- "${BASE[@]}"
    done ;;

  9-trust)
    # A worktree of a folder this login never trusted. -p skips the trust question (claude --help).
    wt=$(new_worktree claude-native-9)
    obs="$(fixture $P $W 9-trust)"; obs="${obs%.jsonl}.observed.txt"
    echo "trusted entry for the clone in ~/.claude.json before: $(python3 -c 'import json,os,sys;d=json.load(open(os.path.expanduser("~/.claude.json")));p=d.get("projects",{});print(any(k.startswith(sys.argv[1]) and v.get("hasTrustDialogAccepted") for k,v in p.items()))' "$SPIKE_SCRATCH")" | tee "$obs"
    drive --cwd "$wt" --transcript "$(fixture $P $W 9-trust)" --permission allow \
      --prompt "Run the shell command 'pwd' and reply with its output only." -- "${BASE[@]}" --permission-mode manual
    echo "after: $(python3 -c 'import json,os,sys;d=json.load(open(os.path.expanduser("~/.claude.json")));p=d.get("projects",{});print({k.replace(sys.argv[1],"$SCRATCH"):v.get("hasTrustDialogAccepted") for k,v in p.items() if k.startswith(sys.argv[1])})' "$SPIKE_SCRATCH")" | tee -a "$obs" ;;

  10-push)
    wt=$(new_worktree claude-native-10)
    drive --cwd "$wt" --transcript "$(fixture $P $W 10-push)" --permission allow \
      --prompt "Create pushed.txt containing the word pushed, commit it with the message 'spike push', and push the current branch to origin. Report the push output." \
      -- "${BASE[@]}" --permission-mode manual
    git -C "$SPIKE_SCRATCH/remote.git" log --oneline -1 spike/claude-native-10 | tee "${wt}.push.txt" ;;

  11-locked)
    # Today's Pip flags (src-tauri/src/claude/mod.rs, args()), with the spike server in place of Gossamr's.
    wt=$(new_worktree claude-native-11); mcp_start claude-native-11
    cfg=$(printf '{"mcpServers":{"gossamr":{"type":"http","url":"%s","headers":{"Authorization":"Bearer ${SPIKE_MCP_TOKEN}"}}}}' "$MCP_URL")
    tr=$(fixture $P $W 11-locked)
    drive --cwd "$wt" --transcript "$tr" --permission allow --env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
      --prompt "Read the file README.md and quote it." \
      --prompt "Run the shell command 'echo hi > ran.txt' and tell me the result." \
      --prompt "Fetch https://example.com and tell me its title." \
      --prompt "List every tool you have, by exact name, one per line." \
      -- claude -p --output-format stream-json --verbose --include-partial-messages --input-format stream-json \
         --model "$MODEL" --permission-mode dontAsk --tools "" --allowedTools mcp__gossamr \
         --setting-sources "" --disable-slash-commands --strict-mcp-config --mcp-config "$cfg" \
         --append-system-prompt "You are a test assistant."
    echo "ran.txt: $(ls "$wt/ran.txt" 2>/dev/null || echo absent)" | tee "${tr%.jsonl}.observed.txt"
    keep_mcp_log "$tr"; mcp_stop ;;

  11-locked-plus)
    # The same with --permission-prompt-tool stdio: does a host change anything?
    wt=$(new_worktree claude-native-11p); mcp_start claude-native-11p
    cfg=$(printf '{"mcpServers":{"gossamr":{"type":"http","url":"%s","headers":{"Authorization":"Bearer ${SPIKE_MCP_TOKEN}"}}}}' "$MCP_URL")
    drive --cwd "$wt" --transcript "$(fixture $P $W 11-locked-with-host)" --permission allow --env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
      --prompt "Run the shell command 'echo hi > ran.txt' and tell me the result." \
      -- claude -p --output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio \
         --model "$MODEL" --permission-mode dontAsk --tools "" --allowedTools mcp__gossamr \
         --setting-sources "" --disable-slash-commands --strict-mcp-config --mcp-config "$cfg"
    ls "$wt"; mcp_stop ;;

  13-agent)
    # An agent definition in the project that limits tools, chosen with --agent.
    wt=$(new_worktree claude-native-13); mkdir -p "$wt/.claude/agents"
    cat > "$wt/.claude/agents/limited.md" <<'MD'
---
name: limited
description: Reads files only.
tools: Read, Grep, Glob
---
You read files and answer questions about them. You have no other tools.
MD
    drive --cwd "$wt" --transcript "$(fixture $P $W 13-agent)" --permission allow \
      --prompt "Run the shell command 'echo hi > ran.txt'. If you cannot, say NO SHELL and list your tools by exact name." \
      -- "${BASE[@]}" --permission-mode manual --agent limited
    ls "$wt" ;;

  14-workflow)
    # The person's normal login: is the Workflow tool there, and does the pr-pipeline skill load? List only.
    wt=$(new_worktree claude-native-14)
    drive --cwd "$wt" --transcript "$(fixture $P $W 14-workflow)" --permission allow \
      --prompt "Load the skill agent-pr-pipeline:pr-pipeline with the Skill tool. Do not follow it and do not run anything. Reply with: its first heading, whether you have a tool named Workflow, and the subagent types whose names start with agent-pr-pipeline that you could start." \
      -- "${BASE[@]}" --permission-mode manual ;;

  5-mcp-control)
    # The tools endpoint by the mcp_set_servers control request on stdin: header and timeout in the request,
    # the token in no argv and not in claude's environment. --allowedTools names the endpoint's tool.
    wt=$(new_worktree claude-native-5c); mcp_start claude-native-5c
    tr=$(fixture $P $W 5-mcp-control); obs="${tr%.jsonl}.observed.txt"
    drive --cwd "$wt" --transcript "$tr" --permission allow --pid-file "$SPIKE_SCRATCH/cn5c.pid" \
      --mcp-via-control --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN --mcp-tool-timeout 600 \
      --prompt "Call the ping tool of the spike MCP server and tell me what it answered. Then run the shell command 'printenv SPIKE_MCP_TOKEN | wc -c' and tell me the number it printed (never print the variable itself)." \
      -- "${BASE[@]}" --permission-mode manual --allowedTools mcp__spike__ping & dpid=$!
    hits=0; for _ in $(seq 20); do n=$(ps -axww -o command= | grep -cF -- "$SPIKE_MCP_TOKEN" || true); hits=$((hits + n - 1)); sleep 1; done
    wait $dpid || true
    { echo "argv samples holding the token (20 samples, 1 s apart, minus the grep itself): $hits"
      echo "files under ~/.claude/projects holding the token: $(token_files "$HOME/.claude/projects")"
      echo "can_use_tool requests for mcp__spike__ping: $(python3 -c 'import json,sys
print(sum(1 for l in open(sys.argv[1]) if (d:=json.loads(l)["data"]) and isinstance(d,dict) and d.get("type")=="control_request" and d["request"].get("subtype")=="can_use_tool" and d["request"].get("tool_name")=="mcp__spike__ping"))' "$tr")"; } | tee "$obs"
    keep_mcp_log "$tr"; mcp_stop ;;

  5-hold-control)
    # A call held 75 s (past the 60 s default) with the timeout given in the control request.
    wt=$(new_worktree claude-native-5hc); mcp_start claude-native-5hc
    tr=$(fixture $P $W 5-hold-control)
    drive --cwd "$wt" --transcript "$tr" --permission allow --turn-timeout 300 \
      --mcp-via-control --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN --mcp-tool-timeout 600 \
      --prompt "Call the hold tool of the spike MCP server with seconds set to 75 and wait for its answer. Then tell me exactly what it answered, or the exact error if it failed." \
      -- "${BASE[@]}" --permission-mode manual --allowedTools mcp__spike__hold
    keep_mcp_log "$tr"; mcp_stop ;;

  4-kill-resume-mcp)
    # Kill the driver mid-turn with the tools endpoint on; resume with a NEW server and token; call a tool.
    wt=$(new_worktree claude-native-4m); mcp_start claude-native-4m-old
    tr=$(fixture $P $W 4-kill-mcp); pidf="$SPIKE_SCRATCH/cn4m.pid"; obs="${tr%.jsonl}.observed.txt"
    old_token=$SPIKE_MCP_TOKEN; old_url=$MCP_URL; old_log=$MCP_LOG; old_pid=$MCP_PID
    drive --cwd "$wt" --transcript "$tr" --permission allow --pid-file "$pidf" \
      --mcp-via-control --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN --mcp-tool-timeout 600 \
      --prompt "Call the ping tool of the spike MCP server. Then run the shell command 'ping -c 90 127.0.0.1 > ping.txt' in the foreground (not in the background, timeout 200000), wait for it, then say done." \
      -- "${BASE[@]}" --permission-mode manual --allowedTools mcp__spike__ping &
    kill_watch "$pidf" 'ping -c 90' "$obs"
    kill $KW_CMDS 2>/dev/null || true; kill "$KW_AGENT" 2>/dev/null || true
    kill "$old_pid" 2>/dev/null || true; cp "$old_log" "${tr%.jsonl}.mcp-log.jsonl"
    sid=$(python3 -c 'import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l)["data"]
    if isinstance(d,dict) and d.get("session_id"): print(d["session_id"]); break' "$tr")
    export OLD_SPIKE_TOKEN=$old_token SPIKE_MCP_TOKEN="spk_$(openssl rand -hex 24)"; mcp_start claude-native-4m-new
    tr2=$(fixture $P $W 4-resume-mcp)
    drive --cwd "$wt" --transcript "$tr2" --permission allow --redact-env OLD_SPIKE_TOKEN \
      --mcp-via-control --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN --mcp-tool-timeout 600 \
      --prompt "Call the ping tool of the spike MCP server and tell me what it answered." \
      -- "${BASE[@]}" --permission-mode manual --allowedTools mcp__spike__ping --resume "$sid"
    before_curl=$(grep -c '"event":"request"' "$MCP_LOG"); ok_before=$(grep -c '"auth":"ok"' "$MCP_LOG"); wrong_before=$(grep -c '"auth":"wrong"' "$MCP_LOG" || true)
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $old_token" -H 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$MCP_URL")
    { echo "old server stopped after the kill; requests it got: $(grep -c '"event":"request"' "${tr%.jsonl}.mcp-log.jsonl")"
      echo "new server, requests after resume and before the script's own curl: $before_curl, with the new token: $ok_before, with another token: $wrong_before"
      echo "tools/call ping after resume: $(grep -c '"tool":"ping"' "$MCP_LOG")"
      echo "the old token, sent by the script's own curl to the new server: HTTP $code (the spike server knows only the new token)"; } | tee -a "$obs"
    keep_mcp_log "$tr2"; mcp_stop ;;

  8-settings-rules)
    # The person's own allow and deny rules beside --permission-prompt-tool stdio, through a check-only --settings
    # file. The driver denies anything that still asks.
    wt=$(new_worktree claude-native-8s)
    printf '{"permissions":{"allow":["Bash(touch allowed.txt)"],"deny":["Bash(touch denied.txt)"]}}\n' > "$SPIKE_SCRATCH/rules.json"
    tr=$(fixture $P $W 8-settings-rules)
    drive --cwd "$wt" --transcript "$tr" --permission deny \
      --prompt "Run these three shell commands one at a time, as three separate tool calls: 'touch allowed.txt', then 'touch denied.txt', then 'touch neither.txt'. Report what happened to each." \
      -- "${BASE[@]}" --permission-mode manual --settings "$SPIKE_SCRATCH/rules.json"
    { for f in allowed denied neither; do echo "$f.txt: $(test -e "$wt/$f.txt" && echo present || echo absent)"; done
      echo "can_use_tool requests: $(grep -c '"subtype":"can_use_tool"' "$tr" || true), for: $(grep -o '"command":"touch [a-z]*.txt"' "$tr" | sort -u | tr '\n' ' ')"; } | tee "${tr%.jsonl}.observed.txt" ;;

  10-push-signing)
    # The push again, recording whether the commit is signed and whether the agent stepped around signing or hooks.
    wt=$(new_worktree claude-native-10s)
    tr=$(fixture $P $W 10-push-signing)
    drive --cwd "$wt" --transcript "$tr" --permission allow --turn-timeout 300 \
      --prompt "Create pushed.txt containing the word pushed, commit it with the message 'spike push', and push the current branch to origin. Report each step." \
      -- "${BASE[@]}" --permission-mode manual
    { echo "commit: $(git -C "$wt" log -1 --format='%s / signature status %G?')"
      echo "on the remote: $(git -C "$SPIKE_SCRATCH/remote.git" rev-parse -q --verify refs/heads/spike/claude-native-10s >/dev/null && echo yes || echo no)"
      echo "agent commands that turn signing or hooks off: $(agent_commands "$tr" | grep -cE 'gpgsign=false|--no-gpg-sign|core\.hooksPath|--no-verify' || true)"; } | tee "${tr%.jsonl}.observed.txt" ;;

  11-locked-with-host)
    # Pip's flags plus --permission-prompt-tool stdio, the chosen base.
    wt=$(new_worktree claude-native-11h); mcp_start claude-native-11h
    cfg=$(printf '{"mcpServers":{"gossamr":{"type":"http","url":"%s","headers":{"Authorization":"Bearer ${SPIKE_MCP_TOKEN}"}}}}' "$MCP_URL")
    tr=$(fixture $P $W 11-locked-with-host)
    drive --cwd "$wt" --transcript "$tr" --permission allow --env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
      --prompt "Read the file README.md and quote it." \
      --prompt "Run the shell command 'echo hi > ran.txt' and tell me the result." \
      --prompt "Fetch https://example.com and tell me its title." \
      -- claude -p --output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio \
         --model "$MODEL" --permission-mode dontAsk --tools "" --allowedTools mcp__gossamr \
         --setting-sources "" --disable-slash-commands --strict-mcp-config --mcp-config "$cfg" \
         --append-system-prompt "You are a test assistant."
    echo "ran.txt: $(test -e "$wt/ran.txt" && echo present || echo absent)" | tee "${tr%.jsonl}.observed.txt"
    keep_mcp_log "$tr"; mcp_stop ;;

  14-workflow-run)
    # One tiny workflow (one agent, one line) in a native session: does its completion reach the stream, and when
    # does the process exit?
    wt=$(new_worktree claude-native-14r)
    tr=$(fixture $P $W 14-workflow-run)
    drive --cwd "$wt" --transcript "$tr" --permission allow --turn-timeout 300 --keep-open 120 --exit-wait 60 \
      --prompt "Run a workflow with the Workflow tool: a script with one agent() call whose prompt is 'Reply with the single word pong.' and that returns the agent's answer. Then tell me what it returned." \
      -- "${BASE[@]}" --permission-mode manual ;;


  r1-two-servers|r1-collision)
    # R1: a per-session endpoint name of letters and digits only, a second server, and a pair of names that collide
    # once joined with underscores (server a_b with tool c, server a with tool b_c).
    wt=$(new_worktree "claude-native-$1"); tr=$(fixture $P $W "$1"); obs="${tr%.jsonl}.observed.txt"
    if [ "$1" = r1-two-servers ]; then
      own="spk$(rand_name)"; other="spkx$(rand_name)"
      mcp_start "cn-$1-own"; own_url=$MCP_URL; mcp_start "cn-$1-other"; other_url=$MCP_URL
      prompt="Call the ping tool of the $own MCP server, then the ping tool of the $other MCP server. Report both answers."
      allowed="mcp__${own}__ping"
    else
      own="spka_b"; other="spka"
      mcp_start "cn-$1-own" --extra-tool c; own_url=$MCP_URL; mcp_start "cn-$1-other" --extra-tool b_c; other_url=$MCP_URL
      prompt="Call the tool c of the spka_b server and the tool b_c of the spka server, and report both answers."
      allowed="mcp__spka_b__c"
    fi
    drive --cwd "$wt" --transcript "$tr" --permission allow --mcp-via-control --mcp-token-env SPIKE_MCP_TOKEN \
      --mcp-server "$own=$own_url" --mcp-server "$other=$other_url" --prompt "$prompt" \
      -- "${BASE[@]}" --permission-mode manual --allowedTools "$allowed"
    { echo "own endpoint: $own (pre-allowed: $allowed); other server: $other"
      echo "init tools from MCP servers: $(python3 -c 'import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l)["data"]
    if isinstance(d,dict) and d.get("subtype")=="init": print(" ".join(t for t in d["tools"] if t.startswith("mcp__"))); break' "$tr")"
      echo "permission requests:"; permission_requests "$tr"; } | tee "$obs" ;;

  r2-ask)
    # R2: the endpoint's ask returns "question pending, end your turn" after 20 s; the answer comes as the next prompt.
    wt=$(new_worktree claude-native-r2); mcp_start cn-r2 --ask-after 20
    tr=$(fixture $P $W r2-ask); obs="${tr%.jsonl}.observed.txt"
    drive --cwd "$wt" --transcript "$tr" --permission allow --mcp-via-control --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN --mcp-tool-timeout 600 \
      --prompt "$ASK_PROMPT" --prompt "$ANSWER_PROMPT" \
      -- "${BASE[@]}" --permission-mode manual --allowedTools mcp__spike__ask
    ask_report "$tr" "$wt" | tee "$obs"; keep_mcp_log "$tr"; mcp_stop ;;

  r4-locked-control)
    # R4: the locked flags with the endpoint added by the control request instead of --mcp-config.
    wt=$(new_worktree claude-native-r4); mcp_start cn-r4
    tr=$(fixture $P $W r4-locked-control)
    drive --cwd "$wt" --transcript "$tr" --permission allow --env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
      --mcp-via-control --mcp-server "gossamr=$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN --mcp-tool-timeout 600 \
      --prompt "Run the shell command 'echo hi > ran.txt' and tell me the result." \
      --prompt "List every tool you have, by exact name, one per line." \
      -- claude -p --output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio \
         --model "$MODEL" --permission-mode dontAsk --tools "" --allowedTools mcp__gossamr \
         --setting-sources "" --disable-slash-commands --strict-mcp-config \
         --append-system-prompt "You are a test assistant."
    { echo "init tools: $(python3 -c 'import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l)["data"]
    if isinstance(d,dict) and d.get("subtype")=="init": print(d["tools"]); break' "$tr")"
      echo "ran.txt: $(test -e "$wt/ran.txt" && echo present || echo absent)"; } | tee "${tr%.jsonl}.observed.txt"
    keep_mcp_log "$tr"; mcp_stop ;;

  *) echo "unknown check $1" >&2; exit 2 ;;
esac
