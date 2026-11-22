# Plan: the harness

This plan builds [the harness proposal](harness-proposal.md). One orchestrating session runs it: for each step it starts a build session, then a verify session and a review session that know nothing of the build session's reasoning, and it merges the step into the integration branch `harness`. `main` changes only when the maintainer merges.

A first draft of this plan was reviewed adversarially by three readers, and its rewrite by a fourth. Their blockers are answered in the design (proposal section 10) and in the entries below.

## Goals this serves

- **Agents take a ticket from plan to pull request, and you only make the decisions.** Pipelines (H19 to H22) extend this from one ticket to a release.
- **Work with the tools you already use.** Gemini is added and a provider becomes a row (H6 to H13).
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

### G0. Goals

- **Touches:** `docs/goals.md` only.
- **Does:** the goal and non-goal wording of proposal section 4.
- **Lands as:** alfhen/gossamr-app#451, a pull request to `main` of its own for the maintainer, as `docs/goals.md` requires. The build goes on meanwhile on `harness`. The final pull request is not offered for merge before G0 is merged.
- **The rules in `AGENTS.md` and `docs/product.md`** describe the code, so each changes on `harness` in the step that changes the behaviour: rule 2 in H5 and H9, rule 4 in H10 to H13, rule 3 in H16, rule 1 in H19 and H20. H23 checks that the result matches proposal section 4.

### H0. Check the providers for real (gate)

- **Touches:** new `spikes/acp/`, new `docs/harness-findings.md`. No product code.
- **Does:** for Claude, Codex and Gemini (`agy`), on the owner's logins, the checks of proposal section 5 on each path a driver could use: the native two-way stream, and ACP. For each: a prompt that edits and runs a command; a permission request answered allow and deny; cancel; kill the client in the middle of a turn, record whether the agent and its commands died, then resume by id; an HTTP MCP server per session with a token and a call held 9 minutes; model per session; a second login folder; whether settings, hooks, permission rules and instruction files apply; folder trust; commit and push; the locked profile, proven by the advertised tool list; which program an adapter really runs; tool limits per session; the Workflow tool with the agent-pr-pipeline plugin inside a `claude -p` session; `agy -p` with no terminal.
- **Acceptance:** `docs/harness-findings.md` has one row per check, provider and path with the command, what was seen and the version, and ends with a decision per provider and the outcome of every row of proposal section 5. Each check has a redacted transcript under `spikes/acp/fixtures/`. `pgrep -fl 'claude|codex|agy'` and `git worktree list` in the scratch repo show nothing left. A "stop" row that fails ends the build for that provider and goes to the owner.
- **Verify:** reruns every check.
- **A provider that H0 stops is skipped.** Its driver step (H6, H7 or H8) and every acceptance line that names it are dropped, the other providers go on, and the final pull request lists it. H13's "Gemini appears in Settings" then shows it as not available, with the reason.

### H1. Green baseline and a workspace

- **Touches:** a root `Cargo.toml` workspace with `src-tauri` and a new `crates/harness` (a binary that prints its version), `Cargo.lock`, CI (workspace paths, cache, a Linux job for the harness crate, the e2e jobs), `.coderabbit.yaml`, the six tests in `runs::binary`, `inbox::models`, `inbox::provider_probes`, and two flaky tests.
- **Does:** makes the six tests independent of the machine's PATH and CLIs. Makes CI green again, which it is not on `main` today: the e2e jobs fail at `playwright install` since `ubuntu-latest` became 26.04, and two Rust tests fail now and then on the CI Macs (`agent::agent_tools::tests::a_server_that_restarts_on_the_same_port_is_invisible_because_each_request_stands_alone`, a port another process can take between two binds; `runs::codex::tests::control::after_attach_a_codex_run_stays_stopped_until_terminal_runs_then_reads_done_carried_on_in_terminal`). Adds the workspace with no change to the app's code.
- **Regression test:** the six tests pass with `codex`, `gemini` and `agy` installed, and with a PATH that has none of them. Each flaky test passes 200 runs in a row.
- **Acceptance:** the checks pass on this Mac and in CI. `cargo tree -p harness` shows no `tauri` and no `gossamr`. `pnpm tauri build --debug` exits 0 and the built app's process is still up ten seconds after it starts.

### H2. Harness: sessions, events and the mock provider

