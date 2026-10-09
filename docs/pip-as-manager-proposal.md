# Proposal: Pip as manager for an agents-first Gossamr

## 1. Summary

At the moment the person runs the work and Pip gives advice. Pip answers one message at a time. It can read runs and draft an Investigate, Triage, Plan or Verify run, and after that it stops. Nothing wakes Pip when a sub-agent finishes, and moving from Plan to Build to Review is done with buttons on the run sheet. This proposal makes Pip the manager. Each piece of work becomes a **workstream**, which is a durable thread tied to one ticket or one ticketless question. In that thread Pip plans the steps (investigate, triage, plan, build, review), drafts a Gossamr run for each one, gets woken automatically when a run changes state, reads the result and drafts the next step. The person mostly talks to Pip, on a new Pip home screen, and approves things inline. The approval rules stay as they are. Nothing reaches Jira until the person approves a draft, every run starts from a digest-bound approval of the exact prompt, and Pip still has no tool that starts, stops, answers or approves anything. The new parts are a workstream record, a Rust supervisor that wakes Pip, saved conversations with a turn queue, and Pip being able to draft Build and Review as successors of finished runs. Letting runs start without a per-run approval is kept as a separate, optional final phase. It needs the product owner's decision and a real permission change first.

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
| **Supervisor (Rust, no model)** | New `agent/supervisor.rs` | Watches the runs linked to each workstream, wakes Pip, enforces budgets, holds work after a restart, and relaunches runs that a person already approved when a slot frees up. It never approves drafts, never touches the tracker, and never starts a run nobody approved. |
| **Sub-agents** | Existing Gossamr runs with today's GUARD, limits and templates | Do the work in a worktree. They never talk to Pip or to each other directly. |
| **Person** | | Approves every run start and every Jira draft, answers permission and trust prompts, and can steer or stop anything. |

### Stages

| Stage | Sub-agent | Input (Core-built) | Output | Handoff to next | Pip checks in when |
|---|---|---|---|---|---|
| Intake | Pip itself, plus GitHub read tools for cheap questions | Person's request, ticket, `[Workstream]` block | Proposed step list (Pip's notes), first run draft(s) | Pip drafts Investigate and/or Triage | Always: first run approval |
| Investigate | `Investigate` (ticketed or ticketless) | Ticket block, Pip's `focus` (≤300 chars) | "For Jira" note → comment draft; ticketless → new-ticket draft | **New** `findings`/`findings_from_run` slot, filled by Core from `Resolved.note` | Run approval; ambiguous repo (`pip_run_target` refuses) |
| Triage | `Triage` | Ticket + findings | Subtasks draft, "Plan recommended: yes/no", comment draft | Pip reads the result and proposes Plan, or says Plan isn't needed | If "no plan" and the next step would be Build, Pip asks |
| Plan | `Plan` | Ticket + findings | "Gossamr Plan" description draft (diff) | Build with `from_run=plan`; Core `attach_plan` (see the plan-edit fix below) | Pip asks the person to settle the plan draft before it drafts Build |
| Build | `Build` | Core-attached plan | Worktree branch; PR only if push was allowed | Review needs a PR (see the Publish gate below) | Always opens full RunSetup; push is off unless the person turns it on |
| Review | `Review` | Build account + PR + `pr_sha`/base (from `review_target` in `draft_run`) | Review note → comment draft | FollowUp to the Build, Verify, or a closing transition draft | Pip proposes options and never picks silently when the review finds blockers |
| Verify (optional) | `Verify` | Ticket + branch | Pass/fail note | Closing transition + summary comment drafts | — |

The stage is **derived** from the kinds and states of the linked runs (`workstream::stage(&[Run])`). It is not stored as a second state machine, so it can't drift from the tracker.

### Handoffs: three fixes the designs got wrong or missed

