# Plan: the harness

This plan builds [the harness proposal](harness-proposal.md). One orchestrating session runs it: for each step it starts a build session, then a verify session and a review session that know nothing of the build session's reasoning, and it merges the step into the integration branch `harness`. `main` changes only when the maintainer merges.

A first draft of this plan was reviewed adversarially by three readers. Their blockers are answered in the design (proposal section 10) and in the entries below.

## Goals this serves

- **Agents take a ticket from plan to pull request, and you only make the decisions.** Pipelines (H15 to H19) extend this from one ticket to a release.
- **Work with the tools you already use.** Gemini is added and a provider becomes a row (H6 to H10).
- A new goal, proposed in G0: **you set goals and gates for a repo, and Pip builds inside them.**
- Non-goals changed on the owner's instruction of 22 Nov 2026: "No sandbox or agent harness of its own", "No hosted service, for now", "macOS only, for now", and rule 1 for GitHub. G0 rewords them.
- Non-goals kept: no writes to Jira without a draft, not a replacement for the tracker, Pip stays locked down.

## How the build is run

1. **Build.** One session per step on Opus, in its own worktree, on a branch cut from `origin/harness`. Its brief is the entry below plus the findings it needs.
2. **Evals first.** Before writing code the build session writes the step's evals into the pull request: plain sentences, each with the command that checks it. They include every Acceptance line. Afterwards they may be added to, never weakened.
3. **Verify.** A second session, from a clean clone of the branch: runs the checks, runs every eval, removes the change to prove each regression test fails without it, and uses the feature the way a person would, on real providers where the entry says so.
4. **Review.** A third session, beside the second: reads the diff against the entry and the rules with the aim of refuting it. Findings are blocker, major or minor.
5. **Fix.** Blockers, majors and failed evals go back to the build session. Steps 3 to 5 repeat, at most four rounds. A step that does not converge is stopped and reported, not merged.
6. **Land.** The orchestrator squash-merges the pull request into `harness` when CI is green, verify passed, review has no blocker or major, and CodeRabbit's comments are answered. Minors become issues.
7. **After each wave** the orchestrator runs the full checks on `harness`.

Sessions that write the same files run one after the other.

## Rules for every step

- The app works after every step: it starts, signs in, shows tickets, Pip answers, and a Claude agent runs.
- Each step adds a regression test that fails when the change is removed.
- Tests never touch the real `~/.claude*`, `~/.codex`, `~/.gemini`, the Keychain or the real PATH. They use the fake CLIs in `src-tauri/test-support/` and the mock provider (H2).
- Real-provider checks are `#[ignore]` tests or scripts under `spikes/`, run by the verify session on the owner's logins, in a scratch repo under the session's temp folder with a local bare repo as its remote. Each proves afterwards that no process, worktree or scratch login is left.
- Every library or CLI API is checked against current documentation (Context7 first) and the installed version. What differs goes into `docs/harness-findings.md`.
- A step that deletes code deletes its tests and its UI in the same pull request, and says what a person can no longer do.
- The TypeScript mock and the e2e specs are kept in step by the step that changes a behaviour they cover.
- Schema changes are new steps at the end of `APP_STEPS` or `STEPS`. The harness has its own database and its own step list.
- The rules in `AGENTS.md` hold as G0 words them. A step that needs a rule changed stops and says so.
- No step merges to `main`, force-pushes, changes a provider login or a file in a login's config folder, or touches `~/Gossamr`.
- Under about 800 non-test lines added per step. Code that moves does not count.
- An acceptance line names a command and what it prints. "Looks right" is not one.
- Checks: `pnpm typecheck && pnpm test && pnpm build`, `mkdir -p dist && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`, `pnpm e2e`. On this Mac `cargo` is at `/opt/homebrew/opt/rustup/bin`.

## Steps

### G0. Goals and rules

- **Touches:** `docs/goals.md`, `AGENTS.md` ("Rules that must hold"), `docs/product.md`, `.coderabbit.yaml` path instructions.
- **Does:** the wording of proposal section 4, each changed sentence mapped to a line there.
- **Lands as:** a pull request to `main` of its own, for the maintainer, as `docs/goals.md` requires. The build goes on meanwhile on `harness`. The final pull request is not offered for merge before G0 is merged.

