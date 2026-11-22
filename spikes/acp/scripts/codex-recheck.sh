#!/usr/bin/env bash
# Reruns the Codex checks the app-server driver rests on, against whatever `codex` is installed now.
# First the protocol's shape from the binary's own schema (no model), then the real checks (short turns).
# Usage: bash scripts/codex-recheck.sh [--shape-only]
source "$(dirname "$0")/env.sh"

echo "codex: $(codex --version)"

# The v2 names the driver uses. A missing one means the driver does not support this version.
schema="$SPIKE_SCRATCH/codex-schema"; rm -rf "$schema"; mkdir -p "$schema"
codex app-server generate-json-schema --out "$schema" >/dev/null
python3 - "$schema" <<'PY'
import json, sys
d = sys.argv[1]
def methods(f):
    s = json.load(open(f"{d}/{f}"))
    return {m for o in s.get("oneOf", []) for m in (o.get("properties", {}).get("method", {}).get("enum") or [])}
client, server, notes = methods("ClientRequest.json"), methods("ServerRequest.json"), methods("ServerNotification.json")
need = {
    "client": ["initialize", "thread/start", "thread/resume", "turn/start", "turn/interrupt"],
    "server": ["item/commandExecution/requestApproval", "item/fileChange/requestApproval",
               "item/permissions/requestApproval", "mcpServer/elicitation/request"],
    "notification": ["turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta"],
}
have = {"client": client, "server": server, "notification": notes}
missing = [f"{k}: {m}" for k, ms in need.items() for m in ms if m not in have[k]]
print("protocol shape:", "ok" if not missing else "MISSING " + ", ".join(missing))
sys.exit(1 if missing else 0)
PY
shape=$?
[ "${1:-}" = --shape-only ] && exit $shape

# The checks the driver's must-do list rests on, each writing its fixture as before.
here="$(dirname "$0")"
for c in 2-permission 2-filechange-approval 3-cancel-chosen 4-kill-resume-chosen 5-mcp-at-rest 4-kill-resume-mcp \
         r1-two-servers r2-ask; do
  echo "== $c"
  bash "$here/codex-app-server.sh" "$c" </dev/null 2>&1 | tail -6
done
# The trust write that made the driver never pass a sandbox on thread/start, in empty scratch homes.
echo "== trust probe"; bash "$here/codex-trust-probe.sh" </dev/null 2>&1 | tail -8
test -e "$HOME/.codex/config.toml" && echo "~/.codex/config.toml: PRESENT" || echo "~/.codex/config.toml: absent"