1. **Plan edits must reach the Build.** `plan_of_run` (`run_results.rs:269-289`) takes the Plan run's own answer, so edits the person makes to the Gossamr Plan description draft never reach the Build. Meanwhile `PLAN_FOLLOW` tells the Build agent that a person "read, edited and approved" the plan. Fix: `attach_plan` should prefer the text of the run's plan-description draft once that draft is Applied, including the person's edits, and fall back to the raw answer only when the person chose to build without settling the plan. That fallback gets a visible notice in RunSetup.
2. **Build → Review needs a PR, and a PR needs push plus a GitHub sync.** `attach_build_account` refuses a build with no PR (`run_results.rs:321`), and `change_of` finds the PR only from cached code changes after a GitHub sync (`run_results.rs:200-208`). Pip-drafted Builds always have `allow_push=false`. Two paths: (a) the person turns push on in RunSetup, which changes the digest and locks the draft against Pip, or (b) a **Publish gate**, which is a person-approved FollowUp with a new `grants_push` flag that resumes the finished Build session to push and open a draft PR. Either way, when a Build reaches Done with no PR yet, the supervisor marks the step "waiting for PR", requests a code sync for that repo, and wakes Pip only when the PR appears.
3. **Review pins come from `draft_run`, not `attach_build_account`.** `attach_build_account` sets only `pr` and `build_account`. `pr_sha`/`base` come from `review_target`. Pip's chained Review must therefore go through a Pip variant that runs the same `review_target` step. It must not go through `Core::draft_run`, which stamps `Origin::Board`/`CreatedBy::User` and would make Pip's drafts look like the person's.

### Parallelism

- Within a workstream, Pip may draft several runs in one turn, for example Investigate in two repos, or Verify alongside Review. Build is limited to one per workstream at a time.
- Across workstreams, runs share the existing `max_runs` cap (1-6, default 3). Approved runs over the cap **wait** instead of failing (Phase 5).
- Pip turns: one in flight per conversation, at most 2 Pip processes globally (configurable). Events that arrive during a turn are merged into the next wake.

### When Pip checks in with the person

- **Always:** every run start, every Jira draft, Build (full RunSetup), push/Publish, answering a sub-agent's question, NeedsPermission/SystemBlocked/folder trust (the Terminal, via `attach`), ambiguous repo or clone, any hold, and running out of budget.
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
 RunService.launch ◀── only for runs a person approved (runs_approve) or Queued-at-cap runs (launch_waiting, after lock drop)

 SQLite: workstreams · pip_turns · workstream_events (audit) · runs.spec.workstream · proposals(+origin/workstream columns)
```

### Where orchestration state lives

All durable state lives in Rust/SQLite. The frontend only displays it.

| Data | Storage | Notes |
|---|---|---|
| `Workstream { id, connection_id, item_key?, repo?, title, pip_session?, mode, held_reason?, budget, spent, notes?, created_at, closed_at? }` | New `domain/workstream.rs`, `db/workstreams.rs`, table in `db/schema.rs` | `mode` is the autonomy level (§6). No step state machine; the stage is derived. |
| Run ↔ workstream | `RunSpec.workstream: Option<String>` | **Must be added to `RunSpec::digest` by hand** (`run.rs:308-340` builds an explicit canonical JSON) and left out when `None`, so old digests stay valid. Not rendered into the prompt. |
| Draft ↔ workstream | `Origin::Chat { request_id, workstream }` (`#[serde(default)]`); run-origin drafts inherit it from `run.spec.workstream` in `run_results.rs`/`plan_description.rs` | Add `origin_kind`/`workstream` **columns** on `proposals` (today a single JSON blob, `schema.rs:101-108`) and `ProposalQuery.workstream`. |
| Provenance | `CreatedBy::Agent` as a **unit variant**, so it stays `Copy` and the TS union becomes `'user'|'pip'|'autopilot'|'agent'`; the run id and kind are already in `Origin::Run` | Replaces the `CreatedBy::User` overload for run-result drafts (`run_results.rs:422,478,523`, `plan_description.rs:161`). Rewrite `require_pip_may_revise` (`proposals.rs:260-278`) to allow Agent drafts in the same workstream, keeping the "Edited" lock. |
| Transcripts | New `pip_turns(conversation, request_id, role user|pip|wake, prompt, text, steps_json, status, usage_json, created_at)` | Replaces in-memory `claudeStore`. Wake turns must be registered by the backend, because `updateByRequest` drops unknown requestIds. |
| Pip session per workstream | `Workstream.pip_session` | It must be pinned in the resume allowlist separately from the 50-entry LRU (`OWN_SESSIONS_KEPT`, `inbox.rs:50`), or long workstreams silently stop resuming. |
| Audit | `workstream_events` append-only table (actor Person/Pip/Supervisor/Run, action, ids, digest) | Exportable. A hash chain is optional and comes later. |
| Supervisor queue | In memory, rebuilt from run states and `workstream_events` on startup | An idempotency key `(workstream, run, state)` makes sure a duplicate wake is a no-op. |

