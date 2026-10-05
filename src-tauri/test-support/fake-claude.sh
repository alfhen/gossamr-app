#!/bin/bash
# Stand-in for `claude` in tests. FAKE_CLAUDE_SCENARIO names a key=value file; sessions, jobs/ and calls.log live
# beside it. Keys: version, help_bg (0 hides --bg), logged_in (0 prints loggedIn:false and exits 1),
# config_dir, service_line (1 prints the daemon start line), launch_fail (untrusted|garbage|exit),
# interactive (1 lists a foreign interactive session), foreign_bg (1 lists a foreign background session),
# transcript (text a new session's transcript ends with, written under <config_dir>/projects like Claude does).
set -u
scenario=${FAKE_CLAUDE_SCENARIO:?FAKE_CLAUDE_SCENARIO is not set}
dir=$(dirname "$scenario")
sessions=$dir/sessions
cfg() { local v; v=$(grep -m1 "^$1=" "$scenario" | cut -d= -f2-); echo "${v:-${2-}}"; }
config_dir=$(cfg config_dir "$dir/config")
touch "$sessions"

{ echo "---"; echo "cwd=$PWD"; printf '%s\n' "$@"; } >> "$dir/calls.log"
env | cut -d= -f1 | sort > "$dir/env.last"

esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

new_session() { # worktree name prompt
  local n id wt=$1 cwd=$PWD
  n=$(cat "$dir/counter" 2>/dev/null || echo 1)
  echo $((n + 1)) > "$dir/counter"
  id=$(printf '%08x' $((0xa0000000 + n)))
  [ -n "$wt" ] && cwd=$PWD/.claude/worktrees/$wt && mkdir -p "$cwd"
  printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$id-0000-4000-8000-000000000000" "$cwd" "$2" working >> "$sessions"
  write_job "$id" "$wt" "$3" "$cwd"
  write_transcript "$id-0000-4000-8000-000000000000" "$cwd"
  echo "$id"
}

write_transcript() { # sessionId cwd
  local text folder
  text=$(cfg transcript "")
  [ -z "$text" ] && return
  folder=$(printf '%s' "$2" | sed 's/[^A-Za-z0-9]/-/g')
  mkdir -p "$config_dir/projects/$folder"
  {
    printf '{"type":"user","message":{"role":"user","content":"a prompt"}}\n'
    printf '{"type":"assistant","isSidechain":false,"message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"%s"}]}}\n' "$(esc "$text")"
  } > "$config_dir/projects/$folder/$1.jsonl"
}

write_job() { # id worktree prompt cwd
  mkdir -p "$config_dir/jobs/$1"
  local branch=""
  [ -n "$2" ] && branch=worktree-$2
  printf '{"state":"working","detail":"Starting","tempo":"active","tokens":0,"updatedAt":"2026-01-01T00:00:00Z","worktreePath":"%s","worktreeBranch":"%s","intent":"%s","providerEnv":{"FAKE_SECRET":"fake-provider-secret"}}\n' \
    "$(esc "$4")" "$branch" "$(esc "$3")" > "$config_dir/jobs/$1/state.json"
  printf '{"at":"2026-01-01T00:00:00Z","state":"working","detail":"Starting","text":"Started"}\n' > "$config_dir/jobs/$1/timeline.jsonl"
}

set_state() { # id state [name]
  awk -F'\t' -v OFS='\t' -v id="$1" -v st="$2" -v nm="${3-}" '$1==id { $5=st; if (nm != "") $4=nm } { print }' "$sessions" > "$sessions.tmp" && mv "$sessions.tmp" "$sessions"
}

