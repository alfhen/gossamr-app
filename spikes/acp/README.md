# H0 spike: drive each provider for real

Step H0 of [docs/plan-harness.md](../../docs/plan-harness.md). This folder drives Claude Code, Codex and the Antigravity CLI (`agy`) on every path a harness driver could use, records the wire, and backs [docs/harness-findings.md](../../docs/harness-findings.md). Nothing in the app depends on it, and it is not part of any workspace.

## What is here

| Path | What it is |
| --- | --- |
| `src/` | `acp-spike`, a Rust program. Subcommands: `acp` (an ACP client), `claude` (`claude -p` with stream-json both ways and the control protocol), `app-server` (`codex app-server` over stdio), `agy-stream` (`agy` with stream-json both ways), `raw` (a one-shot command such as `codex exec --json`), `mcp` (a loopback MCP server with a bearer token and the tools `ping` and `hold`), `redact` (redacts transcripts again, in place). `claude --mcp-via-control` gives the tools endpoint by the `mcp_set_servers` control request instead of `--mcp-config`; `acp --session-meta` sends `_meta` with `session/new`. `--mcp-server NAME=URL` (repeatable) gives a session more servers, and `--own-server` names the one Codex pre-approves. `mcp --extra-tool NAME` adds a tool, and its `ask` tool answers "question pending" after `--ask-after` seconds. |
| `scripts/env.sh` | Sourced by every script: the scratch repo with a local bare remote, worktrees, fixture paths, the MCP server, `kill_watch` (follows the agent's own descendants by pid), `token_files` (a count; credential files skipped), `agent_commands`, the login-config snapshot and the exit trap. |
| `scripts/claude-native.sh`, `claude-acp.sh` | Claude: native stream-json, and ACP through `@agentclientprotocol/claude-agent-acp`. |
| `scripts/codex-exec.sh`, `codex-app-server.sh`, `codex-acp.sh`, `codex-common.sh` | Codex: `codex exec --json`, `codex app-server`, and ACP through `@agentclientprotocol/codex-acp`. |
| `scripts/codex-recheck.sh` | Reruns the Codex checks the app-server driver rests on against whatever `codex` is installed; `--shape-only` checks the protocol's v2 names from the binary's own schema, with no model. |
| `scripts/selfcheck.sh` | Checks `env.sh`'s exit trap against a scratch `HOME` with stand-in files: a planted change must fail the script with exit 9. |
| `scripts/codex-trust-probe.sh`, `codex-app-server-two-threads.py` | Which app-server call writes project trust (in empty scratch homes); two threads in one app-server. |
| `scripts/agy.sh` | Gemini through `agy acp` and `agy` stream-json. |
| `fixtures/<provider>/<path>/<check>.jsonl` | One transcript per check. |

### Transcripts

Each line is `{"seq", "ms", "dir", "data"}`, in the order the driver saw it. `dir` is `to_agent` (the agent's stdin), `from_agent` (its stdout), `stderr`, or `driver` (what the driver did or noticed: `spawned`, `permission_answer`, `first_text`, `turn_end`, `processes`, `exited`, `schema_mismatch`). `data` is the line as JSON when it parses, else the text. A later step (H2) replays these in a mock provider.

Beside some transcripts: `<check>.observed.txt` holds what the script itself saw (process lists, files made), and `<check>.mcp-log.jsonl` is the MCP server's request log (method, tool, whether the token matched, header names; never the token).

Redaction happens twice. Each line is redacted before it is written; when a driver ends, and in each script's exit trap for a driver that was killed, the whole file is redacted again with every streamed run joined (Claude `text`, `partial_json` and `thinking` deltas, ACP `*_chunk` updates, app-server `*delta` notifications, agy `text_delta`), because a name split over two deltas shows in no single line. What is masked: the MCP token, any environment value whose name holds TOKEN, SECRET, KEY, UUID, EMAIL, PASSWORD or AUTH, token shapes (`sk-ant-…`, JWTs, Google tokens, bearer headers), SSH public keys, email addresses, the home folder (`$HOME`) and the person's folder layout under it (`$HOME/<path>`, `-Users-<path>`), the scratch folder (`$SCRATCH`), the user name, the host name and the git user name, claude.ai connector names, plan and subscription names, rate-limit and overage details, the signing service's name, and keys such as `email` or `accountUuid`. Inventory lists (`tools`, `mcp_servers`, `plugins`, `skills`, `commands`, `agents`) keep only the spike's own entries and what every install has, with a count of the rest. Words to mask beyond that (an employer, a client) go comma-separated in `$SPIKE_SCRATCH/redact-words`, which is never committed. After changing it, run `target/debug/acp-spike redact $(find fixtures -type f)`.

`cargo test` scans every committed fixture, with its streamed runs joined, for user paths, emails, token shapes, connector names and plan names, and for `$USER` and any word in `SPIKE_REDACT_WORDS`; it fails on a hit.

ACP messages from the agent are also parsed into the `agent-client-protocol` 5.5.1 v1 types; a mismatch adds a `schema_mismatch` note. The wire itself is written by hand, so the transcript is exactly what crossed it.

## Run the checks

Needs: `claude`, `codex` and `agy` signed in on your normal logins, Node, Rust (`/opt/homebrew/opt/rustup/bin` on the owner's Mac), and git that can commit in a scratch repo.

```bash
export SPIKE_SCRATCH=$(mktemp -d)/h0      # under your temp folder, never a real config folder
cargo build
mkdir -p "$SPIKE_SCRATCH/adapters" && cd "$SPIKE_SCRATCH/adapters" && echo '{"private":true}' > package.json \
  && npm install --ignore-scripts --save-exact @agentclientprotocol/claude-agent-acp@0.109.1 @agentclientprotocol/codex-acp@2.9.0 \
  && cd -
bash scripts/claude-native.sh 1-edit-run
```

Each script takes one check name: the case labels at the top level of its `case` (`grep -E '^  [0-9][^)]*\)' scripts/claude-native.sh`). The numbers are the checks of H0:

| # | Check |
| --- | --- |
| 0 | Setup only: capabilities, modes, models, the process tree |
| 1 | One prompt that edits a file and runs a command; every kind of event |
| 2 | A permission request answered allow once and deny once |
| 3 | Cancel in the middle of a turn, then another prompt |
| 4 | `kill -9` of the driver in the middle of a turn, then resume by id |
| 5 | An HTTP MCP server with a bearer token; then a tool call held 540 s (`5-hold-*`, about 10 minutes each) |
| 6 | Model and effort per session |
| 7 | An empty scratch login folder beside the real one |
| 8 | The person's own setup: settings, an allow rule, a hook, an MCP server, `CLAUDE.md` and `AGENTS.md` |
| 9 | Folder trust |
| 10 | Commit and push to the local bare remote |
| 11 | The locked profile (Pip's flags) and three attempts that must be impossible |
| 12 | Which program an ACP adapter starts |
| 13 | Tool limits per session (`claude --agent`) |
| 14 | The Workflow tool and the agent-pr-pipeline plugin in a `claude -p` session |
| 15 | `agy -p` with stdout piped and no terminal |
| r1 | Two MCP servers per session, the endpoint named `spk` + 8 hex, and a pair whose names collide with underscores |
| r2 | `ask` answers "question pending" after 20 s, and the answer comes as the next prompt |
| r4 | The locked profile with the endpoint by control request (Claude) |
| r7 | A turn that ends while its command still runs, then 60 s idle (agy) |

`CLAUDE_MODEL` (default `haiku`) and `AGY_MODEL` pick cheap models. `CLAUDE_ACP_CLI=own bash scripts/claude-acp.sh <check>` points the Claude adapter at your own `claude` instead of its bundled copy and writes to `fixtures/claude/acp-own-cli/`. The `agy` checks that need a model exit 3 with "blocked: agy is not signed in" until you run `agy` once and sign in.

### Rules the scripts keep

- Each script records the login folders' config files when it starts (a hash; size and modification time only for a credential file), checks them every 2 s while it runs, and compares them when it ends. A change, even one undone before the end, fails the script with exit 9 and names the file. `bash scripts/selfcheck.sh` proves this against a scratch `HOME`.
- They write only under `$SPIKE_SCRATCH` and `fixtures/`. `env.sh` refuses a scratch folder inside `~/.claude*`, `~/.codex*`, `~/.gemini*` or `~/Gossamr`. A second login folder is always an empty scratch folder.
- The only remote is `$SPIKE_SCRATCH/remote.git`.
- Agents start without the variables of a Claude Code session that runs the scripts (`CLAUDE*`, `ANTHROPIC_*`, `MCP_*`, `AI_AGENT`, `CODEX_*`, `OPENAI_*`); a check passes what it needs with `--env`.
- The CLIs still write their own state for each session on the login they run on: `~/.claude/projects/…`, `~/.codex/sessions/…` and its SQLite files, `~/.gemini/antigravity-cli/…`. The scripts do not remove it, because that would write to those folders.

### Afterwards

```bash
pgrep -fl 'claude|codex|agy|acp-spike'                 # nothing of yours
git -C "$SPIKE_SCRATCH/clone" worktree list            # only the clone itself
rm -rf "$SPIKE_SCRATCH"
```
