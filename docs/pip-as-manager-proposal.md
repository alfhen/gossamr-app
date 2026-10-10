# Proposal: Pip as manager for an agents-first Gossamr

## 1. Summary

At the moment the person runs the work and Pip gives advice. Pip answers one message at a time. It can read runs and draft an Investigate, Triage, Plan or Verify run, and after that it stops. Nothing wakes Pip when a sub-agent finishes, and moving from Plan to Build to Review is done with buttons on the run sheet. This proposal makes Pip the manager. Each piece of work becomes a **workstream**, which is a durable thread tied to one ticket or one ticketless question. In that thread Pip plans the steps (investigate, triage, plan, build, review), drafts a Gossamr run for each one, gets woken automatically when a run changes state, reads the result and drafts the next step. The person mostly talks to Pip, on a new Pip home screen, and approves things inline. Nothing reaches Jira until the person approves a draft, and Pip still has no tool that starts, stops, answers or approves anything. Some runs now **start automatically** as the next step in a chain: Investigate→Triage, Triage→Plan when Triage recommends a plan, Build→Review, and a fix round after a blocking review. The Rust supervisor starts them from fixed rules, with handoffs filled in by Core, so neither Pip nor any agent output decides that a run starts. Every other run start still needs the person's approval of the exact prompt. Builds always publish a draft pull request, and Review is an **adversarial reviewer** that tries to break the change before a person sees it. The new parts are a workstream record, a Rust supervisor that wakes Pip and applies the auto-start rules, saved conversations with a turn queue, and Pip being able to draft Build and Review as successors of finished runs.

## 2. What exists today that we build on

| Piece | Where | Why it matters |
|---|---|---|
| Sub-agents = Gossamr runs (`claude --bg --worktree`), six kinds with fixed Rust templates | `domain/run.rs:84-125`, `runs/service.rs`, `runs/cli.rs:384-393` | Delegation is already built. Pip never needs Claude Code's own Task/`--agents`, which the tests forbid (`claude/mod.rs:205-228`). |
| Digest-bound run approval | `RunSpec::digest` `domain/run.rs:308-340`; `runs_review`/`runs_approve` `inbox/drafts.rs:443-509`, `lib.rs:507-527` | This is the consent gate that every step keeps going through. |
| Typed handoffs filled in by Core | `attach_plan` / `attach_build_account` `inbox/run_results.rs:269-343` | Plan→Build and Build→Review pass the real output from the source run. No model writes the handoff text. |
| Run supervision loop and hooks | `runs/tracker.rs:212-438` (poll, `track`, `draft_for`); `RunNotifier` `tracker.rs:59`; `with_notifier` `service.rs:209-217` | This is where a wake-up for Pip connects. |
| Pip's MCP server with pluggable tool modules | `agent/mcp.rs:173-265`, `agent/runs.rs`, `agent/github.rs` | A new `agent/workstream.rs` module plugs in the same way. |
| Pip run drafting | `inbox/pip_runs.rs:146` `draft_run_as_pip`, `pip_kinds()` `domain/run.rs:99` | Already lets Pip "propose a sub-agent so the user can approve it". |
| Draft spine | `proposals::create` `proposals.rs:139`; `Core::approve_proposal` `inbox/drafts.rs:543`; `DraftCard`, `DraftPreview`, `RewriteDiff` | This stays the only route for writes to Jira. |
| Pip pane, turns, inline drafts | `PipPane.tsx` (TurnView 106-143), `claudeStore.ts`, `lib/proposals.ts:36` | Becomes the conversation component on Pip home. |
| Mock mode | `mockPip.ts`, `mockRuns.ts` (`advance`), `mockRunKinds.ts`, `src-tauri/test-support/fake-claude.sh` | Lets every phase be prototyped and tested without Claude. |

## 3. The model: Pip as manager

### Roles

| Role | What it is | What it may do |
|---|---|---|
| **Pip (manager)** | The same sandboxed, tool-less `claude -p` process as today, one per turn, resumed from the workstream's session | Judgement only: plan the steps, write a step's focus line, read results, word Jira drafts, suggest replies, explain. It acts only through MCP tools that read, propose or annotate. |
| **Supervisor (Rust, no model)** | New `agent/supervisor.rs` | Watches the runs linked to each workstream, wakes Pip, enforces budgets and holds work after a restart. It starts runs in two cases only: runs a person approved, once a slot frees up, and **successor runs that match an auto-start rule** (§3, Auto-start rules). It never approves drafts and never touches the tracker. |
| **Sub-agents** | Existing Gossamr runs with today's GUARD, limits and templates | Do the work in a worktree. They never talk to Pip or to each other directly. |
| **Person** | | Approves every Jira draft and every run start that isn't covered by an auto-start rule, answers permission and trust prompts, and can steer or stop anything, including auto-started runs. |

### Stages