emit_agents() { # all?
  local sep="" id sid cwd name state
  echo '['
  while IFS=$'\t' read -r id sid cwd name state; do
    [ "$state" = stopped ] && [ "$1" != 1 ] && continue
    printf '%s{"id":"%s","sessionId":"%s","cwd":"%s","kind":"background","startedAt":1767225600000,"name":"%s","state":"%s"' "$sep" "$id" "$sid" "$(esc "$cwd")" "$(esc "$name")" "$state"
    [ "$state" = working ] && printf ',"status":"busy","pid":4242'
    printf '}'
    sep=$',\n'
  done < "$sessions"
  if [ "$(cfg foreign_bg 0)" = 1 ]; then
    printf '%s{"id":"f0f0f0f0","sessionId":"f0f0f0f0-0000-4000-8000-000000000000","cwd":"/tmp/foreign","kind":"background","startedAt":1767225600000,"name":"foreign","state":"working","status":"busy","pid":4343}' "$sep"
    sep=$',\n'
  fi
  if [ "$(cfg interactive 0)" = 1 ]; then
    printf '%s{"cwd":"/tmp/foreign","kind":"interactive","name":"foreign","pid":9,"sessionId":"eeeeeeee-0000-4000-8000-000000000000","startedAt":1767225600000,"status":"idle"}' "$sep"
  fi
  echo
  echo ']'
}

case "${1-}" in
  --version) cfg version "2.1.286 (Claude Code)"; exit 0 ;;
  --help)
    echo "Usage: claude [options] [command] [prompt]"
    [ "$(cfg help_bg 1)" != 0 ] && echo "  --bg   Start the session in the background"
    echo "  --worktree [name]   Create a git worktree"
    exit 0 ;;
  auth)
    if [ "$(cfg logged_in 1)" = 1 ]; then
      printf '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"someone@example.com","configDirectory":"%s","projectsDirectory":"%s/projects"}\n' "$config_dir" "$config_dir"
      exit 0
    fi
    printf '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","configDirectory":"%s","projectsDirectory":"%s/projects"}\n' "$config_dir" "$config_dir"
    exit 1 ;;
  agents)
    all=0; for a in "$@"; do [ "$a" = --all ] && all=1; done
    emit_agents $all; exit 0 ;;
  stop|rm)
    id=${2-}
    if ! cut -f1 "$sessions" | grep -qx "$id"; then echo "No session $id" >&2; exit 1; fi
    if [ "$1" = stop ]; then set_state "$id" stopped; echo "stopped $id"
    else
      awk -F'\t' -v id="$id" '$1!=id' "$sessions" > "$sessions.tmp" && mv "$sessions.tmp" "$sessions"
      rm -rf "$config_dir/jobs/$id"; echo "removed $id"
    fi
    exit 0 ;;
esac

name=""; wt=""; resume=""; prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bg) ;;
    --name) name=$2; shift ;;
    --worktree) wt=$2; shift ;;
    --append-system-prompt) shift ;;
    --mcp-config|--allowedTools) shift ;;
    --resume) resume=$2; shift ;;
    --) shift; prompt=${1-}; break ;;
    *) prompt=$1 ;;
  esac
  shift
done

case "$(cfg launch_fail none)" in
  untrusted) echo "Workspace not trusted: $PWD" >&2; echo "Run claude in this folder once to accept the trust prompt." >&2; exit 1 ;;
  exit) echo "something broke" >&2; exit 2 ;;
  garbage) echo "ok, whatever"; exit 0 ;;
esac

[ "$(cfg service_line 0)" = 1 ] && echo "Starting background service…"

if [ -n "$resume" ]; then
  row=$(awk -F'\t' -v sid="$resume" '$2==sid' "$sessions" | head -1)
  if [ -z "$row" ]; then echo "No session $resume" >&2; exit 1; fi
  id=$(echo "$row" | cut -f1); state=$(echo "$row" | cut -f5)
  if [ "$state" = working ]; then
    echo "already running: started a copy"
    cwd=$(echo "$row" | cut -f3)
    id=$(new_session "" "$prompt" "$prompt")
    awk -F'\t' -v OFS='\t' -v id="$id" -v cwd="$cwd" '$1==id { $3=cwd } { print }' "$sessions" > "$sessions.tmp" && mv "$sessions.tmp" "$sessions"
    printf 'backgrounded · %s · %s\n' "$id" "$prompt"
  else
    set_state "$id" working "$prompt"
    printf 'backgrounded · %s · %s\n' "$id" "$prompt"
  fi
else
  id=$(new_session "$wt" "$name" "$prompt")
  if [ -n "$name" ]; then printf 'backgrounded · %s · %s\n' "$id" "$name"; else printf 'backgrounded · %s\n' "$id"; fi
fi
echo "  claude attach $id"
echo "  claude logs $id"
echo "  claude stop $id"
echo "  claude agents"
exit 0