- **Touches:** `crates/harness` only.
- **Does:** its own SQLite file with its own migration list, in a data folder it locks so two harnesses cannot share it. Sessions and events with a sequence number. Redaction before anything is stored; no payload stored for a locked session; payload dropped at clean-up or after 30 days. The driver interface with capability flags. A limit on sessions in a turn. A mock provider that plays a script and replays H0's fixtures. `harness run --provider mock` runs a session in-process and prints its events.
- **Regression test:** a session's life against the mock: prompt, text, tool call, permission request, answer, cancel, end, failure. A second harness on the same data folder is refused. A secret in agent text never reaches the store. A locked session's text is in no table. A session past the limit waits.
- **Acceptance:** `harness run --provider mock --script <fixture>` prints the fixture's events in order and exits 0.

### H3. Harness: the API and the command line

- **Touches:** `crates/harness` (server, client module, CLI).
- **Does:** `harness serve` on a Unix socket in a folder only the user can open. The first client token is handed over at first start; `harness token new` needs a valid token. A client proves its token by answering a challenge. A descriptor with protocol number and build id. Requests: open a session, send a message, cancel, answer a permission request, answer a question, post a tool result, close, clean up, list sessions, list providers. Events over a WebSocket from a sequence number. A session option "ends when its client leaves". A Rust client, used by `harness sessions`, `events`, `send`, `answer` and later by the app.
- **Regression test:** no token, a wrong token and a session's tool token are refused on the client API. `token new` without a token is refused once one exists. The token is never sent on the socket (the test's fake server sees only the challenge answer). A client that reconnects with a sequence number gets exactly what it missed. A session that ends with its client is not resumed.
- **Acceptance:** with `harness serve` running, `harness run --provider mock` from a second terminal streams the events of H2; after `kill -9` of that client, `harness events --after N` prints the rest; `harness answer` allows a mock permission request.

### H4. Harness: clones, worktrees and logins

- **Touches:** `crates/harness`; `src-tauri` depends on the harness crate. Moves, with their tests, `runs/repo.rs`, `runs/fresh.rs`, `runs/env.rs`, `runs/provider_env.rs`, `runs/binary.rs`, `runs/provider_folder.rs` and `provider_probe.rs` into the harness, onto its own types. The app imports them from there, with thin conversions at the call sites (`runs/`, `claude/mod.rs`, `inbox/pip_model.rs`, `inbox/provider_probes.rs`, `inbox/providers.rs`, `inbox/models.rs`). One copy, never two.
- **Does:** a session may name a repo, base and branch; the harness clones into its work root, fetches, adds a worktree, and removes it on clean-up without ever forcing. The provider table as code, with a login folder per instance. The shell environment is captured again each time a client connects. `harness providers` reports installed, signed in and models per login.
- **Regression test:** the moved tests pass in their new home, among them the credential-helper refusal, the symlinked owner folder and unpushed work refused. The app's own tests pass unchanged.
- **Acceptance:** `harness providers` on this Mac lists Claude and Codex as signed in and an empty scratch login folder as signed out, in one call.

### H5. Harness: the tools endpoint

- **Touches:** `crates/harness`. Moves the transport, token and origin checks out of `agent/mcp.rs`, and `runs/ask.rs`, the same way as H4; the app's server keeps working on the moved code.
- **Does:** one MCP endpoint per session on loopback with its own token, stored as a hash. `result` with an optional schema. `ask`: stored, survives a restart, blocks "carry on", answered through the API. Tools the client declared: each call is an event the client answers; with no client it fails at once. A cap on calls per session. Each provider row names the setting that makes a tool call outwait a question, and a test asserts the numbers.
- **Regression test:** a session's token opens only its own tools and stops working when the session closes. A request from a web page or another host is refused. A `result` that does not fit its schema goes back to the agent with the reason. The token is in no argv, log or event. A question asked before a restart is still open after it.
- **Acceptance:** the mock provider calls a client tool; `harness events` shows the call; `harness` posts an answer and the mock receives it.

### H6. Harness: the Claude driver

- **Touches:** `crates/harness`. Moves the launch flags and stream parser of `claude/mod.rs` and `claude/stream.rs` with their flag tests; the app's Pip keeps working on the moved code.
- **Does:** the driver H0 decided for Claude. The normal profile adds only the tools endpoint, the guard and a model. The locked profile is today's flag list. Leftovers of a dead harness are stopped at start, by pid and start time. Resume by id with the "carry on" rule.
- **Regression test:** against the fake Claude: the exact argv of both profiles; no restricting flag in the normal one; a restart in the middle of a turn resumes once; a restart with an open question sends no "carry on"; a reused pid is never signalled.
- **Acceptance (real, `cargo test -p harness -- --ignored claude_real`):** in a scratch worktree the agent edits a file, asks through `ask`, is answered, commits, and ends with a `result` that fits a schema. A locked session's advertised tools are exactly the declared ones.

