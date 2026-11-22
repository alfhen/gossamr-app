# Sourced by the three Codex scripts, after env.sh.

PERM_PROMPT="Run the shell command 'echo one > a.txt'. Then, as a separate command, run 'echo two > b.txt'. Then read README.md and say how many lines it has. Report what happened to each step."
CANCEL_PROMPT="Run the shell command 'sleep 60; echo slept > slept.txt' and wait for it to finish."
KILL_PROMPT="Run the shell command 'sleep 120; echo slept > slept.txt' and wait for it to finish, then say done."
ESCALATE_PROMPT="Run the shell command 'echo one > a.txt'. If the sandbox blocks it, request approval to run it outside the sandbox (with escalated permissions) instead of giving up. Then do the same for 'echo two > b.txt'. Report what happened to each."
RESUME_PROMPT="What exactly did I ask you to do in my previous message, and did the command finish? Answer in two short sentences."

json_field() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }

# kill_driver_when PATTERN PIDFILE: kill_watch from env.sh, writing to the observation file beside the transcript
# given as a third argument (or stdout only).
kill_driver_when() { kill_watch "$2" "${1#^}" "${3:-/dev/null}"; }

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
# and not the person's signing agent, which fails with no one to approve it.
NOSIGN=(--env GIT_CONFIG_COUNT=1 --env GIT_CONFIG_KEY_0=commit.gpgsign --env GIT_CONFIG_VALUE_0=false)

# approvals TRANSCRIPT: each server request that asks, its kind and reason, and the driver's answer.
approvals() {
  python3 - "$1" <<'PY'
import json,sys
for l in open(sys.argv[1]):
    e=json.loads(l); d=e["data"]
    if isinstance(d,dict) and d.get("method") and "id" in d and e["dir"]=="from_agent" and ("pproval" in d["method"] or "request" in d["method"].lower()):
        p=d.get("params") or {}
        print("request:", d["method"], "| reason:", (p.get("reason") or "")[:120], "| command:", str(p.get("command") or "")[:80])
    if e["dir"]=="driver" and isinstance(d,dict) and d.get("note") in ("permission_answer","client_method_refused"):
        print("  answer:", d["note"], d["detail"])
PY
}

# push_report TRANSCRIPT: escalations asked and answered, the thread's sandbox, and any command that turns off signing or hooks.
push_report() {
  approvals "$1"
  python3 - "$1" <<'PY'
import json,sys
sb=None; bypass=[]; cmds=0
for l in open(sys.argv[1]):
    e=json.loads(l); d=e["data"]
    if not isinstance(d,dict): continue
    r=d.get("result") or {}
    if isinstance(r,dict) and "sandbox" in r: sb=r["sandbox"]
    it=(d.get("params") or {}).get("item") or {}
    if d.get("method")=="item/completed" and it.get("type")=="commandExecution":
        cmds+=1; c=str(it.get("command"))
        if "gpgsign" in c or "hooksPath" in c or "no-verify" in c or "no-gpg-sign" in c: bypass.append(c[:160])
print("thread sandbox:", json.dumps(sb)); print("commands run:", cmds); print("signing or hook bypass in a command:", bypass or "none")
PY
}

# processes_report TRANSCRIPT COMMAND: whether COMMAND is among the agent's descendants in each of the driver's process notes.
processes_report() {
  python3 - "$1" "$2" <<'PY'
import json,sys
for l in open(sys.argv[1]):
    e=json.loads(l); d=e["data"]
    if e["dir"]=="driver" and isinstance(d,dict) and d.get("note") in ("processes","turn_end","signal"):
        if d["note"]=="processes":
            n=sum(1 for x in d["detail"]["descendants"] if sys.argv[2] in x["comm"] or x["comm"].endswith("/sleep") or x["comm"]=="sleep")
            print(f'{e["ms"]} ms, {d["detail"]["when"]}: sleep among the agent\'s descendants: {n}')
        elif d["note"]=="turn_end":
            print(f'{e["ms"]} ms, turn {d["detail"]["turn"]} ended: {d["detail"].get("completed")}')
PY
}