| Stage | Sub-agent | Input (Core-built) | Output | Handoff to next | Pip checks in when |
|---|---|---|---|---|---|
| Intake | Pip itself, plus GitHub read tools for cheap questions | Person's request, ticket, `[Workstream]` block | Proposed step list (Pip's notes), first run draft(s) | Pip drafts Investigate and/or Triage | Always: first run approval |
| Investigate | `Investigate` (ticketed or ticketless) | Ticket block, Pip's `focus` (≤300 chars) | "For Jira" note → comment draft; ticketless → new-ticket draft | **New** `findings`/`findings_from_run` slot, filled by Core from `Resolved.note`. Triage **auto-starts** on a ticketed Investigate | Run approval for the first run; ambiguous repo (`pip_run_target` refuses) |
| Triage | `Triage` | Ticket + findings | Subtasks draft, "Plan recommended: yes/no", comment draft | Plan **auto-starts** when Triage recommends a plan; otherwise Pip says why it isn't needed | If "no plan" and the next step would be Build, Pip asks |
| Plan | `Plan` | Ticket + findings | "Gossamr Plan" description draft (diff) | Approving the plan draft is the gate for Build. Build then starts with `from_run=plan` and Core's `attach_plan` (see the plan-edit fix below) | Always: the person approves (and may edit) the plan |
| Build | `Build` | Core-attached plan | Branch pushed and a **draft PR opened, always** | Review **auto-starts** once the PR is found | When the plan is approved (Build starts from that approval, or from RunSetup if the person prefers to read it) |
| Review | `Review`, **adversarial** | Build account + PR + `pr_sha`/base (from `review_target`) | Verdict (pass / blocking findings) as a structured report, plus a review comment draft | Blocking findings → a fix FollowUp to the Build **auto-starts**, then Review runs again on the new commit (at most 2 rounds) | After a pass, or when the round limit is hit with blockers left |
| Verify (optional) | `Verify` | Ticket + branch | Pass/fail note | Closing transition + summary comment drafts | — |

The stage is **derived** from the kinds and states of the linked runs (`workstream::stage(&[Run])`). It is not stored as a second state machine, so it can't drift from the tracker.

### Handoffs: three fixes the designs got wrong or missed

1. **Plan edits must reach the Build.** `plan_of_run` (`run_results.rs:269-289`) takes the Plan run's own answer, so edits the person makes to the Gossamr Plan description draft never reach the Build. Meanwhile `PLAN_FOLLOW` tells the Build agent that a person "read, edited and approved" the plan. Fix: `attach_plan` should prefer the text of the run's plan-description draft once that draft is Applied, including the person's edits, and fall back to the raw answer only when the person chose to build without settling the plan. That fallback gets a visible notice in RunSetup.
2. **Build → Review needs a PR, and the PR has to be found.** Builds always publish, so a workstream Build is drafted with `allow_push=true`. The prompt then carries `PUSH_ALLOWED` (`domain/run.rs:71`): push, open a **draft** PR, never mark it ready and never merge. Today Pip-drafted Builds force `allow_push=false` (`inbox/pip_runs.rs:127,177`), so that changes for workstream Builds. `attach_build_account` still refuses a build with no PR (`run_results.rs:321`), and `change_of` finds the PR only from cached code changes after a GitHub sync (`run_results.rs:200-208`). When a Build reaches Done, the supervisor marks the step "waiting for PR", requests a code sync for that repo, and starts the Review when the PR appears. If no PR appears within the sync window, the step is held and Pip tells the person.
3. **Review pins come from `draft_run`, not `attach_build_account`.** `attach_build_account` sets only `pr` and `build_account`. `pr_sha`/`base` come from `review_target`. Pip's chained Review must therefore go through a Pip variant that runs the same `review_target` step. It must not go through `Core::draft_run`, which stamps `Origin::Board`/`CreatedBy::User` and would make Pip's drafts look like the person's.

### Adversarial review

Today's Review prompt already treats the builder's account as "a claim to verify" (`REVIEW_INSTRUCTION`, `BUILD_ACCOUNT_PREFACE` in `domain/run.rs`). The adversarial reviewer goes further:

| Change | Detail |
|---|---|
| Stance | The reviewer's job is to show the change is **not** ready: find a failing case, an unmet acceptance point, a missing test, a regression or a security issue. Passing is the conclusion only when it tried and failed to find any of these. |
| Evidence | It may check out the PR head in its own worktree and run the existing tests and read-only commands, as Verify does today. Every finding must cite a file and line, a command and its output, or the acceptance point it fails. |
| Independence | It gets the ticket, the diff and the build account (labelled as a claim). It does **not** get Pip's notes or the plan's reasoning, so it judges the result rather than the intent. |
| Verdict | `report: true` is always on for Review, so the result is machine-readable: `verdict: pass \| blocking`, and findings with a severity (`blocking`, `should-fix`, `nit`). The supervisor reads only the verdict and the count of blocking findings. It never reads the prose. |
| Fix loop | `blocking` → an auto-started FollowUp to the same Build session with the blocking findings (Core-filled, marker-wrapped), then a fresh Review on the new commit. At most 2 rounds; then it stops and Pip brings it to the person. `should-fix` and `nit` are listed for the person and Pip, but never start a run. |
| Posts only through drafts | The reviewer itself never writes to GitHub. Its findings become drafts the person approves in Gossamr, the same way as Jira drafts: a **GitHub review draft** (a summary plus one inline comment per finding, each at the file and line it cites) and, when useful, a Jira comment draft. Gossamr posts the review only when the person approves it, always as a plain comment review (never Approve or Request changes). The person can edit, drop single comments or discard the draft, or ask Pip about any comment and have Pip rewrite the draft. |

### Auto-start rules

These rules let a run start the next step without a per-run approval. The supervisor applies them from fixed Rust code, so they don't depend on Pip or on agent prose.

| When this finishes | And | This starts automatically | Default |
|---|---|---|---|
| Investigate (on a ticket) | Done, no tripwire | Triage | On |
| Triage | `plan recommended: yes` in its structured report | Plan | On |
| Plan | The person **approved** the Gossamr Plan draft | Build (publishes a draft PR) | On, the plan approval is the gate |
| Build | Done and its PR was found | Review (adversarial) | On |
| Review | `verdict: blocking`, fewer than 2 fix rounds so far | FollowUp to the Build, then Review again | On |
| Review | `verdict: pass` | Verify (if the workstream has it enabled) | Off |

