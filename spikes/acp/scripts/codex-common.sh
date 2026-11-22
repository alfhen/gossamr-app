# Sourced by the three Codex scripts, after env.sh.

PERM_PROMPT="Run the shell command 'echo one > a.txt'. Then, as a separate command, run 'echo two > b.txt'. Then read README.md and say how many lines it has. Report what happened to each step."
CANCEL_PROMPT="Run the shell command 'sleep 60; echo slept > slept.txt' and wait for it to finish."
KILL_PROMPT="Run the shell command 'sleep 120; echo slept > slept.txt' and wait for it to finish, then say done."
ESCALATE_PROMPT="Run the shell command 'echo one > a.txt'. If the sandbox blocks it, request approval to run it outside the sandbox (with escalated permissions) instead of giving up. Then do the same for 'echo two > b.txt'. Report what happened to each."
RESUME_PROMPT="What exactly did I ask you to do in my previous message, and did the command finish? Answer in two short sentences."

json_field() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }

# kill_driver_when PATTERN PIDFILE: waits until PATTERN runs, kills the driver with SIGKILL,
# then reports which of the agent and its command are still alive after 2, 10 and 30 seconds.
kill_driver_when() {
  local pat=$1 pidf=$2
  # PAT must match the agent's command only (anchor it): a driver's own argv holds the prompt text too.
  for _ in $(seq 240); do pgrep -f "$pat" >/dev/null && break; sleep 0.5; done
  sleep 2
  local driver agent; driver=$(json_field "$pidf" driver); agent=$(json_field "$pidf" agent)
  echo "before kill: driver $driver agent $agent"; pids_matching "$pat"
  echo "agent tree:"; pgrep -P "$agent" | while read -r k; do ps -o pid=,command= -p "$k" | sed "s#$HOME#~#g; s#$SPIKE_SCRATCH#\$SCRATCH#g" | cut -c1-160; done
  kill -9 "$driver"
  for t in 2 10 30; do
    sleep $([ $t = 2 ] && echo 2 || echo $((t==10?8:20)))
    echo "after ${t}s: agent alive: $(kill -0 "$agent" 2>/dev/null && echo yes || echo no)"; pids_matching "$pat"
  done
}

# first_value TRANSCRIPT PYTHON-EXPR: the first non-empty value of an expression over each message `d`.
first_value() {
  python3 -c '
import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l)["data"]
    try: v=eval(sys.argv[2])
    except Exception: v=None
    if v: print(v); break' "$1" "$2"
}

# A writable sandbox for one turn, as a check-only setting. On app-server a sandbox given to thread/start (or a
# sandbox_mode override) writes `projects.<repo>.trust_level = "trusted"` into $CODEX_HOME/config.toml; per turn it does not.
WW_TURN='turn.sandboxPolicy={"type":"workspaceWrite","writableRoots":[],"networkAccess":false}'
FULL_TURN='turn.sandboxPolicy={"type":"dangerFullAccess"}'

OWN_PROMPT="Answer in three short lines. 1: the project codeword if your instructions give one, else NONE. 2: run the shell command 'printf ok' and say what happened. 3: the names of the MCP servers you can use."

# own_setup WT URL: the person's own project setup in a worktree (instructions, project config with an MCP server
# and a hook, an exec-policy rule). Prints what it wrote.
own_setup() {
  local wt=$1 url=$2
  mkdir -p "$wt/.codex/rules"
  printf 'The project codeword is MANGO-7. When asked for it, answer it.\n' > "$wt/AGENTS.md"
  cat > "$wt/.codex/config.toml" <<TOML
[mcp_servers.projspike]
url = "$url"
bearer_token_env_var = "SPIKE_MCP_TOKEN"
default_tools_approval_mode = "approve"

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "touch '$wt/hook-marker'"
TOML
  printf 'prefix_rule(pattern=["printf"], decision="forbidden")\n' > "$wt/.codex/rules/spike.rules"
  rm -f "$wt/hook-marker"
}

# Trust for one run only, as a runtime layer: nothing is written to the person's config.
trust_arg() { printf 'projects."%s".trust_level="trusted"' "$SPIKE_SCRATCH/clone"; }
marker() { echo "hook marker: $([ -f "$1/hook-marker" ] && echo written || echo absent)"; }

PUSH_PROMPT="Create a file named pushed.txt containing the word pushed, commit it with the message 'spike push', and push the current branch to origin. Report the result of each of the three steps in one line each."
# pushed WT BRANCH: whether the commit reached the bare remote.
pushed() { echo "remote has spike/$2: $(git -C "$SPIKE_SCRATCH/remote.git" rev-parse -q --verify "refs/heads/spike/$2" >/dev/null && echo yes || echo no); local commit: $(git -C "$1" log --oneline -1 | cut -c9-)"; }

# check-only: commit signing off for one agent's git, through its environment, so a push check measures the sandbox
# and not the person's signing agent (1Password here, which fails with no one to approve it).
NOSIGN=(--env GIT_CONFIG_COUNT=1 --env GIT_CONFIG_KEY_0=commit.gpgsign --env GIT_CONFIG_VALUE_0=false)
