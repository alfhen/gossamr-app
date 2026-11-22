# Sourced by every check script. Needs SPIKE_SCRATCH: an empty folder under your session's temp folder.
# Nothing here writes outside SPIKE_SCRATCH and spikes/acp/fixtures.
set -euo pipefail

: "${SPIKE_SCRATCH:?set SPIKE_SCRATCH to a scratch folder under your temp folder}"
case "$SPIKE_SCRATCH" in
  "$HOME"/.claude*|"$HOME"/.codex*|"$HOME"/.gemini*|"$HOME"/Gossamr*) echo "refusing: SPIKE_SCRATCH is a real config folder" >&2; exit 1 ;;
esac

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIX="$SPIKE_DIR/fixtures"
SPIKE="$SPIKE_DIR/target/debug/acp-spike"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/opt/rustup/bin:$PATH"
export SPIKE_SCRATCH
mkdir -p "$SPIKE_SCRATCH"
SPIKE_SCRATCH="$(cd "$SPIKE_SCRATCH" && pwd -P)"
ADAPTERS="$SPIKE_SCRATCH/adapters/node_modules"

# Words to mask in transcripts (an employer, a client), one line, comma-separated. Kept in scratch, never committed.
if [ -f "$SPIKE_SCRATCH/redact-words" ]; then
  SPIKE_REDACT_WORDS="$(cat "$SPIKE_SCRATCH/redact-words")"
  export SPIKE_REDACT_WORDS
fi

# The spike's MCP token. Never a real credential; masked in every transcript anyway.
if [ -z "${SPIKE_MCP_TOKEN:-}" ]; then
  SPIKE_MCP_TOKEN="spk_$(openssl rand -hex 24)"
fi
export SPIKE_MCP_TOKEN

[ -x "$SPIKE" ] || (cd "$SPIKE_DIR" && cargo build -q)

# A clone with a local bare remote. Agents work in worktrees of the clone.
repo_setup() {
  [ -d "$SPIKE_SCRATCH/clone/.git" ] && return 0
  git init -q --bare "$SPIKE_SCRATCH/remote.git"
  git init -q -b main "$SPIKE_SCRATCH/clone"
  (cd "$SPIKE_SCRATCH/clone" \
    && git config user.name spike && git config user.email spike@example.invalid \
    && printf 'Scratch repo for the H0 spike.\n' > README.md \
    && git add README.md && git -c commit.gpgsign=false commit -qm init \
    && git remote add origin "$SPIKE_SCRATCH/remote.git" && git push -q origin main)
}

# new_worktree NAME: a fresh worktree on branch spike/NAME; prints its path.
new_worktree() {
  repo_setup
  local wt="$SPIKE_SCRATCH/wt/$1"
  if [ ! -d "$wt" ]; then
    mkdir -p "$SPIKE_SCRATCH/wt"
    git -C "$SPIKE_SCRATCH/clone" worktree add -q -b "spike/$1" "$wt" main
  fi
  printf '%s\n' "$wt"
}

# fixture PROVIDER PATH CHECK: the transcript path for one check.
fixture() {
  mkdir -p "$FIX/$1/$2"
  printf '%s\n' "$FIX/$1/$2/$3.jsonl"
  # Remembered for the exit trap, which redacts this script's own files and no other script's.
  printf '%s\n' "$FIX/$1/$2/$3" >> "$SPIKE_WRITTEN"
}

# mcp_start NAME: a spike MCP server on a free loopback port; sets MCP_URL and MCP_PID.
mcp_start() {
  local log="$SPIKE_SCRATCH/mcp-$1.log"
  rm -f "$SPIKE_SCRATCH/mcp-$1.port"
  "$SPIKE" mcp --token-env SPIKE_MCP_TOKEN --log "$log" --port-file "$SPIKE_SCRATCH/mcp-$1.port" &
  MCP_PID=$!
  for _ in $(seq 50); do [ -s "$SPIKE_SCRATCH/mcp-$1.port" ] && break; sleep 0.1; done
  MCP_URL="http://127.0.0.1:$(cat "$SPIKE_SCRATCH/mcp-$1.port")/mcp"
  MCP_LOG="$log"
}

mcp_stop() { kill "$MCP_PID" 2>/dev/null || true; wait "$MCP_PID" 2>/dev/null || true; }

# Copies the MCP server's request log (it holds no token) next to a fixture.
keep_mcp_log() { cp "$MCP_LOG" "${1%.jsonl}.mcp-log.jsonl"; }

# pids_matching PATTERN: process list lines for a pattern, user name masked. For a look, not for a count.
pids_matching() { pgrep -fl "$1" | sed "s#$HOME#\$HOME#g; s#$SPIKE_SCRATCH#\$SCRATCH#g" || true; }

# descendants_matching ROOT COMMAND_PREFIX: pids under ROOT whose argv starts with COMMAND_PREFIX. Only the agent's
# own tree counts, never another process on the machine with the same command.
descendants_matching() {
  local root=$1 pat=$2 p
  for p in $(pgrep -P "$root" || true); do
    ps -o command= -p "$p" 2>/dev/null | grep -q "^$pat" && echo "$p"
    descendants_matching "$p" "$pat"
  done
}

# alive_of PIDS...: those still alive.
alive_of() { local p; for p in "$@"; do kill -0 "$p" 2>/dev/null && printf '%s ' "$p"; done; return 0; }