Conditions on every auto-start:
- The workstream is in **Manage** mode, isn't held, and is within its budget.
- The source run finished as Done. Failed, stopped or needs-something never auto-starts anything.
- The new spec comes from the kind's fixed template plus Core-filled handoff slots. Pip's `focus` line is **not** carried into an auto-started run, so nothing Pip wrote decides what it does. Agent output does decide **whether** some rules fire: Triage's `plan recommended` and Review's `verdict`. The fix round goes further, because its FollowUp carries the Review's findings text, which an agent wrote, into the push-capable Build session. See the fix-round risk in §8.
- The spec's digest is recorded in `workstream_events` with the rule that started it, and the run card shows "started automatically after R7". The person can stop it like any other run.
- The person can switch each rule off per workstream or globally in Settings.

### Parallelism

- Within a workstream, Pip may draft several runs in one turn, for example Investigate in two repos, or Verify alongside Review. Build is limited to one per workstream at a time.
- Across workstreams, runs share the existing `max_runs` cap (1-6, default 3). Approved runs over the cap **wait** instead of failing (Phase 5).
- Pip turns: one in flight per conversation, at most 2 Pip processes globally (configurable). Events that arrive during a turn are merged into the next wake.

### When Pip checks in with the person

- **Always:** the first run in a workstream, every run start not covered by an auto-start rule, every Jira draft, approving the plan (which starts the Build), answering a sub-agent's question, NeedsPermission/SystemBlocked/folder trust (the Terminal, via `attach`), ambiguous repo or clone, any hold, running out of budget, and a review that still blocks after 2 fix rounds.
- **By judgement:** results that conflict, Triage says the ticket is unclear, scope would grow, a Review finds blockers.
- **Never:** Pip never says a run started until the run shows Working. The prompt keeps "You cannot start, stop or answer a run", because that stays true.

## 4. Architecture

```
 Person ─▶ Pip home (route 'pip')  ◀── 'claude' {conversation, kind:user|wake}, 'workstreams-changed', 'proposals-changed', 'runs-changed'
   │  composer verbs (/stop /answer /retry /hold) ─▶ existing user-only commands (runs_stop, runs_answer, runs_retry_launch)
   │  approvals ─▶ proposals_approve │ runs_review → runs_approve(digest) │ runs_answer_draft │ follow-up send
   ▼
 ask_claude ─▶ agent::queue (per-conversation FIFO, user pre-empts wake, global cap 2)
                    ▲                                    │
                    │ enqueue_wake(ws, facts)            ▼
 agent::supervisor ─┘                       AgentService::ask(AskRequest, backend UpdateSink)
   ▲  (spawned task, never inline)                       │ claude -p --resume <ws session>  (flags UNCHANGED)
   │  OnceLock<Weak<AgentService>> set after lib.rs:1068 ▼
   │                                       gossamr MCP: core + github + runs + agent/workstream.rs
   │                                         reads / propose_* / notes only ─▶ proposals::create (single chokepoint)
   │
 RunTracker.poll ─▶ FanoutNotifier { RunNotices (today), Supervisor::on_run }  + periodic reconcile sweep
   │ (launching lock held during notify)
   ▼
 RunService.launch ◀── runs a person approved (runs_approve), Queued-at-cap runs, or auto-start successors (launch_waiting, after lock drop)

 SQLite: workstreams · pip_turns · workstream_events (audit) · runs.spec.workstream · proposals(+origin/workstream columns)
```

### Where orchestration state lives

All durable state lives in Rust/SQLite. The frontend only displays it.

| Data | Storage | Notes |
|---|---|---|
| `Workstream { id, connection_id, item_key?, repo?, title, pip_session?, mode, held_reason?, budget, spent, notes?, created_at, closed_at? }` | New `domain/workstream.rs`, `db/workstreams.rs`, table in `db/schema.rs` | `mode` is the autonomy level (§6). No step state machine; the stage is derived. |
| Run ↔ workstream | `RunSpec.workstream: Option<String>` | **Must be added to `RunSpec::digest` by hand** (`run.rs:308-340` builds an explicit canonical JSON) and left out when `None`, so old digests stay valid. Not rendered into the prompt. |
| Draft ↔ workstream | `Origin::Chat { request_id, workstream }` (`#[serde(default)]`); run-origin drafts inherit it from `run.spec.workstream` in `run_results.rs`/`plan_description.rs` | Add `origin_kind`/`workstream` **columns** on `proposals` (today a single JSON blob, `schema.rs:101-108`) and `ProposalQuery.workstream`. |
| Provenance | `CreatedBy::Agent` as a **unit variant**, so it stays `Copy` and the TS union becomes `'user'\|'pip'\|'autopilot'\|'agent'`; the run id and kind are already in `Origin::Run` | Replaces the `CreatedBy::User` overload for run-result drafts (`run_results.rs:422,478,523`, `plan_description.rs:161`). Rewrite `require_pip_may_revise` (`proposals.rs:260-278`) to allow Agent drafts in the same workstream, keeping the "Edited" lock. |
| Transcripts | New `pip_turns(conversation, request_id, role user\|pip\|wake, prompt, text, steps_json, status, usage_json, created_at)` | Replaces in-memory `claudeStore`. Wake turns must be registered by the backend, because `updateByRequest` drops unknown requestIds. |
| Pip session per workstream | `Workstream.pip_session` | It must be pinned in the resume allowlist separately from the 50-entry LRU (`OWN_SESSIONS_KEPT`, `inbox.rs:50`), or long workstreams silently stop resuming. |
| Audit | `workstream_events` append-only table (actor Person/Pip/Supervisor/Run, action, ids, digest) | Exportable. A hash chain is optional and comes later. |
| Supervisor queue | In memory, rebuilt from run states and `workstream_events` on startup | An idempotency key `(workstream, run, state)` makes sure a duplicate wake is a no-op. |

