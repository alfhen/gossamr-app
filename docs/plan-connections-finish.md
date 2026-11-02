# Plan: finish the connections refactor

This plan finishes the work in [the connections proposal](connections-proposal.md): several AI providers and several Jira accounts, each picked per Pip turn and per agent run. Steps p1 to p6, r7, r8, r11, the first slice of r12, j15 to j21, j23 to j25, c0, c1, t1 and t2 are merged. What is left: two open PRs (#290, #291), the rest of r12, and r13, r14, j26, j27, d28 and c3 to c6. Each entry is one small PR. A PR is done when its acceptance test passes in CI, an adversarial review reports no blockers or majors, and it is squash-merged.

## Goals this release serves

- **Work with the tools you already use**: several Claude logins, Codex (beta) and several Jira accounts at once. Every entry serves this goal.
- **Agents take a ticket from plan to pull request**: r12b to r14 let a person choose which login and model an agent runs on, and keep runs on a signed-out or removed login from failing silently.
- **Do the day's tracker work in one place**: j26 and j27 show tickets from every Jira account in one Inbox and board.
- Non-goals it comes close to: **no sandbox or agent harness of its own**. The Codex runner (c3 to c6) drives the person's own `codex` CLI with their own config; it adds no sandbox, and it passes no `--sandbox` flag (owner decision, see D01). **No writes to Jira without a draft**: no entry adds a write path.

## Findings

Checked against `main` at 41cfff6 on 2 Nov 2026.

| Finding | Where | What is wrong |
| --- | --- | --- |
| #290 (r9) conflicts with main | `src/backend/mock.ts`, `mockWatch.ts`, `src/workspace/connectionsLogic.ts` | #292 changed the same lines. CI and Gitar passed before that. |
| #291 (j22) has an open Gitar bug | `src/claudeStore.ts:172`, `src-tauri/src/agent/mod.rs:427`, `src-tauri/src/inbox/pip_turns.rs:34` | A turn asked from another site's ticket is stored under `<connection>:<name>` but the page sends a bare name, so it vanishes on reload. |
| r12 is half done | `runs/cleanup.rs:112`, `inbox/models.rs:67` | A run whose instance was removed can't be cleaned up; a run on a signed-out login neither waits nor starts when it signs in. The unreviewed WIP commit 383732e on `providers/r12b-runs-record-instance` covers it. |
| Runs only track the default login | `runs/index.rs:17`, `runs/service.rs:101`, `runs/tracker.rs:229` and 12 more `tools.get()` calls | The gate at `model_choice.rs:254` keeps agents on the default instance until this is fixed. |
| Provider rows and pickers are hidden | `src/workspace/connectionsLogic.ts:11` (`providersShown = false`) | The backend honours a choice; nothing shows it yet. |
| One Jira in the front end | `src/Root.tsx:24,37,49`, `ConnectJira.tsx:344`, `Workspace.tsx:59`, `Rail.tsx:312` | Adding a second Jira account replaces the first. |
| The proposal does not record the Codex decisions | `docs/connections-proposal.md:135,364,532,590`, `docs/agents-cli-findings.md` | c2 still reads "only if c0 says yes"; the sandbox row says "owner to confirm"; no doc says Codex is beta. |
| Two low QA findings still hold | `src/backend/mockGithub.ts:114`, `ConnectGithub.tsx:88`, `ConnectJira.tsx:71` | The mock says "Checked 3m ago" right after Connect; + Add says "GitHub account" but the sheet says "Connect GitHub". |

## Scope

In:

| Group | Entries | Size |
| --- | --- | --- |
| Open PRs | L01 (#290), L02 (#291) | S each |
| Decisions in the docs | D01 | S |
| Runs per login | A01 (r12b), A02 (r13a), A03 (r13b), A04 (r14a), A05 (r14b) | M each |
| Several Jira accounts | B01 (j26), B02 (j27) | M each |
| Codex runner (beta) | C01 (c3), C02 (c4a), C03 (c4b), C04 (c5), C05 (c6) | M each |
| Docs and tidy-up | E01 (d28) | S |

Not in:

| Item | Why it waits |
| --- | --- |
| c2, Pip on Codex | Owner decision, 2 Nov 2026: Pip stays on Claude. Codex keeps built-in tools no flag removes (c0, check C1), which breaks AGENTS.md rule 3. |
| A switch that hides Codex | Owner decision, 2 Nov 2026: Codex shows like any provider, with a **Beta** label. |
| Pip starting reviewers for incoming review requests | Not in the goals yet; the maintainer may add it in a goals PR. |
| PRs #269 and #278 | Stale o10 checklist PRs. #278's branch would revert work on main. The maintainer closes both. |

## Order and waves

```mermaid
flowchart LR
  W1[Wave 1: L01, L02, D01, A01] --> W2[Wave 2: A02, B01]
  W2 --> W3[Wave 3: A03, B02]
  W3 --> W4[Wave 4: A04, C01]
  W4 --> W5[Wave 5: A05, C02]
  W5 --> W6[Wave 6: C03, E01]
  W6 --> W7[Wave 7: C04]
  W7 --> W8[Wave 8: C05]
```

Two tracks run side by side: runs and Codex (A, C) in `src-tauri/src/runs/`, and Jira (L02, B) in the front end. The runs and Codex track is a chain: A01 and A03 both edit `runs/cleanup.rs`; A02, A03, C01 to C04 edit `runs/{tracker,cli,toolchain,index,control}.rs`. A04, A05, B01 and C05 all edit `src/workspace/Connections.tsx` and `connectionsLogic.ts`, so they sit in different waves. L01 lands before L02, because both touch `src/backend/mock.ts` and `mockPip.ts`, and before A04, which reuses its `ModelPicker`. D01 changes docs only and goes in wave 1 so later entries read the decisions.

## Rules for every PR

- AGENTS.md holds: secrets only in the Keychain and never logged; Pip has only Gossamr's MCP tools; every Tauri command is registered and mirrored in `src/backend/types.ts`, `jira.ts` and the mock; camelCase serde matches TypeScript; schema changes are appended to the right `STEPS`; few comments; test names are behaviour sentences.
- Checks: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, then `mkdir -p dist && cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test`. Never run `#[ignore]` tests. e2e: `E2E_PORT=<port> pnpm e2e <spec>`; CI runs the full suite in 4 shards.
- Tests never touch the person's real `~/.claude.json`, `~/.claude-personal`, `~/.codex` or Keychain; use temp folders and the fake CLIs in `src-tauri/test-support/`.
- Each PR adds a regression test that fails when the change is removed. The PR description says how that was checked.
- Each negative test checks that its input really contains what the check looks for.
- New e2e tests go in new files, except where an entry names an existing spec.
- After merging `main` into a branch, rerun clippy and the tests locally: two PRs can each pass CI and still break main together (an unused function under `-D warnings`).

## PRs

### Wave 1

**L01 Land the model picker in Pip's drawer (#290, r9).** Touches: `src/backend/mock.ts`, `src/backend/mockWatch.ts`, `src/workspace/connectionsLogic.ts` (conflict resolution only).
- Merge `main` into `providers/r9-pip-model-picker` and keep both sides: #292's `providers.addClaude` handle and `providersVisible` export, and r9's picker state.
- No new behaviour. CI, Gitar and the bot answers were done before the conflict.
Regression test: the existing `ModelPicker.test.tsx`, `modelPicker.test.ts`, `claudeStore.test.ts` and the r9 block in `e2e/pip.spec.ts` still pass after the merge.
Acceptance: CI green on the merged head; `pnpm test` fails if the merge drops `providersVisible` (`src/workspace/connectionsLogic.test.ts`).

**L02 Fix the lost cross-site Pip turns and land #291 (j22).** Touches: `src/claudeStore.ts`, `src/lib/conversations.ts`, `src/backend/mockPipTurns.ts`, `src-tauri/src/inbox/pip_turns.rs`, their tests.
- The page names each conversation with `conversationIn(ticketKey, connectionId)` when it asks, so the turn is stored and read back under the same `<connection>:<name>` key. A bare page name still means the primary connection, so existing conversations keep working.
- Merge `main` in after L01 lands.
Regression test: a Rust test asks a turn from a second connection's ticket, reloads the turn list and finds it; a vitest test checks `claudeStore.ask` sends the connection-qualified name. Both fail on the current branch, where the reload drops the turn.
Acceptance: `cargo test pip_turns` and `pnpm test claudeStore` pass; Gitar's finding on #291 is answered with the fix.
QA: with `?jira=2`, open a ticket from the second site, ask Pip something, reload, and check the turn is still there; then do the same on the first site.

**D01 Record the Codex decisions in the docs.** Touches: `docs/connections-proposal.md`, `docs/agents-cli-findings.md`.
- c2 is skipped by owner decision on 2 Nov 2026 (Pip stays on Claude): update lines 135 (the 6.1 table), 364, 532 and 590.
- Codex agents get no `--sandbox` flag, so the person's own Codex config decides (owner decision, 2 Nov 2026); mark the findings row confirmed and say what `workspace-write` breaks (C6).
- Codex is a beta provider: a **Beta** label on its row, its sheet and its picker entries, and nothing hidden behind a switch. Add this to 8.x, 10.x and the c6 step.
- Steps p1 to p6, r7, r8, r11, j15 to j25, c0, c1, t1 and t2 are marked merged with their PR numbers.
Regression test: none (docs only).
Acceptance: `grep -n "only if c0 says yes" docs/connections-proposal.md` finds nothing; the Beta rule and both decisions appear with their date.

**A01 Finish r12: removed and signed-out logins (r12b).** Touches: `src-tauri/src/runs/{cleanup.rs,repo.rs}`, `src-tauri/src/inbox/{models.rs,provider_probes.rs}`, `src-tauri/src/domain/run.rs`, `src-tauri/src/lib.rs`, `src/backend/{mock.ts,mockProviders.ts,mockRuns.ts}`, `src/types.ts`, `src/workspace/RunCleanup.tsx`, tests in `runs/cleanup/tests.rs`, `runs/service/choice/tests.rs`, `mockRunSignIn.test.ts`, `cleanup.test.tsx`.
- Start from the WIP commit 383732e on `providers/r12b-runs-record-instance` (unreviewed): merge `main` in, then review it like new code.
- A finished run whose instance was removed is cleaned up with git alone (`git worktree remove` without `--force`, `git branch -d`), and its sheet says the Claude session was left behind (`sessionsLeft`).
- A queued run on a signed-out login waits with "Waits until <name> is signed in", using `model_choice::resolve` with the probe's standing; it starts as soon as the probe sees the login signed in.
Regression test: a cleanup test removes the instance and checks the worktree goes without a Claude call; a launch test with a signed-out probe keeps the run queued, then starts it when the probe turns ready. Both fail on main (`cleanup.rs:112` needs the instance's tools; `agents_target` never waits).
Acceptance: `cargo test cleanup` and `cargo test choice` pass; `pnpm test cleanup mockRunSignIn` pass.

### Wave 2

**A02 Track runs per login (r13a).** Touches: `src-tauri/src/runs/{index.rs,service.rs,tracker.rs}`, `src-tauri/src/runs/service/tests.rs`, `src-tauri/src/runs/tracker/tests.rs`.
- `RunIndex` entries get an `instance_id` (`#[serde(default)]`, reading as the default Claude). Run lookups key on `(instance, short id)`; `belongs_to` and `recover` use it.
- The tracker runs `claude agents --json --all` once per instance that has live runs, with that instance's toolchain (`toolchain_of`).
- The gate at `model_choice.rs:254` stays on until A03.
Regression test: two fake CLIs that both report short id `abc12345`; each run follows only its own instance's listing. A restart while a run on `claude_2` is Launching recovers it on `claude_2`. Fails on main, where `belongs_to` matches the short id alone.
Acceptance: `cargo test tracker` and `cargo test recover` pass.

**B01 Add Jira accounts (j26).** Touches: `src/Root.tsx`, `src/accountState.ts`, `src/workspace/{ConnectJira.tsx,Connections.tsx,connectionsLogic.ts,Workspace.tsx,Rail.tsx}`, `src/backend/{jira.ts,mock.ts}`, `src-tauri/src/auth/mod.rs` and `src-tauri/src/lib.rs` (a `name` on `TokenSignIn`), `e2e/{jira-token,connections,first-run}.spec.ts`.
- The desktop backend is chosen whenever any Jira connection that is on exists; the account key no longer depends on one site.
- + Add always offers "Jira account". The sheet is titled "Add Jira account", has a Name field, adds without signing out the first account, and refuses an account that is already connected. Removing the last Jira goes back to Setup; removing another one does not.
- After adding, Watching opens for the new account.
Regression test: a vitest test for the backend choice with two Jira connections; e2e adds a second account in the mock (`?jira=2` style) and checks both rows stay. Fails on main, where the second sign-in replaces the first (`ConnectJira.tsx:344`).
Acceptance: `pnpm test Root connectionsLogic` and `pnpm e2e e2e/connections.spec.ts e2e/jira-token.spec.ts` pass.
QA: add a second Jira account with a different name, check both rows, the Inbox shows tickets from both, remove one, then remove the last and check Setup appears.

### Wave 3

**A03 Every run action uses its own login (r13b).** Touches: `src-tauri/src/runs/{answer.rs,message.rs,control.rs,cleanup.rs,final_answer.rs,offer.rs,finder.rs,continuation.rs}`, `src-tauri/src/agent/mod.rs`, `src-tauri/src/model_choice.rs`, tests next to each.
- Every `self.tools.get()` that acts on a run becomes `toolchain_of(run)`: answer, message, stop, attach, clean-up, final answer, offers, `unready`, `sweep_agent_files`, `disk`, `short_ids`.
- A message to a run on an instance that is off waits until it is back on (proposal 7.3, 7.4).
- Lift the gate at `model_choice.rs:254`: any Claude instance that is on and signed in can run agents.
Regression test: with two fake CLIs, stopping, answering and messaging a run on `claude_2` call only `claude_2`'s binary and folder; a trust write on `claude_2` changes only its `.claude.json`. A `model_choice` test accepts `claude_2` for agents. All fail on main.
Acceptance: `cargo test runs::` passes; the gate test fails if the gate is put back.

**B02 Show which Jira account each item comes from (j27).** Touches: `src/workspace/{ItemCard.tsx,ListView.tsx,BoardView.tsx,PeekSheet.tsx,PeekParts.tsx,DraftCard.tsx,FilterBar.tsx,Rail.tsx,PipPane.tsx}`, `src/lib/filter.ts`, `src/claudeStore.ts`, new `e2e/multi-jira.spec.ts`.
- With two or more Jira connections on, cards, rows, the peek and drafts show the connection's name as a chip; with one, nothing changes.
- An Account filter in the filter bar. Rail project groups name the site when two sites share a project key. The ambiguous pull request link (`DevLink.ambiguous`) says which sites could own it.
- Pip's drawer gets a connection control for a conversation with no ticket; it sends `connectionId`.
Regression test: vitest for the chip rule (one connection, none; two, shown) and the Account filter; `e2e/multi-jira.spec.ts` with `?jira=2`. Fails on main, which has no chip or filter.
Acceptance: `pnpm test filter ItemCard` and `pnpm e2e e2e/multi-jira.spec.ts` pass.
QA: with `?jira=2`, filter by each account, open a ticket from each, and check the chip and Rail labels in light and dark.

### Wave 4

**A04 Settings and provider pickers, provider rows shown (r14a).** Touches: `src/workspace/{Settings.tsx,Connections.tsx,connectionsLogic.ts}`, `src/components/ModelPicker.tsx` (reuse only), `src/backend/mock.ts`, `e2e/providers.spec.ts`.
- `providersShown` becomes true: Claude and Codex rows show under Models.
- Settings gets a Models section: "Pip uses" and "New agents use", each a `ModelPicker`. The provider detail gets its own models with "Add model…". Safety's second promise names the instance.
- A Codex row, sheet and picker entry carry a **Beta** label (D01).
Regression test: vitest for the defaults written by each picker; e2e changes "New agents use" and checks a new run starts on it in the mock. Fails on main, where the rows are hidden.
Acceptance: `pnpm test Settings connectionsLogic` and `pnpm e2e e2e/providers.spec.ts` pass.
QA: add a second Claude, set it as "New agents use", start an agent and check its card; check the Beta label on Codex in light and dark.

**C01 A run backend trait (c3).** Touches: `src-tauri/src/runs/{cli.rs,toolchain.rs,control.rs,testing.rs,real_tests.rs}`, `src-tauri/src/runs/service/tests.rs`.
- Generalise `ClaudeCli` into a run backend trait: launch, observe, stop, resume, final answer, attach and sign-in commands. Claude implements it with the existing code; `Toolchain.cli` holds the trait object.
- No behaviour change.
Regression test: the existing runs tests pass unchanged against the trait; one new test calls every trait method on the Claude backend through `dyn`. A refactor test that would fail if a method silently fell back to the default instance.
Acceptance: `cargo test runs::` passes with no test edited except type names.

### Wave 5

**A05 Run and workstream pickers (r14b).** Touches: `src/workspace/{RunSheet.tsx,AgentParts.tsx,RunCleanup.tsx,failureHelp.ts,WorkstreamControls.tsx,SignInBanner.tsx}`, `src/backend/{mockRuns.ts,mock.ts}`, `e2e/agents-and-runs.spec.ts`, `e2e/workstreams.spec.ts`.
- A queued run's card and sheet say "Runs on <instance> · <model>" with Change; a started run says "Ran on". The workstream sheet has "New agents use".
- Failure help and the signed-out banner name the instance and its sign-in command.
Regression test: vitest for the Runs on / Ran on text; e2e changes a queued run's model and checks it starts on the new one. Fails on main, which has no Change.
Acceptance: `pnpm test AgentParts failureHelp` and `pnpm e2e e2e/agents-and-runs.spec.ts e2e/workstreams.spec.ts` pass.
QA: queue a run, change its model, let it start; sign the second Claude out in the mock and check the banner and the waiting run.

**C02 Codex launch (c4a).** Touches: new `src-tauri/src/runs/codex/{mod.rs,launch.rs}`, `src-tauri/src/runs/{launcher.rs,index.rs,service.rs}`, `src-tauri/src/domain/run.rs`, `src-tauri/src/db/{schema.rs,runs.rs}`, a fake `codex` in `src-tauri/test-support/`.
- A Codex backend makes the worktree and branch and runs `codex exec --json -C <worktree>` with stdin closed, in its own session so it outlives Gossamr, with stdout to `events.jsonl` in the run folder. It passes no `--sandbox` flag.
- It records {instance, thread id, pid}; a schema step adds the columns; the index stores the pid.
- Codex still can't be chosen for agents (`Driver::runs_agents` stays Claude-only until C05).
Regression test: with the fake codex, a launch writes `events.jsonl`, records the thread id and pid, and leaves the process running after the launcher returns. Fails on main, which has no Codex backend.
Acceptance: `cargo test codex` passes; a test fails if `--sandbox` appears in the arguments.

### Wave 6

**C03 Codex supervision (c4b).** Touches: `src-tauri/src/runs/codex/{events.rs,recover.rs}`, `src-tauri/src/runs/tracker.rs`, tests.
- Map Codex events to `RunState` (working, needs answer, done, failed). After a restart, find a Codex run again by pid and `events.jsonl`.
Regression test: fixture event streams for each state; a restart test with a live fake process and one that has exited. Fails on main.
Acceptance: `cargo test codex` passes.

**E01 Docs and tidy-up (d28).** Touches: `AGENTS.md`, `README.md`, `docs/agents-cli-findings.md`, `src/backend/mockGithub.ts`, `src/workspace/ConnectGithub.tsx`, their tests.
- AGENTS.md rules 2 and 4 per proposal section 12; the Read-first list points at `docs/connections-proposal.md` and `docs/goals.md`.
- README: adding a second Claude, a second Jira account and Codex (beta).
- Findings: one daemon per config folder, with the o10 result.
- The mock sets `checkedAt` on Connect, so a new GitHub row says "Checked just now". The GitHub sheet is titled "Add GitHub account", matching + Add.
Regression test: a vitest test that a just-connected mock GitHub reports a fresh check; fails on main (`mockGithub.ts:114` sets it once).
Acceptance: `pnpm test mockGithub ConnectGithub` passes.

### Wave 7

**C04 Codex answer, resume, stop and clean-up (c5).** Touches: `src-tauri/src/runs/codex/{control.rs}`, `src-tauri/src/runs/{answer.rs,message.rs,control.rs,cleanup.rs}`, tests.
- Answer and message: SIGINT the running `exec`, then `codex exec resume <thread> --json` with no sandbox flags (c0 check C5). Stop: SIGINT, then SIGKILL after a wait. Clean-up removes the worktree with git (A01's `Git::remove_worktree`) and deletes the Codex session with `codex delete --force <uuid>`.
Regression test: with the fake codex, a message resumes the same thread id with the earlier context; stop leaves no process; clean-up leaves no worktree. Fails on main.
Acceptance: `cargo test codex` passes.

### Wave 8

**C05 Codex final answer, Terminal and UI (c6).** Touches: `src-tauri/src/runs/{final_answer.rs,control.rs}`, `src-tauri/src/connections.rs`, `src-tauri/src/model_choice.rs`, `src/workspace/{failureHelp.ts,connectionsLogic.ts,Connections.tsx}`, `README.md`.
- The final answer comes from `-o <file>`. Attach stops the `exec` first, then opens `codex resume` in Terminal.
- `Driver::runs_agents` and `DRIVER_CAPABILITIES.codex.runsAgents` turn on, so + Add offers Codex and agents can run on it; the **Beta** label stays.
- Failure help for Codex sign-in and a missing CLI.
Regression test: an e2e run on a Codex instance in the mock ends with its final answer; a Rust test reads the `-o` file. Fail on main, where Codex can't run agents.
Acceptance: `cargo test codex final_answer` and `pnpm e2e e2e/providers.spec.ts` pass.
QA: add Codex (Beta), start an agent on it in the mock, attach, and read its final answer.

## Flagged concerns

- The runs and Codex track is a chain of eight PRs. If time runs short, waves 6 to 8 (Codex supervision onwards) can wait; the Claude and Jira work stands without them.
- `docs/plan-*.md`, `AGENTS.md` and lockfiles are gated paths: the maintainer merges those PRs. The maintainer asked for every PR of this refactor to be merged once CI is green and a review bot clears it.
- A01 starts from an unreviewed WIP commit. If its review finds the approach wrong, rebuild it from main.