### H0. Check the providers for real (gate)

- **Touches:** new `spikes/acp/`, new `docs/harness-findings.md`. No product code.
- **Does:** for Claude, Codex and Gemini (`agy`), on the owner's logins, the checks of proposal section 5, on each path a driver could use: the native two-way stream, and ACP. For each: handshake; a prompt that edits and runs a command; a permission request answered allow and deny; cancel; kill the client in the middle of a turn, record whether the agent and its commands died, then resume by id; an HTTP MCP server per session with a token and a call held 9 minutes; model per session; a second login folder; whether settings, hooks, permission rules and instruction files apply; folder trust; commit and push; the locked profile, proven by the advertised tool list; which program an adapter really runs; tool limits per session (`claude --agent <role>` and what the others offer); the Workflow tool with the agent-pr-pipeline plugin inside a `claude -p` session; `agy -p` with no terminal.
- **Acceptance:** `docs/harness-findings.md` has one row per check and provider with the command, what was seen and the version, and ends with a decision per provider and the outcome of every row in proposal section 5. Each check has a redacted transcript under `spikes/acp/fixtures/`. A "stop" row that fails ends the build for that provider and is reported to the owner.
- **Verify:** reruns every check.

### H1. Green baseline and a workspace

- **Touches:** a root `Cargo.toml` workspace with `src-tauri` and a new `crates/harness` (a binary that prints its version), `Cargo.lock`, CI (`ci.yml`: workspace paths, cache, a Linux job for the harness crate), `.coderabbit.yaml`, the six tests in `runs::binary`, `inbox::models`, `inbox::provider_probes`.
- **Does:** makes those tests independent of the machine's PATH and CLIs. Adds the workspace with no change to the app's code.
- **Regression test:** the six tests pass with `codex`, `gemini` and `agy` installed and with none.
- **Acceptance:** all checks green on this Mac and in CI. `pnpm tauri build --debug` produces an app that starts.

### H2. Harness: sessions, events and the mock provider

- **Touches:** `crates/harness` only.
- **Does:** its own SQLite file with its own migration list, in a data folder it locks so two harnesses cannot share it. Sessions and events with a sequence number. Redaction before anything is stored. The driver interface with capability flags. A mock provider that plays a script and replays H0's fixtures. `harness run --provider mock` runs a session in-process and prints its events.
- **Regression test:** a session's life against the mock: prompt, text, tool call, permission request, answer, cancel, end, failure. A second harness on the same data folder is refused. A secret in agent text never reaches the store.
- **Acceptance:** `harness run --provider mock --script <fixture>` prints the fixture's events in order and exits 0.

### H3. Harness: the API

- **Touches:** `crates/harness` (server, client module, CLI).
- **Does:** `harness serve` on a Unix socket in a folder only the user can open. A client token whose hash is stored; `harness token new` prints one once. A descriptor with protocol number and build id. Requests: open a session, send a message, cancel, answer a permission request, post a tool result, close, clean up, list sessions, list providers. Events over a WebSocket from a sequence number. A Rust client used by the CLI (`harness sessions`, `harness events`) and later by the app.
- **Regression test:** no token, a wrong token and a session's tool token are all refused on the client API. A client that reconnects with a sequence number gets exactly what it missed. Two clients see the same order.
- **Acceptance:** with `harness serve` running, `harness run --provider mock` from a second terminal streams the same events as in H2, and after `kill -9` of the client, `harness events --after N` prints the rest.

### H4. Harness: clones, worktrees and logins

- **Touches:** `crates/harness`. Copies, with their tests, `runs/repo.rs`, `runs/fresh.rs`, `runs/env.rs`, `runs/provider_env.rs`, `runs/binary.rs`, `runs/provider_folder.rs`, `provider_probe.rs` from `src-tauri/src`, onto the harness's own types. The app's copies stay until H12.
- **Does:** a session may name a repo, base and branch; the harness clones into its work root, fetches, adds a worktree, and removes it on clean-up without ever forcing. The provider table as code, with a login folder per instance. The shell environment is captured again each time a client connects, so a new PATH is seen. `harness providers` reports installed, signed in and models per login.
- **Regression test:** the moved tests pass in their new home, among them the credential-helper refusal, the symlinked owner folder, and unpushed work refused. A folder login removes the shell's keys.
- **Acceptance:** `harness providers` on this Mac lists Claude and Codex as signed in, and an empty scratch login folder as signed out, at the same time.