### Rust modules

| Module | New/changed | Purpose |
|---|---|---|
| `agent/queue.rs` | New | Per-conversation FIFO of `User(AskRequest) \| Wake(WakeFacts)`. One turn in flight per conversation, global cap 2. A user message cancels a pending or in-flight wake. Wakes merge. |
| `agent/supervisor.rs` | New | `on_run(run, attention)` **spawns** a task and never does work inline, because `notify` runs under `RunService.launching` (`tracker.rs:239`). It runs a periodic sweep over linked runs to catch the events the notifier never emits: a person-Stopped run, a Done-after-continuation that drafted nothing, or `draft_on_finish` turned off (`tracker.rs:396-407`). It holds budgets, the hold state and recovery. |
| `agent/workstream.rs` | New MCP module | `get_workstream`, `list_workstreams`, `set_workstream_notes` (≤2 KB, scrubbed, fed back as data), `propose_answer`. Chained into `tool_list`/`run_tool`/`tool_label` like `runs.rs`. |
| `agent/mod.rs` | Changed | `AskRequest` gets `conversation` and `workstream`. `PipRun` gets `workstream`. Turns go through the queue. Usage is recorded per turn. |
| `agent/context.rs` | Changed | `system_prompt(Role::{Assistant, Manager})`. `compose()` adds a `[Workstream]` block (stage, notes, linked runs, the workstream's drafts, the person's recent overrides) and an `[Event]` block for wakes. "[Open drafts, from everyone]" (`context.rs:245`) is **scoped and capped** when in a workstream. |
| `claude/stream.rs` | Changed | Stop dropping `result.usage`/`total_cost_usd`, and emit them on `Done` so Pip turns can be budgeted. |
| `claude/mod.rs` | **Unchanged** | Same flags, tests, sandbox and token handling. |
| `domain/run.rs` | Changed | `pip_chain_kinds()` (Build only with `from_run`=Done Plan; Review only with `from_run`=Done Build with PR). Add a `findings` slot plus a `<<<FINDINGS` marker in `MARKERS`/`without_markers`. Add `workstream` to the digest. An adversarial `REVIEW_INSTRUCTION` with a required verdict in its report. |
| `agent/autostart.rs` | New | The auto-start rule table, as pure functions from `(finished run, its structured report, workstream)` to an optional successor `RunSpec`. Unit-tested on its own and shared with the mock as a JSON fixture. |
| `inbox/pip_runs.rs`, `inbox/run_results.rs` | Changed | A Pip chain variant of `draft_run` that runs `attach_plan`/`attach_build_account`/`attach_findings`/`review_target` and stamps Pip provenance. Plan-edit propagation. |
| `agent/runs.rs` `kind_of` (494-501) | Changed | From "refuse Build/Review" to "Build/Review only as successors with a valid `from_run`". Workstream Builds get `allow_push=true` (draft PR only). |
| `domain/proposal.rs`, `proposals.rs`, `db/proposals.rs`, `tracker/jira/mod.rs` | Changed | `Intent::RunAnswer { run_id, message }` with "own button" refusals in `begin_applying` (87-91) and the Jira adapter (331-332). Per-workstream draft cap and exclusivity in `create()`. Sibling-transition retirement in `reconcile_pending`. |
| `runs/service.rs`, `runs/preflight.rs`, `runs/tracker.rs` | Changed | Approved runs over the cap stay Queued. **Preflight's red CapReached row (`preflight.rs:144-152`) becomes amber "will wait for a slot"**, or RunSetup can't approve at all. `launch_waiting()` runs **after** the poll's `launching` guard is dropped, because tokio's Mutex isn't re-entrant and `start()` locks it again. |
| `lib.rs` | Changed | Commands `workstream_*`, `pip_turns`, `runs_answer_draft`, `workstreams_hold_all`. The supervisor is wired as a `FanoutNotifier` at `lib.rs:1042` with a `OnceLock<Weak<AgentService>>` filled after `AgentService::new` (`lib.rs:1068`). This resolves the startup ordering cycle: RunService → McpServer → AgentService. A backend-owned emitter for `claude` events that the person didn't start. |

### Frontend stores

- `claudeStore.ts`: conversations keyed `general` and `ws:<id>`, loaded from `pip_turns`. `ask` appends a `queued` turn instead of refusing (`PipPane.tsx:267`, `askPip.ts:14-16`). Keep the `byTicket` API so the classic `ClaudeDrawer` works until build-plan 2f removes it.
- New `workstreamsStore.ts`: mirrors `workstreams_list`/`workstream_get` and listens to `workstreams-changed`.
- `useWorkspace`, `useRuns` and `useRunSetup` are unchanged apart from the workstream filters.
- Mock: `mockWorkstreams.ts`, `mockSupervisor.ts` (driven by an optional auto-clock on `MockRuns.advance`), and `mockPip` scripts for wake turns.

## 5. User experience

**Talking to Pip.** A new route `'pip'` in `tabsStore.Route` (`tabsStore.ts:10`) becomes the landing page when agents are enabled (opt-in at first). It has three columns:
1. A **Workstreams** list with General at the top, one row per workstream ("PAY-412 Refund rounding · Plan running · 1 needs you"), and a **Needs you** tray at the bottom that collects pending drafts, step approvals, questions and failures across workstreams, sorted by how long each has waited.
2. The **conversation**, which is `PipConversation` taken out of `PipPane`.
3. The **step rail**: five chips derived from the runs, each expanding to its `PipRunCard`s and that step's drafts, with "Pip's plan" (notes) at the top.