### Rust modules

| Module | New/changed | Purpose |
|---|---|---|
| `agent/queue.rs` | New | Per-conversation FIFO of `User(AskRequest) | Wake(WakeFacts)`. One turn in flight per conversation, global cap 2. A user message cancels a pending or in-flight wake. Wakes merge. |
| `agent/supervisor.rs` | New | `on_run(run, attention)` **spawns** a task and never does work inline, because `notify` runs under `RunService.launching` (`tracker.rs:239`). It runs a periodic sweep over linked runs to catch the events the notifier never emits: a person-Stopped run, a Done-after-continuation that drafted nothing, or `draft_on_finish` turned off (`tracker.rs:396-407`). It holds budgets, the hold state and recovery. |
| `agent/workstream.rs` | New MCP module | `get_workstream`, `list_workstreams`, `set_workstream_notes` (≤2 KB, scrubbed, fed back as data), `propose_answer`. Chained into `tool_list`/`run_tool`/`tool_label` like `runs.rs`. |
| `agent/mod.rs` | Changed | `AskRequest` gets `conversation` and `workstream`. `PipRun` gets `workstream`. Turns go through the queue. Usage is recorded per turn. |
| `agent/context.rs` | Changed | `system_prompt(Role::{Assistant, Manager})`. `compose()` adds a `[Workstream]` block (stage, notes, linked runs, the workstream's drafts, the person's recent overrides) and an `[Event]` block for wakes. "[Open drafts, from everyone]" (`context.rs:245`) is **scoped and capped** when in a workstream. |
| `claude/stream.rs` | Changed | Stop dropping `result.usage`/`total_cost_usd`, and emit them on `Done` so Pip turns can be budgeted. |
| `claude/mod.rs` | **Unchanged** | Same flags, tests, sandbox and token handling. |
| `domain/run.rs` | Changed | `pip_chain_kinds()` (Build only with `from_run`=Done Plan; Review only with `from_run`=Done Build with PR). Add a `findings` slot plus a `<<<FINDINGS` marker in `MARKERS`/`without_markers`. Add `workstream` to the digest. |
| `inbox/pip_runs.rs`, `inbox/run_results.rs` | Changed | A Pip chain variant of `draft_run` that runs `attach_plan`/`attach_build_account`/`attach_findings`/`review_target` and stamps Pip provenance. Plan-edit propagation. |
| `agent/runs.rs` `kind_of` (494-501) | Changed | From "refuse Build/Review" to "Build/Review only as successors with a valid `from_run`". `allow_push` is forced false. |
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
| Run start (Build/Review) | Always the full `RunSetup` sheet. |
| Answer, FollowUp, Publish | Editable text inline, then ⌘⏎ to send. |

**Steering and interrupting.** Composer verbs are handled by the frontend and call the existing user-only commands: `/stop R7`, `/answer R9 …`, `/retry R7`, `/hold`, `/resume`. They are person actions and Pip gets no new tool. Each one is written to `workstream_events` and shown to Pip in the next `[Workstream]` block ("the person stopped R7"). `@R7 also check X` makes Pip draft a FollowUp. Esc closes a sheet first, then cancels Pip's turn (`cancel_claude`). A message sent mid-turn queues, and pre-empts a wake.

**Board, list and peek alongside Pip home.** These are deliberately **not** moved into a new "Stage" column, because that would refactor Esc/focus handling that tests pin. The canvas stays a route one keystroke away (⌘1). PeekSheet and AgentSheets stay overlays. On other routes, ⌘J opens the docked pane showing the workstream of the selected ticket, or General. `set_view_filter` is relaxed from "workspace conversation only" (`PipExtras.tsx:48-51`) to "the focused conversation". The Agents route gains "By workstream" grouping (`agentsLogic.groupRuns`). Activity gains a "Pip & agents" chip that reads `workstream_events`. The peek's "Agents on this ticket" links to the workstream. With the agents flag off, the app behaves exactly as today.

## 6. Safety, control and cost

### Approval invariants (unchanged and enforced by tests)