### H5. Harness: the tools endpoint

- **Touches:** `crates/harness`. Copies the transport, token and origin checks of `agent/mcp.rs`, and `runs/ask.rs`.
- **Does:** one MCP endpoint per session on loopback with its own token, stored as a hash. `result` with an optional schema. `ask`, stored so it survives a restart and blocks "carry on". Tools the client declared, each call forwarded as an event and answered by the client. A cap on calls per session.
- **Regression test:** a session's token opens only its own tools and stops working when the session closes. A request from a web page or another host is refused. A `result` that does not fit its schema is returned to the agent with the reason. The token is in no argv, log or event.
- **Acceptance:** the mock provider calls a client tool; `harness events` shows the call; a posted answer reaches the mock.

### H6. Harness: the Claude driver

- **Touches:** `crates/harness`. Copies `claude/mod.rs` and `claude/stream.rs` with their flag tests.
- **Does:** the driver H0 decided for Claude. The normal profile adds only the tools endpoint, the guard and a model. The locked profile is today's flag list. Process identity by pid and start time; leftovers from a dead harness are stopped at start. Resume by id with the "carry on" rule: at most three, never after Stop, never with an open permission request or `ask`.
- **Regression test:** against the fake Claude: the exact argv of both profiles; no restricting flag in the normal one; a restart in the middle of a turn resumes once; a restart with an open `ask` does not send "carry on".
- **Acceptance (real, `#[ignore]`):** `harness run --provider claude` in a scratch worktree edits a file, asks through `ask`, gets the answer, commits, and ends with a `result` that fits a schema. A locked session's advertised tools are exactly the ones declared.

### H7. Harness: the Codex driver

- **Touches:** `crates/harness`.
- **Does:** the driver H0 decided for Codex, with the same life as H6 and no `--sandbox` or approval flag from us. A run that the person's sandbox stops from committing says so.
- **Regression test:** against the fake Codex: the argv; the token only in the environment; a pid that was reused is never signalled.
- **Acceptance (real):** the H6 scenario on Codex, with the sandbox outcome recorded.

### H8. Harness: the Gemini driver

- **Touches:** `crates/harness`.
- **Does:** `agy` through ACP, or what H0 decided. One login unless H0 found a way to keep two apart.
- **Regression test:** against the mock ACP agent replaying H0's `agy` fixtures.
- **Acceptance (real):** the H6 scenario on Gemini. If `agy` is not signed in, the step waits; it is not merged on fixtures alone.

### H9. The app starts or adopts the harness

- **Touches:** `src-tauri/` (bundling, a manager started with `std::process` so the harness is detached), `secrets.rs` (the client token joins the vault item), Settings.
- **Does:** on launch, adopt the harness on the app's socket if its build id matches. If the app is newer, ask it to stop when no session is in a turn, then start the bundled one. If the harness is newer, say "update Gossamr". Restart a dead one with backoff. Settings: harness state, and "Stop all agents and the harness". CI builds the harness before the app.
- **Regression test:** the manager against a fake harness: start, adopt, replace an older one, refuse a newer one, restart a dead one, never two. The token is read from the vault and is in no file.
- **Acceptance:** the built app starts the harness; `harness sessions` from a terminal with the app's token works; quit the app and the harness still answers its descriptor.

### H10. Runs on the harness

- **Touches:** `src-tauri/src/runs/` (service, a new event consumer), `domain/run.rs`, `db/`, `agent/agent_tools.rs`, `connections.rs`, `model_choice.rs`, `src/lib/models.ts`, the run and provider parts of `src/workspace/`, the mock and e2e.
- **Split:** (a) Claude runs open a harness session; the consumer turns events into state, timeline, notices and Pip's wakes; one "send message"; `report` becomes `result`; `ask`, `read_ticket`, `read_workstream` are client tools; the cap and the slot queue stay in the app. (b) Permission requests in Needs you with Allow and Deny, and the per-repo worktree-edits setting. (c) Codex runs on the harness. (d) `Driver` stops being a closed pair: provider facts come from the harness; Gemini appears in Settings and can run agents. (e) "Take over in Terminal": the session is stopped and marked handed over, the resume command is shown, and a message to it is refused until "Resume here".
- **Upgrade:** a one-time migration stops every session and Codex process the old code started and marks its run interrupted, before the old code is unused.
- **Regression test:** with the mock provider: start, stream, ask, answer, allow, deny, stop, a harness restart in the middle of a turn, clean-up with unpushed work refused, a full cap. A run started from an approved draft takes the same path. An `app.sqlite` from `main` with a run in every state opens and shows each with a sensible state.
- **Acceptance (real):** Pip starts an agent on each of Claude, Codex and Gemini in a scratch workstream; each edits, asks, is answered, commits and returns a `result`. An integration test asserts that the first text event is stored in the app less than one second after the harness emitted it.

