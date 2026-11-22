#!/usr/bin/env bash
# Claude through ACP: @agentclientprotocol/claude-agent-acp 0.109.1 (install it first, see README.md).
# By default the adapter starts the Claude CLI bundled in @anthropic-ai/claude-agent-sdk-darwin-arm64.
# CLAUDE_ACP_CLI=own points it at the person's own CLI (CLAUDE_CODE_EXECUTABLE); fixtures then go to acp-own-cli.
# Usage: bash scripts/claude-acp.sh <check>
source "$(dirname "$0")/env.sh"

P=claude; W=acp
ADAPTER=(node "$ADAPTERS/@agentclientprotocol/claude-agent-acp/dist/index.js")
EXTRA=()
if [ "${CLAUDE_ACP_CLI:-bundled}" = own ]; then
  W=acp-own-cli; EXTRA=(--env "CLAUDE_CODE_EXECUTABLE=$HOME/.local/bin/claude")
fi
MODEL=${CLAUDE_MODEL:-haiku}

drive() { "$SPIKE" acp ${EXTRA[@]+"${EXTRA[@]}"} "$@"; }

# Which programs run under the adapter right now (pid, command name), for check 12.
tree_of() {
  local root=$1
  { pgrep -P "$root" || true; } | while read -r p; do
    echo "  $p $(ps -o command= -p "$p" | sed "s#$HOME#\$HOME#g; s#$SPIKE_SCRATCH#\$SCRATCH#g; s#Bearer [^\"' ]*#Bearer <redacted>#g")"
    tree_of "$p"
  done
}