| Invariant | How it holds |
|---|---|
| No Jira write without the person's approval | The only route is `approve_proposal → begin/execute/finish → WorkTracker::apply`. The supervisor gets a narrow `SupervisorCore` facade with no tracker handle and no `approve_proposal`/`transition`/`comment`/`create_subtasks`/`attach`. New conformance test `orchestration_never_writes_jira`: run a full mock workstream and assert that `tracker.intents()` is empty until a person approves. |
| Runs start only from digest-bound approval | The supervisor's only launch path is `launch_waiting()` for runs already Queued by `runs_approve`. |
| Pip has no power tools | The conformance suite (`agent/conformance.rs:298-319`) keeps forbidding start/stop/answer/attach/rm/approve, and a sibling probe covers `agent/workstream.rs`. Pip deliberately gets **no** stop or hold tool, so injected text can't stall work. |
| Pip's process is unchanged | `claude/mod.rs` flags and tests stay as they are. Wake turns are ordinary asks with a fresh per-request token. |
| Handoff text comes from Core | Plan, findings, build account and PR are filled by `attach_*`. Pip supplies kind, `from_run` and a ≤300-char focus, and nothing else. |
| Person edits are final | The "Edited" lock is kept under the new `CreatedBy::Agent`. |

### Autonomy levels (per workstream, capped by a global Safety setting)

| Level | Behaviour | Default |
|---|---|---|
| **Advise** | Today's Pip inside a workstream. It speaks only when asked, and run nudges stay in the frontend. | For workstreams adopted from existing runs |
| **Manage** | The supervisor wakes Pip on run events. Pip reads results and drafts next steps. Every run start and Jira write still needs the person. | Default for new workstreams once Phase 3 has shipped and soaked |
| **Standing grant** (Phase 6, gated) | A person-approved grant lets the supervisor start matching Pip-drafted Investigate/Triage/Plan runs without a per-run sheet, within a run count and time window. | Off and hidden until the product owner signs off |

A caveat for the Standing grant: the "read-only" kinds are read-only **by instruction only**. `docs/agents-cli-findings.md` calls this "a request, not a lock". Runs use the person's own permission mode with full tools, repository hooks may fire (unverified), and Verify runs the repo's tests. A grant should therefore require a real enforcement change first, such as `--permission-mode plan` with `--bg` (currently unverified) or a restricted allowed-tools list. Verify and Build are never covered.

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