### H11. Live output

- **Touches:** `wire.rs`, `src/backend/events.ts`, the run sheet and agents view.
- **Does:** the run sheet shows text and tool calls as they arrive. Still four event names.
- **Regression test:** a page that opens in the middle of a turn shows the whole turn once, in order (a Playwright spec on the mock).
- **Acceptance:** that spec, and the H10 integration test extended to the page's event.

### H12. Remove the old run path

- **Touches:** deletes `runs/state.rs`, `final_answer.rs`, `transcript.rs`, `continuation.rs`, `index.rs`, `trust.rs`, `service/trust.rs`, `backend.rs`, `backend/`, `codex/`, the `--bg` parts of `cli.rs`, the script writers in `control.rs`, the app's copies of what H4 and H5 moved, `failureHelp.ts`, `RunContinuation.tsx`, and their tests.
- **Regression test:** the migration test of H10 still passes. `rg "claude agents|--bg|claude rm|codex exec"` finds nothing under `src-tauri/src` outside the one-time stop.
- **Acceptance:** all checks green; the pull request lists the removed lines per row of proposal section 6 and every action a person lost.

### H13. Pip through the harness

- **Touches:** `agent/mod.rs`, `agent/mcp.rs`, `agent/supervisor.rs`, `claude/`, `inbox/pip_model.rs`.
- **Does:** a Pip turn is a locked harness session; Pip's tools are client tools; the app's MCP server, port file and token table go. Pip is woken by session events. A timer stays for wakes that were given back (quota), and a workstream that is resumed is checked once.
- **Regression test:** the lock-down tests, now on the locked profile. `the_tools_are_the_neutral_set_and_none_of_them_writes` still passes unchanged. A wake refused for quota is retried; a run that finished while its workstream was paused wakes Pip on resume.
- **Acceptance (real):** Pip answers, drafts a Jira comment and starts an agent. Asked to read a file, run a command or fetch a URL, it has no tool to do so.

### H14. Your own server

- **Touches:** `crates/harness` (Linux), `src-tauri` (an SSH forward the app starts and stops), Settings ("Where agents run"), `README.md`.
- **Does:** proposal section 3.5.
- **Regression test:** the app against a second harness with its own data folder and socket: it switches to it, runs a mock session there, reads missed events after a dropped connection, and switches back. The Linux CI job builds and tests the harness.
- **Not checked here:** a real server with real logins, and the SSH forward against a real host unless `ssh localhost` works on this Mac.

### H15. Landing in code

- **Touches:** `codehost/` (reads: checks, reviews, changed paths, a file on the default branch; one write: merge a pull request at a named commit), `inbox/` (a landing module), Settings per repo.
- **Does:** the five checks of proposal section 3.4, the per-repo choice, and the first-wave rule.
- **Regression test:** on the fake GitHub server: each of the five conditions failing alone blocks the merge; a moved head blocks it; a reply from the owner's account does not count as a bot's approval; a gates file changed in the pull request is read from the default branch; the first wave waits for the person even when all five hold.
- **Acceptance:** those tests. No real merge is made in this step.

### H16. Pipelines, stage 1

- **Depends on:** H0's Workflow-tool check. If it failed, this step is skipped.
- **Touches:** `agent/` (Pip tools: start a wave, read a wave), `domain/` (a wave), `src/workspace/` (escalations in Needs you, a wave list).
- **Does:** proposal section 3.4, stage 1. A repo with no goals document or gates file gets no wave and a message that says what is missing.
- **Regression test:** on the mock provider and the fake GitHub: an escalation waits in Needs you and its answer reaches the agent; a `result` feeds landing; a missing goals file refuses.
- **Acceptance (real):** on a scratch private GitHub repo, made only after the owner says yes, Pip takes a two-entry plan through a wave on Claude up to open pull requests. Landing is exercised with "I merge".