The person starts work by typing ("take PAY-412 to a reviewed PR"), by pressing ⌘N on a selected ticket, or from the palette ("Ask Pip to plan ABC-1", `commands.ts:181`). Suggestion chips become workstream-aware.

**Watching sub-agents.** Working ticks update only the rail and a composer footer ("4 agents working · 2 need you"), never the transcript. Wake turns render with a muted header ("Pip picked this up: run abc12 finished") and are at most about three lines plus cards, so they are clearly separate from what the person typed. Native notifications open the app on the workstream. Deep-linking to the exact card is best-effort, because macOS notifications have no click handler here and `OpenOnFocus` approximates one.

**Approving drafts.** The draft spine stays as it is.

| Draft | How it's approved |
|---|---|
| Comment, transition, subtasks, create | Inline card: `a` approve, `e` edit, `s` skip, `o` open full, `t` talk it over. There is a per-step "Approve these 3" behind a confirm that still calls `approve_proposal` for each draft (`useCards.ts:129-140` pattern). |
| Description rewrite | Never approved inline. `a` opens `RewriteDiff`. |
| Run start (Investigate/Triage/Plan/Verify) | Inline "Review and start" expander showing the exact rendered prompt and the preflight rows from `runs_review`. **Start** is enabled only after that digest is displayed. The CHANGED path forces a re-read. |
| Run start (Build/Review) | Usually automatic: Build starts when the plan is approved, Review when the PR appears. A Build started by hand still opens the full `RunSetup` sheet. |
| Answer, FollowUp | Editable text inline, then ⌘⏎ to send. |

**Steering and interrupting.** Composer verbs are handled by the frontend and call the existing user-only commands: `/stop R7`, `/answer R9 …`, `/retry R7`, `/hold`, `/resume`. They are person actions and Pip gets no new tool. Each one is written to `workstream_events` and shown to Pip in the next `[Workstream]` block ("the person stopped R7"). `@R7 also check X` makes Pip draft a FollowUp. Esc closes a sheet first, then cancels Pip's turn (`cancel_claude`). A message sent mid-turn queues, and pre-empts a wake.

**Board, list and peek alongside Pip home.** These are deliberately **not** moved into a new "Stage" column, because that would refactor Esc/focus handling that tests pin. The canvas stays a route one keystroke away (⌘1). PeekSheet and AgentSheets stay overlays. On other routes, ⌘J opens the docked pane showing the workstream of the selected ticket, or General. `set_view_filter` is relaxed from "workspace conversation only" (`PipExtras.tsx:48-51`) to "the focused conversation". The Agents route gains "By workstream" grouping (`agentsLogic.groupRuns`). Activity gains a "Pip & agents" chip that reads `workstream_events`. The peek's "Agents on this ticket" links to the workstream. With the agents flag off, the app behaves exactly as today.

## 6. Safety, control and cost

### Approval invariants (unchanged and enforced by tests)

| Invariant | How it holds |
|---|---|
| No Jira write without the person's approval | The only route is `approve_proposal → begin/execute/finish → WorkTracker::apply`. The supervisor gets a narrow `SupervisorCore` facade with no tracker handle and no `approve_proposal`/`transition`/`comment`/`create_subtasks`/`attach`. New conformance test `orchestration_never_writes_jira`: run a full mock workstream and assert that `tracker.intents()` is empty until a person approves. |
| Runs start only from a person's approval or a fixed rule | The supervisor launches only runs Queued by `runs_approve` or specs produced by `agent/autostart.rs`. Auto-started specs are built from templates and Core-filled slots, and their digests are logged with the rule. |
| Pip has no power tools | The conformance suite (`agent/conformance.rs:298-319`) keeps forbidding start/stop/answer/attach/rm/approve, and a sibling probe covers `agent/workstream.rs`. Pip deliberately gets **no** stop or hold tool, so injected text can't stall work. |
| Pip's process is unchanged | `claude/mod.rs` flags and tests stay as they are. Wake turns are ordinary asks with a fresh per-request token. |
| Handoff text comes from Core | Plan, findings, build account, review findings and PR are filled by `attach_*`. Pip supplies kind, `from_run` and a ≤300-char focus for runs it drafts, and auto-started runs carry no focus at all. |
| Person edits are final | The "Edited" lock is kept under the new `CreatedBy::Agent`. |

### Autonomy levels (per workstream, capped by a global Safety setting)

| Level | Behaviour | Default |
|---|---|---|
| **Advise** | Today's Pip inside a workstream. It speaks only when asked, and run nudges stay in the frontend. | For workstreams adopted from existing runs |
| **Manage** | The supervisor wakes Pip on run events and applies the auto-start rules. Pip reads results and drafts the steps no rule covers. Every Jira write still needs the person. | Default for new workstreams once Phase 3 has shipped and soaked |

A caveat for auto-start: Investigate, Triage, Plan and Review are read-only **by instruction only**. `docs/agents-cli-findings.md` calls this "a request, not a lock". Runs use the person's own permission mode with full tools, repository hooks may fire (unverified), and Review and Verify run the repo's tests. An auto-started run therefore does what a run the person approved would do, without the person reading its prompt first. Two things limit the risk. First, the prompt is a fixed template plus Core-filled slots, so the person has in effect approved it once by turning the rule on. Second, the tripwires below hold the workstream before anything chains on. A real permission restriction for the read-only kinds (`--permission-mode plan` with `--bg`, currently unverified, or a restricted allowed-tools list) is still recommended before auto-start is on by default.

### Budgets and cost