### H7. Harness: the Codex driver

- **Touches:** `crates/harness`.
- **Does:** the driver H0 decided for Codex, with the same life as H6 and no `--sandbox` or approval flag from us. A run the person's sandbox stops from committing says so.
- **Regression test:** against the fake Codex: the argv; the token only in the environment; a reused pid is never signalled.
- **Acceptance (real, `-- --ignored codex_real`):** the H6 scenario, with the sandbox outcome recorded.

### H8. Harness: the Gemini driver

- **Touches:** `crates/harness`.
- **Does:** `agy` through ACP, or what H0 decided. One login unless H0 found a way to keep two apart.
- **Regression test:** the driver against the mock replaying H0's `agy` fixtures.
- **Acceptance (real, `-- --ignored gemini_real`):** the H6 scenario. If `agy` is not signed in the step waits; it is not merged on fixtures alone.

### H9. The app starts or adopts the harness

- **Touches:** `src-tauri/` (bundling, a manager that starts the harness detached with `std::process`), `secrets.rs` (the client token joins the vault item), Settings.
- **Does:** proposal section 3.2, "Start or adopt". CI builds the harness before the app.
- **Regression test:** the manager against a fake harness: start, adopt, keep an older one with the same protocol, replace one with another protocol, refuse a newer one, restart a dead one, never two. With a file-backed test vault: the token is in the vault and `rg` finds it in no file under the data folder.
- **Acceptance:** start the built app; `pgrep -x harness` finds one process; quit the app; `harness sessions` (token from the test vault of a debug build) still answers.

### H10. Claude runs on the harness

- **Touches:** `src-tauri/src/runs/` (service, a new event consumer), `domain/run.rs`, `db/`, `agent/agent_tools.rs`, the run parts of `src/workspace/`, the mock and e2e.
- **Does:** every Claude run, from Pip or from an approved draft, opens a harness session. The consumer turns events into state, the timeline, notices and Pip's wakes. One "send message". `report` becomes `result`; `read_ticket` and `read_workstream` are client tools; `ask` is the harness's. The app's queue keeps its order and waits when the harness is at its limit. A migration stops every `--bg` session the old code started and marks its run interrupted; its worktree stays and Clean up removes it with git.
- **Regression test:** with the mock provider: start, stream, ask, answer, stop, a harness restart in the middle of a turn, clean-up with unpushed work refused, a full limit. An `app.sqlite` from `main` with a Claude run in every state opens and shows each with a sensible state.
- **Acceptance (real, an `#[ignore]` test that starts the harness):** Pip's start path launches a Claude agent in a scratch workstream; it edits, asks, is answered, commits and returns a `result`; the test asserts the first text event is stored by the app less than one second after the harness emitted it.

### H11. Permission answers in the app

- **Touches:** the consumer, `src/workspace/` (Needs you, the run sheet), Settings per repo, the mock and e2e.
- **Does:** a permission request is a Needs you item with Allow and Deny, once. The per-repo setting of proposal section 3.2, checked against the real path. Where the provider path cannot be answered, the run stops and offers "Take over in Terminal" (H14).
- **Regression test:** allow and deny reach the mock. With the setting on: an edit inside the worktree is allowed; an edit under `.git`, through a symlink out of the worktree, a command, and anything on a locked session are not.
- **Acceptance:** a Playwright spec on the mock for the two buttons; the Rust tests above.

### H12. Codex runs on the harness

- **Touches:** `runs/service.rs`, the consumer, the mock and e2e.
- **Does:** Codex runs open a harness session. A migration stops every Codex process the old code started and marks its run interrupted.
- **Regression test:** the H10 list with the mock provider standing in for Codex; the migration on a database with a live Codex run.
- **Acceptance (real):** the H10 scenario on Codex.

### H13. Providers as data, and Gemini

- **Touches:** `connections.rs`, `config.rs`, `model_choice.rs`, `inbox/providers.rs`, `inbox/provider_probes.rs`, `inbox/models.rs`, `src/lib/models.ts`, the provider UI, the mock and e2e.
- **Does:** `Driver` stops being a closed pair. Label, sign-in command, install hint, models and "can run Pip" come from the harness. Gemini appears in Settings and can run agents.
- **Regression test:** an unknown provider id in `config.json` disables that entry and nothing else.
- **Acceptance (real):** the H10 scenario on Gemini. `rg '"claude" \| "codex"' src` finds nothing.

