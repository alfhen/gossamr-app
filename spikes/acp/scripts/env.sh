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
    && git add README.md && git commit -qm init \
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

# pids_matching PATTERN: process list lines for a pattern, user name masked.
pids_matching() { pgrep -fl "$1" | sed "s#$HOME#\$HOME#g; s#$SPIKE_SCRATCH#\$SCRATCH#g" || true; }

# kill_watch PIDFILE COMMAND_PREFIX OBSFILE: waits until a process whose argv starts with COMMAND_PREFIX runs,
# kills the driver with SIGKILL, and writes whether the agent and that command are alive 2, 10 and 30 s later.
kill_watch() {
  local pidf=$1 pat=$2 obs=$3 driver agent
  for _ in $(seq 240); do pgrep -f "^$pat" >/dev/null && break; sleep 0.5; done
  sleep 2
  driver=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["driver"])' "$pidf")
  agent=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["agent"])' "$pidf")
  {
    echo "$(date -u +%FT%TZ) kill -9 of the driver while '$pat' runs"
    echo "before: agent $agent alive: $(kill -0 "$agent" 2>/dev/null && echo yes || echo no); command: $(pgrep -f "^$pat" | wc -l | tr -d ' ') process(es)"
    echo "agent's process tree before:"; pgrep -P "$agent" | while read -r p; do echo "  $p $(ps -o comm= -p "$p" | sed "s#$HOME#\$HOME#g")"; done
  } | tee "$obs"
  local kids; kids=$(pgrep -P "$agent" | tr '\n' ' ')
  kill -9 "$driver"
  for t in 2 8 20; do
    sleep $t
    local alive=""; for k in $kids; do kill -0 "$k" 2>/dev/null && alive="$alive $k"; done
    echo "+${t}s: agent alive: $(kill -0 "$agent" 2>/dev/null && echo yes || echo no); its children alive:${alive:- none}; command: $(pgrep -f "^$pat" | wc -l | tr -d ' ') process(es)" | tee -a "$obs"
  done
  KW_AGENT=$agent
}
