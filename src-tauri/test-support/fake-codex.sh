#!/bin/bash
# Stand-in for `codex` in tests. FAKE_CODEX_SCENARIO names a key=value file; calls.log, env.last and token.seen live
# beside it. Keys: login (the line `login status` prints on stderr), login_code (its exit code), thread_id,
# start_delay (seconds to wait before thread.started), hold (seconds to stay alive after the first answer; SIGINT
# ends it with 130 and no turn.completed), fail (text printed on stderr before the process exits 1 with no thread),
# answer (the text written to the -o file).
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
  exec) ;;
  *) echo "fake codex: unknown command ${1-}" >&2; exit 2 ;;
esac

out=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [ "${args[$i]}" = "-o" ] && out=${args[$((i + 1))]}
done

fail=$(cfg fail "")
if [ -n "$fail" ]; then
  echo "$fail" >&2
  exit 1
fi

delay=$(cfg start_delay 0)
[ "$delay" != 0 ] && sleep "$delay"

thread=$(cfg thread_id 019a0000-0000-7000-8000-000000000001)
answer=$(cfg answer "All done.")
printf '{"type":"thread.started","thread_id":"%s"}\n' "$thread"
printf '{"type":"turn.started"}\n'
printf '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"%s"}}\n' "$answer"

hold=$(cfg hold 0)
if [ "$hold" != 0 ]; then
  trap 'exit 130' INT
  sleep "$hold" &
  wait $!
fi

[ -n "$out" ] && printf '%s' "$answer" > "$out"
printf '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}\n'