case "${1:?check}" in
  0-list)
    # Setup only: initialize and session/new (modes, models, config options), then the process tree.
    wt=$(new_worktree "claude-$W-0"); pidf="$SPIKE_SCRATCH/claude-$W-0.pid"
    tr=$(fixture $P $W 0-list)
    drive --cwd "$wt" --transcript "$tr" --list-only --keep-open 8 --pid-file "$pidf" -- "${ADAPTER[@]}" &
    sleep 6
    agent=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["agent"])' "$pidf")
    { echo "processes under the adapter (node $agent):"; tree_of "$agent"; } | tee "${tr%.jsonl}.observed.txt"
    wait ;;

  1-edit-run)
    wt=$(new_worktree "claude-$W-1")
    drive --cwd "$wt" --transcript "$(fixture $P $W 1-edit-run)" --permission allow --model "$MODEL" \
      --prompt "Create a file named note.txt containing the single word hello. Then run the shell command 'ls' and tell me its output in one short sentence." \
      -- "${ADAPTER[@]}"
    ls "$wt" ;;

  2-permission)
    # The adapter starts in its own default mode (auto), where nothing asks; mode default asks.
    wt=$(new_worktree "claude-$W-2")
    drive --cwd "$wt" --transcript "$(fixture $P $W 2-permission)" --permission alt --model "$MODEL" --mode default \
      --prompt "Run the shell command 'echo one > a.txt'. Then, as a separate command, run 'echo two > b.txt'. Then read README.md and say how many lines it has. Report what happened to each step." \
      -- "${ADAPTER[@]}"
    ls "$wt" ;;

  3-cancel)
    wt=$(new_worktree "claude-$W-3")
    drive --cwd "$wt" --transcript "$(fixture $P $W 3-cancel)" --permission allow --model "$MODEL" --cancel-after 12 \
      --prompt "Run the shell command 'ping -c 40 127.0.0.1 > ping.txt' in the foreground (not in the background, timeout 120000) and wait for it to finish." \
      --prompt "Reply with the single word ready." \
      -- "${ADAPTER[@]}"
    pids_matching '^ping -c 40' ;;

  4-kill-resume)
    wt=$(new_worktree "claude-$W-4")
    tr=$(fixture $P $W 4-kill); pidf="$SPIKE_SCRATCH/claude-$W-4.pid"
    drive --cwd "$wt" --transcript "$tr" --permission allow --model "$MODEL" --pid-file "$pidf" \
      --prompt "Run the shell command 'ping -c 90 127.0.0.1 > ping.txt' in the foreground (not in the background, timeout 200000), wait for it, then say done." \
      -- "${ADAPTER[@]}" &
    kill_watch "$pidf" 'ping -c 90' "${tr%.jsonl}.observed.txt"
    pkill -f '^ping -c 90' || true
    kill "$KW_AGENT" 2>/dev/null || true
    sid=$(python3 -c 'import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l)["data"]
    if isinstance(d,dict) and d.get("note")=="session": print(d["detail"]["id"]); break' "$tr")
    drive --cwd "$wt" --transcript "$(fixture $P $W 4-resume)" --permission allow --resume "$sid" \
      --prompt "What exactly did I ask you to do in my previous message, and did the command finish? Answer in two short sentences." \
      -- "${ADAPTER[@]}" ;;

  5-mcp)
    wt=$(new_worktree "claude-$W-5"); mcp_start "claude-$W-5"; pidf="$SPIKE_SCRATCH/claude-$W-5.pid"
    tr=$(fixture $P $W 5-mcp)
    drive --cwd "$wt" --transcript "$tr" --permission allow --model "$MODEL" --pid-file "$pidf" \
      --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN --keep-open 2 \
      --prompt "Call the ping tool of the spike MCP server and tell me what it answered. Then run the shell command 'printenv SPIKE_MCP_TOKEN | wc -c' and tell me the number it printed (never print the variable itself)." \
      -- "${ADAPTER[@]}" & dpid=$!
    sleep 4
    agent=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["agent"])' "$pidf")
    { echo "token on any argv under the adapter: $(pgrep -P "$agent" | xargs -I{} ps -o command= -p {} | grep -c "$SPIKE_MCP_TOKEN" || true)"
      echo "--mcp-config on the CLI's argv: $(pgrep -P "$agent" | xargs -I{} ps -o command= -p {} | grep -c -- '--mcp-config' || true)"; } | tee "${tr%.jsonl}.observed.txt"
    wait $dpid; keep_mcp_log "$tr"; mcp_stop ;;

  5-hold-default)
    wt=$(new_worktree "claude-$W-5h"); mcp_start "claude-$W-5h"
    tr=$(fixture $P $W 5-hold-default)
    drive --cwd "$wt" --transcript "$tr" --permission allow --model "$MODEL" --turn-timeout 900 \
      --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN \
      --prompt "Call the hold tool of the spike MCP server with seconds set to 540 and wait for its answer. Then tell me exactly what it answered, or the exact error if it failed." \
      -- "${ADAPTER[@]}"
    keep_mcp_log "$tr"; mcp_stop ;;

  6-model)
    wt=$(new_worktree "claude-$W-6")
    drive --cwd "$wt" --transcript "$(fixture $P $W 6-model)" --permission deny --model sonnet --set-config effort=low \
      --prompt "Reply with the single word ok." -- "${ADAPTER[@]}" ;;

  7-second-login)
    empty="$SPIKE_SCRATCH/claude-config-empty-acp"; mkdir -p "$empty"
    wt=$(new_worktree "claude-$W-7")
    drive --cwd "$wt" --transcript "$(fixture $P $W 7-second-login)" --permission deny --env CLAUDE_CONFIG_DIR="$empty" \
      --prompt "Reply with the single word ok." -- "${ADAPTER[@]}" ;;

  8-own-setup)
    wt=$(new_worktree "claude-$W-8"); mcp_start "claude-$W-8"
    mkdir -p "$wt/.claude"
    printf '{ "permissions": { "allow": ["Bash(touch rule-file.txt)"] }, "hooks": { "PostToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "touch \\"$CLAUDE_PROJECT_DIR/hook-marker\\"" } ] } ] } }\n' > "$wt/.claude/settings.json"
    printf '{"mcpServers":{"projspike":{"type":"http","url":"%s","headers":{"Authorization":"Bearer ${SPIKE_MCP_TOKEN}"}}}}\n' "$MCP_URL" > "$wt/.mcp.json"
    printf 'The project codeword is ZEBRA-41.\n' > "$wt/CLAUDE.md"
    printf 'The agents codeword is TIGER-77.\n' > "$wt/AGENTS.md"
    tr=$(fixture $P $W 8-own-setup)
    drive --cwd "$wt" --transcript "$tr" --permission alt --model "$MODEL" \
      --prompt "Without reading any file, tell me the project codeword and the agents codeword if your instructions contain them (say NONE otherwise). Then run the shell command 'touch rule-file.txt'. Then run 'echo hooked > h.txt'. Then call the ping tool of the projspike MCP server if you have it, otherwise say NO PROJSPIKE. Report each step." \
      -- "${ADAPTER[@]}"
    { echo "hook marker: $(test -e "$wt/hook-marker" && echo present || echo absent)"
      echo "rule-file.txt: $(test -e "$wt/rule-file.txt" && echo present || echo absent)"; } | tee "${tr%.jsonl}.observed.txt"
    keep_mcp_log "$tr"; mcp_stop ;;

  10-push)
    wt=$(new_worktree "claude-$W-10")
    drive --cwd "$wt" --transcript "$(fixture $P $W 10-push)" --permission allow --model "$MODEL" \
      --prompt "Create pushed.txt containing the word pushed, commit it with the message 'spike push', and push the current branch to origin. Report the push output." \
      -- "${ADAPTER[@]}"
    git -C "$SPIKE_SCRATCH/remote.git" log --oneline -1 "spike/claude-$W-10" ;;

  11-locked)
    # Today's Pip flags, passed the way the adapter takes Claude options (_meta.claudeCode.options).
    wt=$(new_worktree "claude-$W-11"); mcp_start "claude-$W-11"; pidf="$SPIKE_SCRATCH/claude-$W-11.pid"
    meta='{"claudeCode":{"options":{"tools":[],"allowedTools":["mcp__gossamr"],"settingSources":[],"strictMcpConfig":true,"permissionMode":"dontAsk","extraArgs":{"disable-slash-commands":null},"env":{"CLAUDE_CODE_DISABLE_AUTO_MEMORY":"1"}}}}'
    tr=$(fixture $P $W 11-locked)
    "$SPIKE" acp ${EXTRA[@]+"${EXTRA[@]}"} --cwd "$wt" --transcript "$tr" --permission allow --model "$MODEL" --pid-file "$pidf" \
      --session-meta "$meta" --mcp-url "$MCP_URL" --mcp-token-env SPIKE_MCP_TOKEN \
      --prompt "Read the file README.md and quote it." \
      --prompt "Run the shell command 'echo hi > ran.txt' and tell me the result." \
      --prompt "Fetch https://example.com and tell me its title." \
      --prompt "List every tool you have, by exact name, one per line." \
      -- "${ADAPTER[@]}" & dpid=$!
    sleep 3
    agent=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["agent"])' "$pidf")
    { echo "processes under the adapter:"; tree_of "$agent"; } | tee "${tr%.jsonl}.observed.txt"
    wait $dpid
    echo "ran.txt: $(test -e "$wt/ran.txt" && echo present || echo absent)" | tee -a "${tr%.jsonl}.observed.txt"
    keep_mcp_log "$tr"; mcp_stop ;;

  *) echo "unknown check $1" >&2; exit 2 ;;
esac