Pip's sandbox is unchanged. Sub-agents keep their worktrees, their GUARD, Gossamr never writing folder trust, run-index-only stop/rm, and no `--discard-unpushed`. A Pip-drafted Build always has `allow_push=false`, and only a person (RunSetup toggle or the Publish gate) enables a push.

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
| **2. Pip drafts the whole chain** (≈1.5 wk) | `pip_chain_kinds()`; Pip chain variant of `draft_run` (with `attach_*` + `review_target`, Pip provenance, push forced off); `findings` slot + `attach_findings`; plan-edit propagation; Publish gate (`FollowUp.grants_push`); "waiting for PR" handling; `Role::Manager` prompt; `findRunDraft` recognises Pip chain drafts. | `domain/run.rs`, `agent/runs.rs`, `inbox/pip_runs.rs`, `inbox/run_results.rs`, `runs/follow_up.rs`, `agent/context.rs`, `conformance.rs`, `runSheetLogic.ts`, `mockRunKinds.ts`, `mockRuns.ts` | In one workstream Pip can draft investigate → … → review, each opening with Core-attached handoffs; Build/Review without the right Done source are refused (tests); an edited and applied plan is what the Build carries; Review is reachable through toggle or Publish. |
| **3. Supervisor wake-up** (≈1.5 wk) | `agent/supervisor.rs` with FanoutNotifier (spawned, never inline), late-bound `OnceLock<Weak<AgentService>>`, all attentions **including `DraftedTicket`**, a sweep for Stopped/silent Done; Rust `[Event]` prompts; backend sink and `claude` events with `conversation`/`kind`; Manage mode, budgets, Held-on-restart, idempotency key, quota backoff; Hold all; frontend nudges suppressed for Managed workstreams. | `agent/supervisor.rs` (new), `agent/mod.rs`, `agent/context.rs`, `runs/tracker.rs`, `lib.rs`, `claude.ts`, `claudeStore.ts`, `pipRuns.ts`, `PipExtras.tsx`, `mockSupervisor.ts` (new) | With Manage on, a finished run produces exactly one Pip turn that summarises it and drafts the next step with no click; that turn starts no run and applies nothing (probe); a restart leaves workstreams Held with at most one wake per terminal run; budget exhaustion pauses. |
| **4. Pip home** (≈1.5 wk) | `'pip'` route (opt-in default), workstream list + Needs-you tray, step rail, inline review-and-start for Investigate/Triage/Plan/Verify, per-step batch approve, wake-turn rendering, Activity chip, peek link, relaxed `set_view_filter`, palette/suggestions. | `tabsStore.ts`, `Workspace.tsx`, `Rail.tsx`, `PipHome.tsx`, `StepRail.tsx`, `NeedsYouTray.tsx` (new); `DraftPreview.tsx`, `runSetupStore.ts`, `useCards.ts`, `ActivityView.tsx`, `activityLogic.ts`, `commands.ts`, `suggestions.ts`, `prefs.ts` | A person can take a ticket from intake to review mostly by talking to Pip, approving inline; keyboard walkthrough without a mouse; agents flag off means today's workspace. |
| **5. Questions, capacity, draft hygiene** (≈1 wk) | `Intent::RunAnswer` + `propose_answer` + `runs_answer_draft`; queue-at-cap (service + amber preflight row + `launch_waiting` after the lock drops, ordered against `answer`'s 5 s settle); per-workstream pending-draft cap and same-kind supersession; sibling-transition retirement; Basis-drift tripwire. | `domain/proposal.rs`, `proposals.rs`, `db/proposals.rs`, `tracker/jira/mod.rs`, `runs/answer.rs`, `runs/service.rs`, `runs/preflight.rs`, `runs/tracker.rs`, `DraftCard.tsx`, mocks | A NeedsAnswer child shows Pip's suggested reply and approving it resumes the run; a 4th approved run waits and launches later; approving one transition retires its siblings; no lock deadlock under a concurrency test. |
| **6. Standing grant (product decision)** | `Intent::Grant` for Investigate/Triage/Plan only, with a real permission restriction; supervisor-applied approvals recorded with the grant id; visible, revocable, capped. | `domain/proposal.rs`, `agent/supervisor.rs`, `inbox/drafts.rs`, `db/runs.rs`, `runs/cli.rs`, `conformance.rs`, `StepRail.tsx` | The product owner signs off; enforcement is verified against the real CLI; tests prove Build, Review, Verify and all Jira writes still need per-item approval. |

**Cross-cutting test work in every phase:**
- A shared JSON fixture of supervisor decisions (wake or not, hold or not, budget) that both the Rust tests and `mockSupervisor.ts` must pass.
- Golden-scenario evals: scripted stream-json replies plus `test-support/fake-claude.sh` run scenarios that check Pip picks the right next step, stops at budget and never claims a run started.
- A restart-dedup test.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Wake loops and cost (Pip proposes → run finishes → Pip proposes…) | Wakes only on terminal or needs states; per-workstream auto-turn and wake budgets reset only by a human; global cap of 2 Pip processes; usage measured from Phase 0. |
| Approval fatigue keeps the person as orchestrator | Inline review-and-start, the Needs-you tray, per-step batches. Phase 6 is a separate, explicit decision and shouldn't arrive by drift. |
| Widening Pip to draft Build/Review opens a path for injection to steer a push-capable run | Successor-only gate; Core-only handoff text; push forced off; RunSetup always shown for Build; security review before Phase 2 ships. |
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

1. Should runs ever start without a per-run read of the prompt (Phase 6)? If so, is Investigate/Triage/Plan the right set, and is a real permission restriction a precondition (recommended)?
2. Should Manage be the default for new workstreams once Phase 3 has proven itself, or stay opt-in per workstream?
3. Is a workstream always one ticket (plus subtasks), or can it span an epic or several repos? Single-ticket is assumed for v1.
4. Publish: is a FollowUp with `grants_push` acceptable, or do you want a dedicated short Publish run kind? Should Review ever post to GitHub, or only produce Jira drafts?
5. Should Build require the plan-description draft to be **applied to Jira** first, or is "accepted in Gossamr" enough?
6. Should the manager use a stronger model or effort than standard Pip? It costs more per wake, and today it is pinned in `claude/mod.rs`.
7. What daily budget for Pip manager turns is acceptable on a person's subscription, and should wakes pause while the app is in the background?
8. Should Pip home become the landing screen for everyone with agents enabled, and does this land before or after build-plan 2f (classic inbox removal)?
9. Should `report_result` (structured run reports) be on by default for workstream runs, so Triage's "Plan recommended" and subtasks are machine-readable instead of parsed from free text?
10. Should Hold all also stop runs the person started outside workstreams, or only workstream runs (proposed)?