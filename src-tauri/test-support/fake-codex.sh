#!/bin/bash
# Stand-in for `codex` in tests. FAKE_CODEX_SCENARIO names a key=value file; calls.log, env.last and token.seen live
# beside it. Keys: login (the line `login status` prints on stderr), login_code (its exit code), thread_id,
# start_delay (seconds to wait before thread.started), hold (seconds to stay alive after the first answer; SIGINT
# ends it with 130 and no turn.completed), hold_until_release=1 (stay alive until a file named release appears
# beside the scenario), fail (text printed on stderr before the process exits 1 with no thread),
# answer (the text written to the -o file), exit_early=1 (exit 1 after the answer item, no turn.completed),
# turn_failed (text of a turn.failed line, then exit 1), sandbox_git=1 (a failed `git add` item with the sandbox's
# message), terminal_hold (seconds `resume <thread>` stays alive, as a Terminal session would), ignore_sigint=1
# (the turn does not end on SIGINT; the pid of its `sleep` child is kept in child.pid), fail_resume=1 (`exec resume`
# exits 1 at once), resume_thread (the thread an `exec resume` names, in place of the one it was given), refuse_delete=1
# (`delete` exits 1). `exec resume` answers with the last line of its message. `delete --force <id>` appends the id to
# deleted.
set -u
scenario=${FAKE_CODEX_SCENARIO:?FAKE_CODEX_SCENARIO is not set}
dir=$(dirname "$scenario")
cfg() { local v; v=$(grep -m1 "^$1=" "$scenario" | cut -d= -f2-); echo "${v:-${2-}}"; }

{ echo "---"; echo "cwd=$PWD"; echo "pid=$$"; printf '%s\n' "$@"; } >> "$dir/calls.log"
env | cut -d= -f1 | sort > "$dir/env.last"
[ -n "${GOSSAMR_MCP_TOKEN:-}" ] && echo ok > "$dir/token.seen"

case "${1-}" in
  login)
    echo "$(cfg login 'Logged in using ChatGPT')" >&2
    exit "$(cfg login_code 0)"
    ;;
  resume)
    trap 'exit 130' INT
    sleep "$(cfg terminal_hold 30)" &
    wait $!
    exit 0
    ;;
  delete)
    [ "$(cfg refuse_delete 0)" = 1 ] && { echo "fake codex: that session is in use" >&2; exit 1; }
    echo "${3-}" >> "$dir/deleted"
    exit 0
    ;;
  exec) ;;
  *) echo "fake codex: unknown command ${1-}" >&2; exit 2 ;;
esac

out=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [ "${args[$i]}" = "-o" ] && out=${args[$((i + 1))]}
done

resumed=0
if [ "${2-}" = resume ]; then
  resumed=1
  given=${3-}
  if [ "$(cfg fail_resume 0)" = 1 ]; then
    echo "fake codex: resume failed" >&2
    exit 1
  fi
fi

fail=$(cfg fail "")
if [ -n "$fail" ]; then
  echo "$fail" >&2
  exit 1
fi

delay=$(cfg start_delay 0)
[ "$delay" != 0 ] && sleep "$delay"

thread=$(cfg thread_id 019a0000-0000-7000-8000-000000000001)
answer=$(cfg answer "All done.")
if [ "$resumed" = 1 ]; then
  thread=$(cfg resume_thread "$given")
  answer=$(printf '%s' "${args[$((${#args[@]} - 1))]}" | tail -n 1)
fi
printf '{"type":"thread.started","thread_id":"%s"}\n' "$thread"
printf '{"type":"turn.started"}\n'
printf '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"%s"}}\n' "$answer"

if [ "$(cfg sandbox_git 0)" = 1 ]; then
  printf '%s\n' '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"git add -A","aggregated_output":"fatal: Unable to create /repo/.git/worktrees/x/index.lock'"'"': Operation not permitted","exit_code":128,"status":"failed"}}'
fi

[ "$(cfg exit_early 0)" = 1 ] && exit 1

turn_failed=$(cfg turn_failed "")
if [ -n "$turn_failed" ]; then
  printf '{"type":"turn.failed","error":{"message":"%s"}}\n' "$turn_failed"
  exit 1
fi

if [ "$(cfg hold_until_release 0)" = 1 ]; then
  trap 'exit 130' INT
  while [ ! -e "$dir/release" ]; do
    sleep 0.05 &
    wait $!
  done
fi

hold=$(cfg hold 0)
if [ "$hold" != 0 ]; then
  if [ "$(cfg ignore_sigint 0)" = 1 ]; then trap '' INT; else trap 'exit 130' INT; fi
  sleep "$hold" &
  echo $! > "$dir/child.pid"
  wait $!
fi

[ -n "$out" ] && printf '%s' "$answer" > "$out"
printf '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}\n'