- **Pip turns:** usage is captured from `stream.rs`. Per workstream, at most 6 automatic turns since the person's last message (only a human message resets it) and 12 wakes in total. Globally, there is a daily cap on manager turns. At 80% the workstream shows amber, and at 100% it is Held with a "say carry on" message.
- **Sub-agents:** per-run limits (`limits.rs`) are unchanged. A per-workstream token sum across children is shown and enforced the same way.
- **Shared quota:** Pip and every run draw on the person's subscription window. On a rate-limit or auth error the supervisor backs off exponentially, marks the workstream "paused: quota", and never retries in a loop.
- **Model:** the manager stays on Sonnet/medium (`claude/mod.rs:23-30`) until evals show a stronger model picks next steps measurably better (open question).

### Prompt injection between agents

- Wake prompts are generated by Rust and contain **only** ids, kinds, states, counts and parsed flags, for example `[Event] run abc12 (triage) Done; plan recommended: yes; 2 drafts`. They contain no agent prose, and no ticket keys that `keys_in` would treat as "handed". Reachability for a wake comes from the workstream's own `item_key` (it must be watched or explicitly handed when the workstream opened), not from prompt text.
- Agent output reaches Pip only through the run tools (AGENT_OUTPUT-wrapped, redacted, defanged). It reaches another agent only through Core-filled, marker-wrapped, length-capped slots.
- Pip's notes and answers go through `scrub()`, and marker strings are rejected.
- **Tripwires** (hold the workstream and drop it to Advise): marker or defang hits in a child's output; Basis drift on the ticket since the workstream opened (status, assignee or description changed in Jira, via the existing `Basis`); two failures of the same step; Pip asking for a Build/Review the gate refused three times.

### Sandboxing

Pip's sandbox is unchanged. Sub-agents keep their worktrees, their GUARD, Gossamr never writing folder trust, run-index-only stop/rm, and no `--discard-unpushed`. A workstream Build may push its own branch and open a **draft** PR, and nothing else: `PUSH_ALLOWED` forbids marking it ready or merging, and Review never writes to GitHub itself: its findings reach the PR only as a review draft that Gossamr posts after the person approves it.

### Kill switches

- **Per workstream:** Hold (no wakes, no queued launches; running children continue), Stop (stops its children through `control::stop`), Close.
- **Hold all** (rail button visible while anything is active, plus a shortcut): holds every workstream, cancels in-flight Pip turns (`cancel`, then `finish()` revokes MCP tokens), skips queued launches, optionally stops workstream runs, and leaves drafts inert.
- **After restart:** every workstream comes back **Held(restart)**. Resuming re-checks preflight. The existing "Stop all" stays.

### Audit

`workstream_events` records workstream opens and closes, every wake (reason, turn id, usage), every Pip tool call in a workstream (name, focus text), every draft created, retired or approved and by whom, every run approval (spec digest), hold, tripwire, budget threshold and person verb. A "What happened" tab shows it and an export produces JSON.

### Data retention

Transcripts and events contain ticket text and agent output. They are pruned on the same 90-day horizon as items, deleted when the workstream is deleted, and deleted on sign-out or connection removal.

## 7. Phased delivery plan

Every phase can ship on its own, behind the agents flag, and has mock parity. Estimates are rough.