### H14. Take over in Terminal

- **Touches:** `runs/control.rs`, the run sheet.
- **Does:** stops the harness's session, marks the run handed over, shows the provider's resume command in the worktree, and refuses a message to it until "Resume here".
- **Regression test:** a message to a handed-over run is refused; "Resume here" reopens the session by id.
- **Acceptance:** those tests, and a Playwright spec on the mock.

### H15. Live output

- **Touches:** `wire.rs`, `src/backend/events.ts`, the run sheet and agents view.
- **Does:** text and tool calls show as they arrive. Still four event names.
- **Regression test:** a page that opens in the middle of a turn shows the whole turn once, in order (Playwright on the mock).
- **Acceptance:** that spec, and the H10 test extended to the page's event.

### H16. Pip through the harness

- **Touches:** `agent/mod.rs`, `agent/mcp.rs`, `agent/supervisor.rs`, `claude/`, `inbox/pip_model.rs`.
- **Does:** a Pip turn is a locked harness session that ends when the app leaves; Pip's tools are client tools; the app's MCP server, port file and token table go. Pip is woken by session events. A timer stays for wakes that were given back, and a resumed workstream is checked once.
- **Regression test:** the lock-down tests on the locked profile. `the_tools_are_the_neutral_set_and_none_of_them_writes` passes unchanged. A wake refused for quota is retried. A run that finished while its workstream was paused wakes Pip on resume. Pip's text is not in the harness's store.
- **Acceptance (real, `-- --ignored pip_real`):** Pip answers, drafts a Jira comment on a fixture connection and starts an agent; asked to read a file, run a command and fetch a URL, its session lists no tool that could.

### H17. Remove the old run path

- **Touches:** deletes `runs/state.rs`, `final_answer.rs`, `transcript.rs`, `continuation.rs`, `index.rs`, `trust.rs`, `service/trust.rs`, `backend.rs`, `backend/`, `codex/`, the `--bg` parts of `cli.rs`, the script writers in `control.rs`, what is left of `claude/`, `failureHelp.ts`, `RunContinuation.tsx`, and their tests.
- **Regression test:** the migration tests of H10 and H12 still pass.
- **Acceptance:** `rg 'claude agents|--bg|claude rm|codex exec' src-tauri/src` finds only the one-time stop. The checks pass. The pull request lists the removed lines per row of proposal section 6 and every action a person lost.

### H18. Your own server

- **Touches:** `crates/harness` (Linux), `src-tauri` (an SSH forward the app starts and stops), Settings ("Where agents run"), `README.md`.
- **Does:** proposal section 3.5.
- **Regression test:** the app against a second harness with its own data folder and socket: it switches to it, runs a mock session there, reads missed events after a dropped connection, a client tool call made while it was away failed at once, and it switches back. The Linux CI job builds and tests the harness.
- **Acceptance:** that test; and, if `ssh localhost true` exits 0 on this Mac, the same through a real SSH forward.
- **Not checked here:** a real server with real logins.

### H19. Landing in code