# kill_watch PIDFILE COMMAND_PREFIX OBSFILE: waits until the agent runs a command whose argv starts with
# COMMAND_PREFIX, kills the driver with SIGKILL, and writes whether the agent, its children and that command are
# alive 2, 10 and 30 s later. The command is followed by pid, so a reparented one is still seen.
kill_watch() {
  local pidf=$1 pat=$2 obs=$3 driver agent cmds="" kids
  for _ in $(seq 120); do [ -s "$pidf" ] && break; sleep 0.5; done
  agent=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["agent"])' "$pidf")
  driver=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["driver"])' "$pidf")
  for _ in $(seq 240); do cmds=$(descendants_matching "$agent" "$pat" | tr '\n' ' '); [ -n "$cmds" ] && break; sleep 0.5; done
  sleep 2
  kids=$(pgrep -P "$agent" | tr '\n' ' ' || true)
  {
    echo "$(date -u +%FT%TZ) kill -9 of the driver while the agent runs '$pat'"
    echo "before: agent alive: $(kill -0 "$agent" 2>/dev/null && echo yes || echo no); the command under the agent: $(echo $cmds | wc -w | tr -d ' ') process(es)"
    echo "agent's children before:"; for p in $kids; do echo "  $(ps -o comm= -p "$p" | sed "s#$HOME#\$HOME#g; s#.*/##")"; done
  } | tee "$obs"
  kill -9 "$driver"
  for t in 2 8 20; do
    sleep $t
    echo "+${t}s: agent alive: $(kill -0 "$agent" 2>/dev/null && echo yes || echo no); its children alive: $(alive_of $kids | wc -w | tr -d ' '); the command alive: $(alive_of $cmds | wc -w | tr -d ' ')" | tee -a "$obs"
  done
  KW_AGENT=$agent; KW_CMDS=$cmds
}

# agent_commands TRANSCRIPT: every shell command the agent ran, one per line (Claude Bash, Codex commandExecution,
# ACP execute tool calls, agy run_command).
agent_commands() {
  python3 - "$1" <<'PY'
import json, sys
for l in open(sys.argv[1]):
    d = json.loads(l)["data"]
    if not isinstance(d, dict): continue
    if d.get("type") == "assistant":
        for c in d["message"]["content"]:
            if c.get("type") == "tool_use" and c.get("name") == "Bash": print(c["input"].get("command", ""))
    p = d.get("params") or {}
    item = p.get("item") or {}
    if d.get("method") == "item/started" and item.get("type") == "commandExecution": print(item.get("command", ""))
    u = p.get("update") or {}
    if u.get("sessionUpdate") == "tool_call" and u.get("kind") == "execute": print((u.get("rawInput") or {}).get("CommandLine") or (u.get("rawInput") or {}).get("command") or u.get("title", ""))
PY
}

# token_files DIR: how many files under DIR hold the spike's MCP token. A count only; credential files are skipped.
token_files() {
  grep -rlF --exclude=auth.json --exclude='*creds*' --exclude='*credential*' --exclude=google_accounts.json \
    --exclude='*.lock' -- "$SPIKE_MCP_TOKEN" "$1" 2>/dev/null | wc -l | tr -d ' '
}

# The login folders' own config, recorded when a script starts and compared when it ends. A change fails the
# script loudly. Credential files are compared by size and modification time only, never read.
LOGIN_CONFIG=("$HOME/.claude/settings.json" "$HOME/.claude/settings.local.json" "$HOME/.codex/config.toml"
  "$HOME/.gemini/antigravity-cli/settings.json" "$HOME/.gemini/config/mcp_config.json" "$HOME/.gemini/config/hooks.json"
  "$HOME/.gemini/settings.json" "$HOME/.gemini/trustedFolders.json")
LOGIN_CREDENTIALS=("$HOME/.codex/auth.json" "$HOME/.gemini/oauth_creds.json" "$HOME/.gemini/google_accounts.json")
login_snapshot() {
  local f
  for f in "${LOGIN_CONFIG[@]}"; do
    if [ -e "$f" ]; then echo "$f $(shasum -a 256 < "$f" | cut -c1-16)"; else echo "$f absent"; fi
  done
  for f in "${LOGIN_CREDENTIALS[@]}"; do
    if [ -e "$f" ]; then echo "$f $(stat -f '%z %m' "$f")"; else echo "$f absent"; fi
  done
  # ~/.claude.json changes as every Claude session runs; what must not change is a trust entry for scratch paths.
  echo "claude.json trust entries for the scratch folder: $(python3 -c 'import json,os,sys
try: d=json.load(open(os.path.expanduser("~/.claude.json")))
except Exception: print("unreadable"); sys.exit()
print(sum(1 for k in d.get("projects",{}) if k.startswith(sys.argv[1])))' "$SPIKE_SCRATCH")"
}
SPIKE_WRITTEN="$SPIKE_SCRATCH/.written.$$"; : > "$SPIKE_WRITTEN"
SPIKE_LOGIN_BEFORE="$(login_snapshot)"
spike_exit() {
  local rc=$?
  # A driver killed on purpose did not redact its whole transcript; do it for every file this script wrote
  # (the transcript and the files beside it), once its own drivers have ended.
  [ -n "${MCP_PID:-}" ] && kill "$MCP_PID" 2>/dev/null
  sort -u "$SPIKE_WRITTEN" | while read -r base; do
    for f in "$base".jsonl "$base".observed.txt "$base".mcp-log.jsonl; do [ -f "$f" ] && "$SPIKE" redact "$f"; done
  done || true
  rm -f "$SPIKE_WRITTEN"
  local after; after="$(login_snapshot)"
  if [ "$after" != "$SPIKE_LOGIN_BEFORE" ]; then
    echo "LOGIN CONFIG CHANGED during this check:" >&2
    diff <(echo "$SPIKE_LOGIN_BEFORE") <(echo "$after") | sed "s#$HOME#\$HOME#g" >&2
    exit 9
  fi
  exit $rc
}
trap spike_exit EXIT