### P1. agent-pr-pipeline changes (in that repo)

- **Touches:** `alfhen/agent-pr-pipeline`: a `script()` hook that `run-wave.js` uses when its host offers one, a neutral agent marker beside `CLAUDECODE` in `merge-pr.sh`, the "Claude Code only" non-goal.
- **Lands as:** a pull request there for the owner. Gossamr pins a commit in a path only the owner merges.
- **Acceptance:** that repo's own tests pass, and Claude Code runs it unchanged.

### H17. Harness: the workflow host

- **Touches:** `crates/harness` (a `workflow` module and a small Node runner).
- **Does:** runs a workflow script with `args`, `agent()`, `parallel()`, `log()` and `script()`. `agent()` opens a session from a role file; on Claude the role runs as the person's own agent definition, so its tool limits apply; on a provider that cannot enforce a role's limits the session gets a throwaway clone and is marked "limits not enforced". Script steps run a pinned script with no model. A journal replays finished calls after a restart.
- **Regression test:** agent-pr-pipeline's simulation scenarios pass on this host with the mock provider. A killed workflow resumes and repeats no finished call.
- **Acceptance (real):** a three-step workflow (write, verify from a clean clone, review) with each step on a different provider.

### H18. Pipelines, stage 2

- **Touches:** `agent/` (Pip's wave tools point at the host), Settings (a login per role), the wave view.
- **Regression test:** a wave on the host with the mock provider and the fake GitHub, with review on a different provider from build.
- **Acceptance (real):** the H16 wave with build on one provider and review on another.

### H19. Docs and the final pull request

- **Touches:** `README.md`, `AGENTS.md` (layout, run it, how to change things), `docs/product.md`, `docs/agents-cli-findings.md`.
- **Does:** the docs match the code. One pull request from `harness` to `main` that lists every step, what was verified, and what was not.

## Order

| Wave | Steps | Notes |
| --- | --- | --- |
| 0 | G0, H0, H1 | Parallel: docs, `spikes/`, workspace |
| 1 | H2, then H3 | |
| 2 | H4, then H5 | |
| 3 | H6, H7, H8 | One after the other; H9 beside them |
| 4 | H10a to H10e | One after the other |
| 5 | H11, then H12 | |
| 6 | H13 | H15 beside it |
| 7 | H14 | |
| 8 | H16, P1 | Parallel: two repos |
| 9 | H17, then H18 | |
| 10 | H19 | |

The owner has something usable after wave 4: all three providers, live state, permission answers in the app. Each later wave adds one thing.

## Not in

| Item | Why it waits |
| --- | --- |
| Moving the whole backend into a daemon | Needed only for a thin client or for Pip with the laptop closed. It put 82 commands on a new wire first. |
| The page's tests on the real harness | UI work would need a Rust build. |
| Pairing, TLS, a listening port | SSH forwards the socket. |
| Several harnesses at once | One home at a time. |
| Pip on Codex or Gemini | Only if H0 proves a locked profile. |
| Switching logins on quota by itself | Decided against in the connections proposal. Needs you offers it. |
| Linear | Unrelated. |
| Cloud routines of agent-pr-pipeline | Tied to Claude Code's cloud. |

## Flagged concerns

- **H0 can change the plan.** Entries H6 to H8 name "the driver H0 decided". Their briefs are written after H0.
- **Provider terms** are the owner's decision (proposal section 8).
- **One GitHub account.** Landing is checked in code, but an agent can still call `gh`. Branch protection and a second account are the owner's to set up.
- **Stage 2 of pipelines** (P1, H17, H18) is the largest and least certain part. It is built last and can be left out without touching the rest.
- **The window** is checked by building and starting the app and by tests on the page, not by a person's eye.
- **H16 needs a scratch GitHub repo.** The orchestrator asks before creating one.
- **Sessions can only be started on a turn the owner began, or one that follows a finished session.** If that chain breaks, the orchestrator needs one word from the owner to go on.