- **Touches:** `codehost/` (reads: checks, reviews, changed paths, a file on the default branch; one write: merge a pull request at a named commit), `inbox/` (a landing module), Settings per repo (the choice, and the review bot's login).
- **Does:** the five checks of proposal section 3.4, failing closed.
- **Regression test:** on the fake GitHub server: each condition failing alone blocks the merge; a moved head blocks it; a 403 on checks, no checks at all, and more changed files than were listed each block it; a reply or a resolved thread from the owner's account is not an approval; an approval from a bot that is not the named one is not either; a gates file changed in the pull request is read from the default branch; a repo where the person has landed no wave yet waits for the person even when all five hold.
- **Acceptance:** those tests. No real merge is made by this step.

### H20. Pipelines, stage 1

- **Depends on:** H0's Workflow-tool check. If it failed, this step is skipped.
- **Touches:** `agent/` (Pip tools: propose a wave, read a wave), `domain/` (a wave), `src/workspace/` (wave proposals and escalations in Needs you, a wave list).
- **Does:** proposal section 3.4, stage 1. Pip proposes; the person starts. The agent runs the wave workflow and none of the landing steps. The session gets no "carry on"; "Resume wave" uses the pipeline's own resume. A repo with no goals document or gates file gets no wave and a message that says what is missing.
- **Regression test:** on the mock provider and the fake GitHub: Pip cannot start a wave, only propose one; an escalation waits in Needs you and its answer reaches the agent; a restart shows the wave interrupted and sends nothing; a missing goals file refuses.
- **Acceptance (real):** on a scratch private GitHub repo, made only after the owner says yes, a two-entry plan goes through a wave on Claude up to open pull requests. `gh pr list --state merged` on that repo is empty until the person merges.

### P1. agent-pr-pipeline changes (in that repo)

- **Touches:** `alfhen/agent-pr-pipeline`: a `script()` hook that `run-wave.js` uses when its host offers one, a neutral agent marker beside `CLAUDECODE` in `merge-pr.sh`, the "Claude Code only" non-goal.
- **Lands as:** a pull request there for the owner. Gossamr pins a commit in a path only the owner merges.
- **Acceptance:** that repo's `node --test` passes, and Claude Code runs it unchanged.

### H21. Harness: the workflow host

- **Touches:** `crates/harness` (a `workflow` module and a small Node runner).
- **Does:** runs a workflow script with `args`, `agent()`, `parallel()`, `log()` and `script()`. `agent()` opens a session from a role file; on Claude the role runs as the person's own agent definition, so its tool limits apply; on a provider that cannot enforce a role's limits the session gets a throwaway clone and is marked "limits not enforced". Script steps run a pinned script with no model. Fan-out respects the harness's limit.
- **The journal.** A call is written down before it starts and again when it ends. After a restart a finished call is replayed from the journal. An agent call that had started resumes its own session. A script step that had started but not ended may already have written to GitHub: it is run again only if the workflow marked it safe to repeat; otherwise the workflow stops and asks the person.
- **Regression test:** agent-pr-pipeline's simulation scenarios pass on this host with the mock provider. A killed workflow resumes and repeats no finished call. A harness stopped between a script's effect and its journal entry does not repeat the effect.
- **Acceptance (real, `harness workflow run spikes/three-step.js`):** write, verify from a clean clone, review, each on a different provider; the journal shows three sessions on three providers.

### H22. Pipelines, stage 2

- **Touches:** `agent/` (waves run on the host), Settings (a login per role), the wave view, landing (the merge-safety verdict now comes from its own session).
- **Regression test:** a wave on the host with the mock provider and the fake GitHub, with review on a different provider from build; "merge when all five hold" merges on the fake GitHub only when all five do.
- **Acceptance (real):** the H20 wave with build on one provider and review on another. No real automatic merge is made: the scratch repo has no review bot.

### H23. Docs and the final pull request

- **Touches:** `README.md`, `AGENTS.md` (layout, run it, how to change things), `docs/product.md`, `docs/agents-cli-findings.md`.
- **Does:** the docs match the code. One pull request from `harness` to `main` that lists every step, what was verified, and what was not.

## Order

| Wave | Steps | Notes |
| --- | --- | --- |
| 0 | G0, H0, H1 | Parallel: `docs/goals.md`, `spikes/`, workspace |
| 1 | H2, H3 | One after the other |
| 2 | H4, H5 | One after the other |
| 3 | H6, H7, H8 | One after the other; H9 beside them |
| 4 | H10, H11, H12, H13, H14 | One after the other |
| 5 | H15, H16 | Parallel: page, Pip |
| 6 | H17 | H19 beside it |
| 7 | H18 | |
| 8 | H20, P1 | Parallel: two repos |
| 9 | H21, H22 | One after the other |
| 10 | H23 | |

The owner has something usable after wave 4: all three providers, live state, and permission answers in the app. Each later wave adds one thing.

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
- **Automatic merging is never exercised for real.** It is tested against the fake GitHub only. This repo's review bot never approves, and the scratch repo has none. The first real use is the owner's, and the first wave in a repo waits for the owner anyway.
- **Same user.** Agents run as the owner, like the harness. The controls stop accidents and simple injection, not a program that sets out to read the harness's store (proposal section 8).
- **Provider terms** are the owner's decision (proposal section 8).
- **One GitHub account.** Landing is checked in code, but an agent can still call `gh`. Branch protection and a second account are the owner's to set up.
- **Stage 2 of pipelines** (P1, H21, H22) is the largest and least certain part. It is built last and can be left out without touching the rest.
- **The window** is checked by building and starting the app and by tests on the page, not by a person's eye.
- **H20 needs a scratch GitHub repo.** The orchestrator asks before creating one.
- **Sessions can only be started on a turn the owner began, or one that follows a finished session.** If that chain breaks, the orchestrator needs one word from the owner to go on.