| Phase | Scope | Key files | Done when |
|---|---|---|---|
| **0. Groundwork, no new authority** (≈1 wk) | `pip_turns` table and loading; Rust turn queue (user pre-emption, global cap 2) replacing the one-turn refusal; extract `PipConversation`/Composer; keyboard card focus on `LiveDraftPreview`; capture usage in `stream.rs`; cap the open-drafts block. Ordered after build-plan 2f if possible; otherwise keep `byTicket` compatible. | `db/schema.rs`, `agent/queue.rs` (new), `agent/mod.rs`, `claude/stream.rs`, `agent/context.rs`, `lib.rs`, `claudeStore.ts`, `PipPane.tsx`, `PipConversation.tsx` (new), `askPip.ts` | The conversation survives ⌘R and a restart; a second message queues; drafts are approvable from the keyboard; turn usage is recorded; cargo and vitest pass unchanged. |
| **1. Workstreams as the spine** (≈1.5 wk) | Workstream domain/table/commands; `RunSpec.workstream` explicitly in the digest; `Origin::Chat.workstream`; proposal columns + `ProposalQuery`; `CreatedBy::Agent` unit variant + `require_pip_may_revise`; run-result drafts inherit the workstream; `[Workstream]` block; MCP `get_workstream`/`list_workstreams`/`set_workstream_notes`; derived stage; composer verbs; "By workstream" in Agents; adopt the existing workspace conversation as General; `workstream_events`. | `domain/workstream.rs`, `db/workstreams.rs`, `inbox/workstreams.rs`, `agent/workstream.rs` (new); `domain/run.rs`, `domain/proposal.rs`, `proposals.rs`, `inbox/run_results.rs`, `plan_description.rs`, `pip_runs.rs`, `agent/mcp.rs`, `conformance.rs`; `types.ts`, `workstreamsStore.ts`, `AgentsView.tsx`, `agentsLogic.ts`, mocks | Runs and drafts group under a workstream; old rows still deserialize; old digests are unchanged and a test proves `workstream` changes the digest; the conformance probe shows the new tools change nothing. |
| **2. Pip drafts the whole chain** (≈1.5 wk) | `pip_chain_kinds()`; Pip chain variant of `draft_run` (with `attach_*` + `review_target`, Pip provenance, workstream Builds publish a draft PR); `findings` slot + `attach_findings`; plan-edit propagation; adversarial `REVIEW_INSTRUCTION` with a required verdict report; "waiting for PR" handling; `Role::Manager` prompt; `findRunDraft` recognises Pip chain drafts. | `domain/run.rs`, `agent/runs.rs`, `inbox/pip_runs.rs`, `inbox/run_results.rs`, `runs/report`, `agent/context.rs`, `conformance.rs`, `runSheetLogic.ts`, `mockRunKinds.ts`, `mockRuns.ts` | In one workstream Pip can draft investigate → … → review, each opening with Core-attached handoffs; Build/Review without the right Done source are refused (tests); an edited and applied plan is what the Build carries; every Build ends with a draft PR; a Review returns a pass/blocking verdict. |
| **3. Supervisor wake-up and auto-start** (≈2 wk) | `agent/supervisor.rs` with FanoutNotifier (spawned, never inline), late-bound `OnceLock<Weak<AgentService>>`, all attentions **including `DraftedTicket`**, a sweep for Stopped/silent Done; Rust `[Event]` prompts; backend sink and `claude` events with `conversation`/`kind`; Manage mode, budgets, Held-on-restart, idempotency key, quota backoff; Hold all; frontend nudges suppressed for Managed workstreams; `agent/autostart.rs` rule table with per-rule switches, the 2-round fix loop, and "started automatically" on run cards. | `agent/supervisor.rs`, `agent/autostart.rs` (new), `agent/mod.rs`, `agent/context.rs`, `runs/tracker.rs`, `lib.rs`, `claude.ts`, `claudeStore.ts`, `pipRuns.ts`, `PipExtras.tsx`, `mockSupervisor.ts` (new) | With Manage on, a finished run produces exactly one Pip turn; a Triage that recommends a plan starts the Plan, a Build with a PR starts its Review, and a blocking Review starts at most 2 fix rounds, all without a click; Pip's own turns still start nothing (probe); a restart leaves workstreams Held with at most one wake per terminal run; budget exhaustion pauses. |
| **4. Pip home** (≈1.5 wk) | `'pip'` route (opt-in default), workstream list + Needs-you tray, step rail, inline review-and-start for Investigate/Triage/Plan/Verify, per-step batch approve, wake-turn rendering, Activity chip, peek link, relaxed `set_view_filter`, palette/suggestions. | `tabsStore.ts`, `Workspace.tsx`, `Rail.tsx`, `PipHome.tsx`, `StepRail.tsx`, `NeedsYouTray.tsx` (new); `DraftPreview.tsx`, `runSetupStore.ts`, `useCards.ts`, `ActivityView.tsx`, `activityLogic.ts`, `commands.ts`, `suggestions.ts`, `prefs.ts` | A person can take a ticket from intake to review mostly by talking to Pip, approving inline; keyboard walkthrough without a mouse; agents flag off means today's workspace. |
| **5. Questions, capacity, draft hygiene** (≈1 wk) | `Intent::RunAnswer` + `propose_answer` + `runs_answer_draft`; queue-at-cap (service + amber preflight row + `launch_waiting` after the lock drops, ordered against `answer`'s 5 s settle); per-workstream pending-draft cap and same-kind supersession; sibling-transition retirement; Basis-drift tripwire. | `domain/proposal.rs`, `proposals.rs`, `db/proposals.rs`, `tracker/jira/mod.rs`, `runs/answer.rs`, `runs/service.rs`, `runs/preflight.rs`, `runs/tracker.rs`, `DraftCard.tsx`, mocks | A NeedsAnswer child shows Pip's suggested reply and approving it resumes the run; a 4th approved run waits and launches later; approving one transition retires its siblings; no lock deadlock under a concurrency test. |
| **5b. GitHub review drafts** (≈1 wk) | A `GithubReview` draft kind (summary + inline comments at cited file/line, built by Core from the Review's structured findings, never from free prose); a GitHub write path limited to `POST /repos/{o}/{r}/pulls/{n}/reviews` with `event: COMMENT`, called only from the person's approval; a draft card with the diff hunk around each comment, per-comment drop/edit and an outdated-commit warning; write-access check on the token, with an in-app PR view (files, diff, the review's comments) as the fallback when posting isn't allowed; Pip can read a review draft in full (`get_proposal`) and the PR's existing review comments, discuss them with the person, and revise the draft (reword, drop or add a comment at a line the diff contains) through the same `require_pip_may_revise` rule as Jira drafts, so a draft the person edited stays theirs; a revision is still only a draft; conformance test that nothing posts to GitHub without an approval. | `domain/proposal.rs`, `proposals.rs`, `codehost/github/write.rs` (new), `codehost/mod.rs`, `inbox/drafts.rs`, `agent/supervisor.rs`, `DraftCard.tsx`, `DraftPreview.tsx`, `PullView.tsx` (new), mocks | A blocking or passing Review produces one GitHub review draft; approving it posts exactly one COMMENT review with its inline comments (mock GitHub); editing or dropping a comment changes what is posted; a token without write access shows the in-app PR view instead; asking Pip to soften or drop a comment produces a revised draft and posts nothing; no code path posts without approval. |
| **6. Enforced read-only runs** | A real permission restriction for Investigate, Triage, Plan and Review (plan mode with `--bg`, or a restricted allowed-tools list), verified against the real CLI, so auto-started read-only runs can't write even if an injection asks them to. | `runs/cli.rs`, `runs/launcher.rs`, `domain/run.rs`, `real_tests.rs`, `conformance.rs` | A read-only run that tries to write is refused by Claude Code itself, shown by a real-runtime test; then auto-start can default to on for everyone. |

**Cross-cutting test work in every phase:**
- A shared JSON fixture of supervisor decisions (wake or not, hold or not, budget) that both the Rust tests and `mockSupervisor.ts` must pass.
- Golden-scenario evals: scripted stream-json replies plus `test-support/fake-claude.sh` run scenarios that check Pip picks the right next step, stops at budget and never claims a run started.
- A restart-dedup test.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Wake loops and cost (Pip proposes → run finishes → Pip proposes…) | Wakes only on terminal or needs states; per-workstream auto-turn and wake budgets reset only by a human; global cap of 2 Pip processes; usage measured from Phase 0. |
| Approval fatigue keeps the person as orchestrator | Auto-start rules cover the routine handoffs; inline review-and-start, the Needs-you tray and per-step batches cover the rest. |
| Auto-start chains spend without anyone watching | Rules apply only in Manage mode, within the workstream budget, from Done runs, and never more than 2 fix rounds. Tripwires hold the workstream. Each rule can be switched off. |
| Injection steers a push-capable Build | The first Build starts only from the person's plan approval, and its handoff is the approved plan, filled by Core. Push is limited to a draft PR; `PUSH_ALLOWED` forbids ready-for-review and merging. Security review before Phase 2 ships. |
| Fix rounds carry agent-written text into the push-capable Build | A blocking Review auto-starts a FollowUp to the Build, and that FollowUp contains the Review's findings, which an agent wrote and which may quote hostile PR or ticket content. Mitigations: only findings marked `blocking` that cite a file and line are passed; each is length-capped, marker-wrapped and introduced by a fixed sentence saying it is data describing a defect, not an instruction; the FollowUp's own instruction is a fixed template (fix these findings in this PR, change nothing else); the Build can still only push its own branch to a draft PR; at most 2 rounds; tripwires on marker or defang hits hold the workstream; a person reviews and merges the PR on GitHub. The product owner chose automatic fix rounds, at most 2, with these mitigations (open question 2). |
| A weak reviewer passes bad work | The adversarial stance and evidence requirement, no access to Pip's notes, and a structured verdict. A human still reviews and merges the PR on GitHub. Golden-scenario evals with seeded bugs check that Review catches them. |
| Deadlocks and lock contention (notify under `launching`; `answer` holds it through a 5 s settle) | The supervisor always spawns; `launch_waiting` runs after the guard drops; a dedicated concurrency test. |
| Startup wiring cycle | `OnceLock<Weak<AgentService>>` late binding; the supervisor no-ops until bound. |
| Review stalls on the PR/GitHub-sync dependency | "Waiting for PR" step state, a targeted code-sync request, and the wake fires on PR discovery. |
| Long `--resume` sessions grow or drop out of the 50-entry allowlist | Pin workstream sessions separately; `compose()` stays self-sufficient; start a fresh session with the `[Workstream]` block when resume fails. |
| Polling latency (4 s/30 s, slower when unfocused; Done needs 2 idle polls), App Nap, laptop sleep | Show "waiting for agent" clearly; resume a sweep on wake from sleep and on focus; don't promise unattended speed. |
| NeedsPermission, folder trust and ambiguous clones stall unattended work | Surface them in the Needs-you tray with Attach/Trust; Pip only explains. |
| Many concurrent `claude` processes on a laptop | Cap Pip at 2, runs at `max_runs`; record process count and memory in diagnostics. |
| Mock/Rust drift (`mockRunKinds`, `mockRuns`, `mockProposals`) | Shared fixtures; the mock still lacks reconcile and real races, so require one real-runtime soak per phase. |
| Two conversation models until 2f | Prefer landing Phase 0 after 2f; otherwise keep `byTicket` working. |
| Duplicate Subtasks/Create drafts across runs (reconcile always keeps them) | Per-workstream same-kind supersession and Pip's dedup refusing rather than warning inside a workstream. |

## 9. Open questions for the product owner

1. Is the auto-start rule table right? In particular, should approving the plan start the Build directly, or should the person still see the Build's RunSetup?
2. Should the fix round start automatically (it carries the reviewer's findings, written by an agent, into the Build session that can push), or should the person approve each fix round? If automatic, how many rounds before it comes back to the person (proposed: 2)? **Decided:** fix rounds start automatically, at most 2 before the review comes back to the person.
3. Should auto-start wait for the enforced read-only permission (Phase 6) before it is on by default, or ship on by default in Phase 3?
4. Should Manage be the default for new workstreams once Phase 3 has proven itself, or stay opt-in per workstream?
5. Is a workstream always one ticket (plus subtasks), or can it span an epic or several repos? Single-ticket is assumed for v1.
6. Should the adversarial review ever post to GitHub, or only produce Jira drafts (proposed: Jira drafts only)? **Decided:** Review findings become a GitHub review draft the person approves in Gossamr before it is posted, as with Jira drafts (Phase 5b). If posting turns out not to be possible for a connection (for example a token without write access to pull requests), Gossamr shows the review in an in-app PR view instead.
7. Should Build require the plan-description draft to be **applied to Jira** first, or is "accepted in Gossamr" enough?
8. Should the manager use a stronger model or effort than standard Pip? It costs more per wake, and today it is pinned in `claude/mod.rs`.
9. What daily budget for Pip manager turns is acceptable on a person's subscription, and should wakes pause while the app is in the background?
10. Should Pip home become the landing screen for everyone with agents enabled, and does this land before or after build-plan 2f (classic inbox removal)? **Decided:** Pip home is the landing screen for everyone with agents enabled, from Phase 4. The classic inbox stays one key away, and a setting lets a person start on the inbox instead.
11. Structured reports (`report_result`) are now required for Triage and Review, because auto-start reads them. Should they be on for every workstream run?
12. Should Hold all also stop runs the person started outside workstreams, or only workstream runs (proposed)?