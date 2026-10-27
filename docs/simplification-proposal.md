# Proposal: Gossamr, simplified

## 1. Summary

Gossamr today is about 207,000 tracked lines (code, tests, fixtures and e2e), built around an idea the owner no longer wants: the app polices the agents. It has four separate mode systems, about 40 settings, about ten ways to start an agent, six auto-start rules with per-workstream overrides, budgets, holds, tripwires, a read-only permission regime, a permission-prompt classifier and a preflight checklist. On top of that, a TypeScript copy of most of these rules is kept in step with the Rust by 10,000 lines of shared fixtures.

This proposal cuts Gossamr down to four concepts and one loop:

- **Pip** is the only driver. The person talks to Pip. Pip sees every workstream and every agent, starts and steers agents, and drafts every update Gossamr makes to Jira and GitHub.
- **Workstreams** are the only container: one ticket (or one ticketless question), with its agents, its drafts and its Pip conversation.
- **Agents** are plain Claude Code background sessions (`claude --bg --worktree`) that run with the person's own Claude config. Gossamr adds one MCP server to each session, so the agent can report back, ask Pip a question and read its workstream.
- **Drafts** are the one gate that stays. Every write Gossamr makes to Jira or GitHub is a draft the person approves with one key. Agents push their own branches and open draft PRs with their own `git` and `gh`, as any Claude Code session would (Section 10).

What that adds up to:

- One mode (Pip manages) and one way to start work (ask Pip).
- One result channel (the agent's `report` call), with the transcript as a fallback.
- One draft card and one status word per workstream.
- About 40% of the codebase goes. Section 9 has the per-area figures, and a few of them are judgement calls.

## 2. Gossamr today

### 2.1 Architecture

```
React (Vite, Zustand)                         Rust (Tauri 2)
──────────────────────                        ──────────────────────────────────────────────
Workspace shell ── Board/List/Map/Age         lib.rs: 142 commands, 11 window events
Classic inbox (2nd UI, still mounted)         Core (inbox/*): cache, drafts, workstreams, runs-to-drafts
Peek sheet, palette, tabs, saved views        proposals.rs: draft → approve → apply (one write gate)
Agents screen + Needs-you filter              tracker/jira, codehost/github, auth (Atlassian OAuth, GitHub)
Pip pane (claudeStore)            ──ask──▶    AgentService: one `claude -p` per Pip turn, turn queue
Run setup sheet, inline start, run sheet      McpServer "gossamr": 35 tools for Pip (read + propose_*)
Draft cards, review drafts, rewrite diff      Supervisor: wakes Pip, applies 6 auto-start rules, budgets
Mock backend (21 modules, ~11k lines)         RunService: preflight, gates, `claude --bg --worktree`, tracker
                                              ReportServer "run-report": 2nd MCP server, 1 tool, stable port
                                              one SQLite file per signed-in account, 13 migrations, Keychain
```

**Pip** runs as `claude -p` with every built-in tool off, no user settings and only the `gossamr` MCP server. It can read and draft, but it can never touch files, a shell or the network.

**Agents** run as `claude --bg --worktree` in a clone of the repo.

- **State** comes from polling `claude agents --json`.
- **Results** come from an opt-in `report_result` tool on a second MCP server. More often they come from parsing headings such as `For Jira:` and `Verdict:` out of the final answer.

### 2.2 What it does

| Area | Features |
|---|---|
| Jira | Sync and cache; board, list, map and age views; tabs and saved views; peek sheet with comments and mentions; transitions by drag; watch list with modes, depth, pins and a 14-day grace period; footprint and "assigned elsewhere" radar; activity feed (mentions, comments, status, assignments); "What Jira saw from me" log |
| GitHub | Sign-in three ways; PR, branch and check badges per ticket; in-app PR diff viewer; GitHub review drafts posted as comment reviews |
| Pip | Docked conversation per workstream plus General; streamed answers; screenshots; quoted selections; 35 MCP tools; wake turns from the supervisor; a first-run 22-term glossary; nudge bubbles; suggestion chips; a slash-command grammar; a view-filter tool with undo and redo |
| Agents | Six kinds (investigate, triage, plan, build, review, verify) with fixed prompt templates; setup sheet or inline start; digest-bound approval; read-only enforcement for five kinds; permission Allow-once-in-Terminal; limits; fresh clones; continuation adoption; archive, clear and clean-up |
| Workstreams | Advise/Manage mode; six auto-start rules with tri-state overrides; budgets with "Allow 5 more"; six hold reasons; four tripwires; readiness stop; clarity check with per-project learning; reporter-wait tracking; cobweb staleness; adopt; 60-second undo |
| Planning | Start my day; Plan my week; Needs you (14 need kinds in 3 groups) |
| Drafts | 11 intent kinds; about 15 supersession rules; plan and triage sections written into descriptions; risky-text pause; basis drift checks |

### 2.3 The census of extra machinery

| Thing | Count today | Where |
|---|---|---|
| Mode systems | 4: Advise/Manage, Agents on/off, classic/workspace UI, start-on-Agents | `domain/workstream.rs`, `config.rs`, `agentsFlag.ts`, `prefs.ts` |
| Ways to start an agent | about 10 (see below) | `commands.ts`, `AgentMenu.tsx`, `runSetupStore.ts`, `InlineStart.tsx`, `agent/autostart.rs` |
| Ways to create a workstream | 6 entry points into one command | `workstreamsStore.ts`, `Palette.tsx`, `PeekSheet.tsx`, `PlanMyWeek.tsx` |
| Settings and knobs | about 40 | `Settings.tsx`, `AgentsSettings.tsx`, `WatchSettings.tsx`, `config.rs`, `prefs.ts` |
| Ways to resume a session | 4 (answer, follow-up, automatic fix round, person fix round) | `runs/answer.rs`, `runs/follow_up.rs` |
| Result channels | 3 (MCP report, heading parser, transcript tail) | `runs/report/`, `runs/result.rs`, `runs/final_answer.rs` |
| Status vocabularies | 4 (run lanes, 7 workstream statuses, 8 stages, 14 need kinds) | `agentsLogic.ts`, `workstreamStatus.ts`, `workstreamStage.ts`, `needs.ts` |
| Tauri commands and events | 142 and 11 | `lib.rs` |
| Rust and TypeScript rule mirrors | about 10,000 lines of shared JSON fixtures, about 11,000 lines of mock backend (18,000 with its tests) | `*.fixtures.json`, `src/backend/mock*.ts` |

The ten ways to start an agent are:

- the palette, two ways;
- the ticket menu;
- the Agents button;
- Build-from-plan;
- Review-this;
- retry;
- the Pip StartRun card;
- inline start;
- suggestion chips;
- auto-start and fix rounds.

Nearly all of this exists to stop an agent or Pip from doing something without the person's say-so. The vision turns that around:

- The person drives by talking to Pip.
- Claude Code's own harness polices the agents.
- Gossamr guards only its own writes to Jira and GitHub.

## 3. The target model

### 3.1 Four concepts

| Concept | What it is | Stored as |
|---|---|---|
| Workstream | One ticket or one ticketless question, with its agents, drafts and Pip conversation | `workstreams` row: id, item key, repo, title, Pip session id, Pip notes, paused reason, closed at |
| Agent | One Claude Code background session in a worktree, with a role label and the brief Pip wrote | `runs` row: id, start key, workstream, role, brief, repo, clone, base, PR and pinned SHA, worktree, session id, short id, state, timestamps. Its report is kept apart in `run_reports`. |
| Pip | The conversation that drives everything | `pip_turns` |
| Draft | A Jira or GitHub write waiting for the person | `proposals` row: target, kind, payload, basis, state |

Everything else (the status word, what needs you) is derived on read.

### 3.2 The loop

```
 person ──talks──▶ Pip (claude -p, gossamr MCP)
                    │  reads: tickets, activity, PRs, workstreams, agents, reports, drafts
                    │  acts:  open workstream · start / message / stop agent · draft · ask the person
                    ▼
            agent sessions (claude --bg --worktree, the person's own Claude config)
                    │  gossamr MCP (agent token): report · ask · read_workstream · read_ticket
                    ▼
            run state changes (claude agents --json) ──wake, once per (agent, state)──▶ Pip
                    │
                    ▼
            drafts ──person approves (one key)──▶ Jira / GitHub
```

There is no rule table. When an agent finishes, Gossamr wakes Pip in that workstream with the facts: ids, role, state, and whether the agent reported. Pip reads the report and decides what to do next. It might:

- start a reviewer;
- send the builder a fix;
- draft the Jira comment;
- ask the person.

Pip follows the person's instruction for that workstream. "Plan and build CA-412, have it reviewed" is the authority for Pip to start a planner, then a builder, then a reviewer, without asking again for each one.

### 3.3 Roles are labels, not tiers

Pip picks the role (planner, builder, triager, reviewer, investigator, or anything else) and writes the brief. The six fixed templates, the per-kind required fields (`plan_from_run`, `build_account`, `findings_from_run` and others) and the per-kind permission profiles all go.

Gossamr still writes one base brief around Pip's text, because some facts only Gossamr can get right:

- **Checkout.** A worktree starts at the clone's current HEAD, not at the base branch (`domain/run.rs:738`). The base brief always says: run `git fetch origin <base>` and switch to it before you start.
- **Pull requests.** When Pip passes a PR, `start_agent` checks that it is same-repo (`CodeChange::is_same_repo`) and pins its head SHA at start. The base brief then says: fetch `pull/<n>/head`, check out `<sha>` detached, and stop if that fails rather than reviewing the base instead (today's rule, `domain/run.rs:682-706`).
- **Data.** The ticket block is fenced as data. One sentence says how to use `report`, `ask` and `read_workstream`.

A handoff is a report that the next agent reads with `read_workstream`. It is no longer a typed slot that Core fills.

## 4. Pip as the driver

### 4.1 Tools

Pip keeps its read tools, trimmed and merged. It gains the tools to drive agents and to ask the person. The `propose_*` family merges into one draft tool.

| Tool | Replaces |
|---|---|
| `search_items`, `read_item`, `list_statuses` | `search_items`, `get_item`, `find_containers`, `list_containers`, `get_workflow`, `list_next_statuses` |
| `read_activity(since?, kinds?)` | nothing today: mentions, comments, status and assignment changes on watched tickets |
| `read_pr`, `list_prs`, `read_repo_file`, `search_code`, `list_watched_repos` | the 9 GitHub tools |
| `list_workstreams`, `read_workstream`, `open_workstream`, `close_workstream`, `set_notes` | `get_workstream`, `list_workstreams`, `set_workstream_notes` and the UI-only open command |
| `list_agents`, `read_agent(id, page)` | `list_runs`, `get_run`, `get_run_result`, `get_run_events` |
| **`start_agent(workstream, role, brief, repo?, pr?)`** | `propose_run`, the StartRun draft, the setup sheet, digest approval, inline start and auto-start |
| **`message_agent(agent, text)`** | `propose_follow_up`, `propose_answer`, the FollowUp and RunAnswer drafts, and fix rounds |
| **`stop_agent(agent)`** | the person-only stop |
| **`ask_person(workstream, question)`** | nothing today: makes a "Pip asks you" need and a notification |
| `list_drafts`, `read_draft`, `draft(kind, target, payload)`, `revise_draft`, `retire_draft` | `list_proposals`, `get_proposal`, `propose_comment`, `propose_transition`, `propose_subtasks`, `propose_create`, `propose_description_edit`, `revise_proposal`, `retire_proposal` |

`set_view_filter` and the `pip-view` event go. Pip says where to look instead of moving the page.

**`start_agent`** takes an idempotency key that Gossamr derives from the Pip turn and the call. A retried MCP call or a duplicate wake can therefore never launch the same agent twice; this replaces today's `UNIQUE(runs.proposal_id)` guard (Section 8). Gossamr also does three other things:

- It resolves the clone and base branch.
- It generates the worktree slug itself. The role is a short free-text label, checked for length and characters, and used only in the session name.
- It records which turn started the agent.

**`message_agent`** behaves by the agent's state:

| Agent state | What `message_agent` does |
|---|---|
| working | Queues the text. Gossamr delivers it as the answer to the agent's next `ask`, or by resume when the turn ends. |
| waiting on `ask` | Returns the text as the answer, with no stop or resume. |
| ended with a question, done or stopped | `claude --bg --resume <session> -- <reminder + text>`, 5 s after stop, with the returned id checked (`docs/agents-cli-findings.md`). |
| waiting at a permission prompt | Refused. The person answers in Terminal. |
| attached in Terminal | Refused. The person is in it. |

The reminder prefix (`runs/answer.rs:20`) stays, because a brief falls out of a long conversation.

### 4.2 What stays locked on Pip

Pip keeps its current boundary:

- no built-in tools;
- no user settings;
- only the `gossamr` MCP server;
- reads scoped to watched projects and repos and to the tickets the person handed it.

Pip reads untrusted ticket and PR text all day, and it can now start agents, so this boundary is worth more than before. Pip does not need a shell: when it needs code read or changed, it starts an agent.

Pip keeps an explicit model pin. It runs with `--setting-sources ""`, so the person's default model is never read (Decision 6).

### 4.3 Wakes

The supervisor shrinks to a waker.

**When Pip is woken.** A wake comes when an agent in a workstream changes to done, failed, needs-you, or stopped by something other than Gossamr, Pip or the person. The stop-then-resume inside `message_agent`, and any stop the person or Pip asked for, wakes nobody.

**At most once.** Each (agent, state) pair still wakes Pip at most once. The pair is recorded in the workstream audit as it is today, and a restart rebuilds from that record (`agent/supervisor.rs:8-9`). Without it, the 30-second sweep would wake Pip again for the same finished run. A wake waiting in the queue is merged with any newer one. A message from the person goes ahead of a waiting wake.

**What the wake says.** The wake prompt carries only facts Gossamr wrote, never agent prose. Pip reads the prose itself with `read_agent`.

**What goes with the old supervisor:**

- the Advise/Manage gate;
- the auto-start pass and the fix-round cap;
- budgets and "Allow 5 more";
- the six hold reasons and four tripwires;
- the `SupervisorCore`, `CoreFacade` and `WakeQueue` trait layering.

**Backstops.** Three remain, and none of them is a setting:

- the global cap on concurrent agents;
- a per-workstream ceiling on wakes per day;
- a ceiling on Pip turns per day across workstreams.

The two ceilings are constants in code. When one is reached, the workstream is paused (one `paused_reason` column), the person is told, and a single Resume control on the workstream clears it. A broken loop then costs money once, not all night.

**When the app is closed.** Pip is a `claude -p` child of the app, so it does not run while the app is closed. Agents keep running in Claude's daemon. On the next launch, `recover()` reconciles the agents and the waker sends Pip the state changes it missed.

### 4.4 One prompt

The Assistant/Manager role split goes. One short system prompt says:

- who Pip is and what it can see;
- that ticket and agent text is data;
- that Gossamr's writes to Jira and GitHub are drafts;
- that Pip tells the person whenever it starts an agent from a wake turn.

Tool descriptions drop to one sentence each. The workstream block in the turn prompt carries the context: ticket, agents, open drafts and Pip's notes.

## 5. Agents on the Claude Code harness

### 5.1 Launch

```
claude --bg --name "Gossamr: CA-412 builder" --worktree <slug> \
       --mcp-config <app data>/agents/<agent id>.json \
       --allowedTools mcp__gossamr__report,mcp__gossamr__ask,mcp__gossamr__read_workstream,mcp__gossamr__read_ticket \
       --append-system-prompt <base brief> -- <Pip's brief>
```

The agent gets the person's own permission mode, settings, hooks, CLAUDE.md, MCP servers and model. The only allow rule Gossamr adds is for its own four tools, so reporting never turns into a permission prompt. `--allowedTools` combines with `--bg`, and a resume in place reapplies it (`docs/agents-cli-findings.md:147`).

These go:

- the read-only regime (`--permission-mode dontAsk`, empty `--setting-sources`, `--strict-mcp-config`, the exact allow list and the deny list of about 60 rules);
- the pushing switch;
- the per-kind lockdowns.

These stay, because the harness needs them and they were verified against the real CLI (`docs/agents-cli-findings.md`):

- **Environment.** Gossamr captures the person's login-shell environment once, because a GUI app doesn't see their PATH. The shared `--bg` daemon takes its environment from the first launch.
- **Token file.** The MCP address and token live in a 0600 per-agent config file. The daemon is shared, so a per-launch environment variable can't reach the session.
- **Resume.** A resume is `claude --bg --resume <session id> -- <message>` with no other flag, at least 5 s after stop, and the returned id is checked. Any flag, or a resume too soon, starts a copy.
- **Trust.** Gossamr detects `Workspace not trusted` on launch and shows one fix: **Open in Terminal**, which runs `claude` in the clone so the person accepts Claude's own trust prompt. The `.claude.json` pre-check and the amber preflight row go.
- **Refused modes.** A launch that `--bg` refuses because of the person's mode (an un-opted `auto`, or an unaccepted `bypassPermissions`) fails with Claude's own message and the same Terminal fix.
- **Cleanup and git.** `claude rm` is never forced. Gossamr's own git calls keep hooks off, a timeout and no prompts.
- **Clones.** Gossamr looks for a clone in `~/Code`, `~/Developer` or `~/src` whose origin matches the repo. If there are several, or none, the person picks one or clicks **Clone it** on the workstream. Pip can't choose a clone path.

### 5.2 The agent's side of the MCP server

The second server (`run-report`) merges into the one `gossamr` server. The merged server keeps what made `run-report` survive restarts, which today's `gossamr` server lacks (it binds port 0 and keeps its tokens in memory, `agent/mcp.rs:94-110`):

- **Port.** A remembered port that it binds again on every start, so an agent's config file stays valid across app restarts.
- **Tokens.** Agent tokens are stored as hashes in the account database. They are revoked when the agent reaches done, failed or stopped, and removed with the worktree.
- **Scope.** Two token kinds. Pip's per-turn token reaches Pip's tools. An agent token reaches only that agent's four tools.

| Agent tool | Purpose |
|---|---|
| `report(status, summary, body?, reviewed_sha?)` | `status` is `done`, `blocked` or `question`. `summary` is one line. `body` is Markdown (a plan, findings, a review with `file:line` references). A reviewer passes the SHA it reviewed. |
| `ask(question)` | Waits for Pip (or, through Pip, the person) to answer, up to a fixed time. On timeout it returns "no answer yet: end your turn with the question", and the answer then comes by resume. |
| `read_workstream()` | The ticket block, Pip's notes, and the reports of earlier agents in this workstream. This is how a builder reads the plan and a reviewer reads the builder's account. |
| `read_ticket(key)` | Cached ticket text for a linked ticket, fenced as data. |

The report stays in its own `run_reports` table. The tracker rewrites the run's blob on every poll, and a report written there could be lost (`db/schema.rs:216-218`).

The heading parser (`runs/result.rs`, 1,138 lines) goes. If an agent ends without calling `report`, its last transcript message becomes the summary, and Pip is told that the agent didn't report. That fallback is the second result channel.

Agent tokens keep honest agents in their lane. They are not a security boundary: agents run as the same macOS user, so an agent can read other agents' config files, the account database, and Pip's token from Pip's process environment. Section 10 covers what that means.

### 5.3 Permission prompts and questions

A `--bg` session's permission prompt can't be answered from outside. `--permission-prompt-tool` works only with `--print`, which `--bg` rejects, and any flag on resume starts a copy. So Gossamr handles prompts this way:

- **Permission prompt.** The agent shows as needs-you with the command Claude asked about, and one button, **Open in Terminal**, runs `claude attach <id>`. The person answers Claude's own prompt there.
  - Gossamr keeps the Terminal or iTerm choice for this button.
  - These go: the classifier in `runs/permission.rs`, its TypeScript copy and fixtures, Allow-once-in-Terminal with its explainer, and Deny-by-stop-and-resume.
- **Question.** The agent calls `ask`. Pip answers from what it knows, or calls `ask_person`.
  - If the answer is quick, the agent carries on in the same turn with no stop or resume.
  - If not, the agent ends its turn with the question, and `message_agent` resumes it later.

People who want fewer prompts change their own Claude Code default mode. Gossamr adds no setting for it.

### 5.4 States

The ten stored run states stay, because `recover()` depends on Launching to adopt or fail a run after a restart (`runs/service.rs:630-640`), and Unknown marks a lost session.

The UI shows six:

- queued;
- working (launching and working);
- needs you (question, permission prompt or sign-in);
- done;
- failed (failed and unknown after the recovery window);
- stopped.

The state mapping from `claude agents --json` (`runs/state.rs`) stays. It is verified, and it is the only source of truth.

## 6. Drafts: the one gate

Every write Gossamr makes to Jira or GitHub stays a draft the person approves. Approval earns its friction here: these writes are public, other people read them, and Pip reads untrusted text. Starting, messaging and stopping agents are no longer drafts.

| Today | After |
|---|---|
| 11 intent kinds, including StartRun, FollowUp and RunAnswer | 8 write kinds: comment, transition, create, update fields, rewrite title or description, link, subtasks, GitHub review. Stored StartRun, FollowUp and RunAnswer drafts are retired in a migration. |
| 6 `auto_draft_*` functions run when a run finishes | Pip drafts from the agent's report on the wake |
| about 15 supersession rules | One: a newer pending draft of the same kind on the same target replaces the older one, unless the person edited the older one |
| Plan as a comment, as a description section, or as a triage section, each with fallbacks | Pip drafts a comment, plus a description rewrite when it wants the plan in the ticket. The `Gossamr Plan` expand helper stays as a formatting helper for that rewrite. |
| Digest-bound approval for run starts | Goes, with run-start drafts |
| Basis snapshot that refuses a rewrite if Jira moved | Stays |
| GitHub review built from structured findings | `draft(github_review)` needs the reviewer's `reviewed_sha` and the agent id. Each inline comment is checked against the diff at that SHA (`codehost/diff::commentable`). Comments that don't fit move into the summary. |
| GitHub review: comment review only, posted on approval, claim-before-post | Stays, including the one "Post again" choice for a review whose earlier post can't be found. The token pre-check store goes. |
| Risky-text pause (secrets, @everyone) | Stays, with one sentence instead of quoted lines |

The draft card becomes one component: the target, what will change, and four actions (Approve `a`, Edit `e`, Skip `s`, Ask Pip). The review card keeps its per-line comments on the diff.

## 7. The UI after

### 7.1 Screens

| Screen | Contents |
|---|---|
| Inbox | Mentions, comments, status and assignment changes on watched tickets: today's activity feed, trimmed to one list with one filter. This is daily Jira work, and the reason Gossamr started. |
| Board and List | The Jira (later Linear) work with one filter row. Drag a card to draft a transition. |
| Peek | The ticket, its comments and composer, its PR and check line, and **Ask Pip** (opens the Pip pane with the ticket attached). |
| Work | Workstreams, each with its agents inside it. An agent row shows state, role and last message, and opens its report body; Open in Terminal and Stop are on the row. One filter: **Needs you**. One status word per workstream: needs you, running, failed, done, idle. |
| Pip pane (`⌘J`, everywhere) | The conversation, General or the open workstream, with draft cards inline and a strip of this workstream's agents. |
| Settings | Connections (Jira, GitHub); watched projects and repos; agents at once; Terminal app; notifications on or off; theme. |

**Needs you** is exactly this set:

- an agent that needs you (question, permission prompt or sign-in);
- a failed agent;
- a pending draft;
- a "Pip asks you" question from `ask_person`;
- a paused workstream.

Notifications fire on new items in that set, and on nothing else.

### 7.2 What goes from the UI

- **Screens and views:** the classic inbox and its store; Map and Age (Decision 5); Start my day and Plan my week; "What Jira saw from me" (Pip answers from the audit); the in-app PR diff viewer (open the PR in GitHub; review drafts keep their own diff hunks).
- **Start paths:** the run setup sheet, inline start, the six-kind ticket menu, palette agent verbs and step modes, composer slash verbs, preflight and the prompt editor.
- **Autonomy controls:** Advise/Manage, Hold all, Automatic steps; budgets, and the tripwire and escalation cards.
- **Ticket heuristics:** readiness and clarity checks with their learning table; reporter-wait tracking; cobwebs.
- **Teaching:** nudge bubbles and canned chips; the 22-term glossary and three one-time explainers.
- **Layout options:** the Agents on/off switch; agents view and grouping options; column reordering; tab windowing; watch modes, depth and grace period.

### 7.3 Settings after

| Setting | Why it stays |
|---|---|
| Jira and GitHub connections | Required |
| Watched projects and repos (a list: add, remove) | Decides what syncs and what Pip can read |
| Agents at once (default 3) | Protects the machine and the subscription |
| Terminal app (Terminal or iTerm) | Open in Terminal is how permission prompts and trust are answered |
| Notifications on or off | People need to silence them |
| Theme | Cheap and expected |

These go:

- wall-clock and token limits;
- draft-on-finish and report-result;
- the notification digest mode and its interval;
- the six auto-start switches and Pip turns per day;
- start on Agents, agents view and grouping;
- Unclear tickets learning;
- the Autopilot placeholder and Interface (classic).

GitHub sign-in keeps one of its three routes: importing the `gh` CLI login, the shortest path for someone who already uses `gh`. Agents use `gh`'s own login, not Gossamr's. The Atlassian setup screen stays until Decision 7 is settled.

### 7.4 Copy

There is one line per empty state, with no explainers and no glossary. Two facts are stated once, in Settings:

- Gossamr posts nothing to Jira or GitHub until you approve it.
- Agents run with your own Claude Code settings, so they can push branches and use your own tools.

Pip explains anything else when asked.

## 8. Backend surface after

### Commands

About 35 commands, down from 142:

- auth and connections;
- cache reads, activity and sync;
- the watch list;
- drafts: list, edit, approve, skip;
- Pip: ask, cancel, turns;
- workstreams: list, read, close, reopen, resume, choose clone, clone;
- agents: list, read, stop, stop all, open in Terminal, clean up, archive;
- settings.

### Events

Four events, down from 11:

- `changed { topic }`, which replaces the seven events whose payload is only a connection id;
- the streamed `pip` event;
- `snapshot`, which drives the Dock badge;
- `open-run`, which focuses the window when a notification is clicked.

### Data

- **`runs`.** Today `runs.proposal_id` is `NOT NULL` with a unique index, and that index is the at-most-once launch guard (`db/schema.rs:189-205`).
  - One migration rebuilds the table with a nullable `proposal_id` and a unique `start_key`.
  - It moves `kind` to `role`.
  - It rewrites the `data` JSON to drop removed fields: digest, read_only, permission_allowed, auto_start, slot_wait_since, waited_secs, earlier_sessions, possible_continuations, passes, unsent_answer, suggested_reply, stopped_by_limit and the provenance pairs.
- **Removed enum variants.**
  - Stored drafts with removed intents are retired.
  - The old `RunKind` values are kept as serde aliases that map to role labels, so existing rows still read.
- **`workstreams`.** The mode, rules, budget and spend columns go. One `paused_reason` stays.
- **`run_reports`.** Stays as its own table and gains `reviewed_sha`.
- **Migrations.** The 13 steps stay as a list, and new steps are appended.

### Abstractions removed

- the `AgentProvider` trait, `AgentCaps` and the 2,262-line conformance suite (only one provider exists);
- the unused `AuthMethod` variants;
- the `SupervisorCore` traits;
- the unused `WorkTracker` and `CodeHost` methods behind `#![allow(dead_code)]`.

### Kept, and made honest for Linear

- **The `WorkTracker` trait** stays. The Jira-shaped pieces (`Scope { cloud_id }`, `Connection::jira()`, and the `CachedTicket` dispatch with its `unreachable!` arms) move into the Jira adapter. Gossamr-internal intents come out of the tracker's write type.
- **Per-account databases** stay one file per signed-in account. "Pip sees every workstream" means every workstream in the signed-in accounts. A Linear connection adds its own database, and Pip reads across them.

## 9. What goes, by area

These figures come from `wc -l` and the slice reports, and include tests. The "After" column and the last row are judgement, not measurement.

| Area | Lines today | After | Main cuts |
|---|---|---|---|
| Classic inbox | 2,300 | 0 | the whole UI (`legacy.rs` stays until old installs have moved) |
| Supervisor, auto-start, workstream governance | 8,600 | ~1,800 | modes, rules, budgets, holds, tripwires, readiness, reporter wait; wake ledger and pause kept |
| Run launch gates and policy | 7,000 | ~2,200 | read-only regime, permission classifier, preflight, limits, continuation heuristics; trust detection, clone finding and Clone it kept |
| Run results and resume paths | 5,500 | ~2,500 | heading parser and four resume paths become one `message_agent`; server merge with a stable port; `ask` |
| Conformance suite and provider trait | 2,300 | ~150 | one smoke test against the fake `claude` |
| Run and agent UI | 10,000 | ~2,800 | setup sheet, inline start, menus, step rail, permission UI, explainers |
| Heuristic UI (day and week, clarity, nudges, chips, cobwebs, glossary) | 4,800 | 0 | all |
| Extra views (Map, Age, PR viewer, Jira-sent, activity) | 3,100 | ~900 | Inbox list kept from activity |
| Drafts (Rust and UI) | 9,000 | ~4,800 | intent kinds, supersession, auto-drafts, plan and triage sections |
| Mock backend and its tests | 18,000 | ~4,000 | policy mirrors go; a thin scripted sample stays |
| Parity fixtures (`src/lib`, `src/backend`, `test-support`) | 10,100 | ~1,500 | filter and diff fixtures kept |
| E2E | 11,700 | ~4,000 | round-named specs replaced by about 10 feature suites |
| Everything else (Jira, GitHub, cache, sync, shell, Pip core) | ~115,000 | ~95,000 | dead trait methods, copy, watch modes, events, command merge (judgement) |
| **Total** | **~207,000** | **~120,000** | **about 40%** |

## 10. What we give up, honestly

1. **The draft gate covers only Gossamr's own writes.** Agents now run with the person's own tools. A builder pushes branches and opens PRs with `git` and `gh`. An agent with the person's Atlassian or GitHub MCP servers could write to Jira or GitHub directly. Each agent's brief tells it to report to Gossamr instead of writing to the tracker, but that is a request, not a lock. Decision 2 sets whether agents get the person's MCP servers at all.

2. **Agents are no longer read-only by enforcement.** A planner or reviewer could write if its brief, or an injected ticket, told it to. Today `dontAsk` and empty setting sources block that. What limits the damage:
   - ticket text stays fenced as data;
   - every agent works in its own worktree;
   - Pip's own instructions describe a reviewer as one that changes nothing, which reaches the agent only when Pip repeats it in the brief.

3. **Push and PR rules become requests.** Today, in a mode that asks, Gossamr's classifier refuses these:
   - a push to anything but the agent's own branch;
   - a non-draft PR;
   - `gh pr merge`.

   After this they are instructions in the brief. In a mode that asks, Claude Code's own prompt still catches them. In `bypassPermissions`, nothing does.

4. **Reviewing a PR runs that PR's Claude config.** An unrestricted reviewer that checks out a PR branch loads that branch's `.claude/settings.json` hooks and CLAUDE.md with the person's permissions. Gossamr refuses a fork's PR when Pip passes `pr`, and the base brief tells every agent never to check out a fork's branch, but neither is a lock. A teammate's branch is trusted as much as the person's own repo. Today the read-only regime's empty setting sources blunt this.

5. **Pip can start agents on its own judgement, including in a wake turn while the person is away.** A prompt-injected ticket could try to talk Pip into starting an agent with a hostile brief. What limits it:
   - Pip treats ticket and agent text as fenced data.
   - Pip tells the person about every agent it starts in a wake turn, and those starts show at once on the Work screen with Stop.
   - The ceilings pause a runaway workstream.
   - Pip itself has no file, shell or network access.

   None of this is a lock.

6. **Agent tokens are not a boundary between local processes.** Agents run as the same macOS user. A hostile agent can read other agents' token files and the account database, and can lift Pip's per-turn token from `ps eww`. With Pip's token it could call `start_agent` or `draft` while that turn lasts. What still holds:
   - A draft still needs the person's key.
   - Pip's tokens are revoked when each turn ends.
   - Gossamr treats its database as readable by any agent.
   - Accepted: the server reuses its last loopback port so running sessions survive a restart. A process of another user that holds that port while Gossamr is down, or after it moved, would see those sessions' tokens and could answer their `ask` calls.

7. **Chains are judgement, not rules.** The fixed Investigate → Triage → Plan → Build → Review table always fired the same way. Pip may skip or reorder steps. That is the point, but a weak Pip turn can stall a workstream. The wake on every state change, and the "Pip asks you" need, are the safety net.

8. **Cost is bounded loosely.** Wakes and Pip turns are capped by the hidden ceilings. A single long agent is not: it runs until it finishes, the person stops it, or Claude's own limits stop it.

9. **Permission prompts still need Terminal.** Nothing in the current Claude Code CLI lets Gossamr answer a prompt in place.

## 11. What we keep on purpose

- **The draft gate.** Every write Gossamr makes to Jira or GitHub is a draft the person approves, applied through one executor. Rewrites keep the basis check, and reviews keep claim-before-post.
- **Secrets.** Secrets live only in the Keychain, in one item read once.
- **The MCP server.** It is loopback only, with per-session tokens, constant-time compare, and Host and Origin checks. It binds a stable port, stores agent tokens as hashes, and revokes them by state.
- **Untrusted text.** Tickets, PR comments and agent output are fenced as data and sanitised before they are stored, shown or handed to a model: control, bidi and markup characters are stripped and secrets are redacted.
- **Pip's lockdown.** Pip has no built-in tools.
- **The wake ledger.** Each (agent, state) wakes Pip at most once, across restarts.
- **The launch guard.** At most one launch per start key.
- **Review checks.** The same-repo check before a PR is checked out, and the head SHA pinned at start.
- **Jira scope.** The scope check before every Jira request (`SiteChanged`), and the single refresh lock for rotating Atlassian tokens.
- **Trust.** Detection of an untrusted folder, answered in Claude's own prompt.
- **Cleanup and git.** `claude rm` is never forced. Gossamr's own git calls run with hooks off.
- **Recovery.** The stored run states that `recover()` uses after a restart.
- **The harness record.** The verified harness facts in `docs/agents-cli-findings.md`, and the captured CLI fixtures that pin them.

## 12. Order of work

Each step is one or a few PRs and leaves the app working.

| Step | What | Depends on |
|---|---|---|
| 0 | Spikes (Section 14) and owner decisions (Section 13) | none |
| 1 | Delete what nothing depends on: the classic inbox and the `ui` pref, the Agents on/off flag (always on), the Autopilot placeholder, the provider trait and conformance suite, the glossary and explainers, nudges and chips, cobwebs, and Start my day and Plan my week. | none |
| 2 | One mode: remove Advise/Manage, the Role split, auto-start rules, budgets, holds, tripwires, readiness, clarity and reporter wait. The supervisor becomes the waker; the wake ledger, the ceilings and `paused_reason` stay. | 1 |
| 3 | One MCP server: merge `run-report` into `gossamr` with a stable port, persisted agent tokens and the four agent tools. Add `--allowedTools` for them, and turn `report` on for every launch. | 0 |
| 4 | Pip drives agents: add `start_agent` (with the start key and the `runs` table rebuild), `message_agent`, `stop_agent` and `ask_person`. Remove StartRun, FollowUp and RunAnswer drafts, the setup sheet, inline start, the ticket menu, palette and composer verbs, digest approval and preflight. Ticket "Ask Pip" replaces them. | 2, 3 |
| 5 | Roles replace kinds: drop the six templates, the per-kind required fields, the read-only regime, the permission classifier and the limits; add the base brief with the checkout and PR steps. | 4 |
| 6 | Drafts: one card and eight kinds, one supersession rule. Pip drafts from reports. Remove `auto_draft_*`, the heading parser and the structured report fields that `inbox/review_drafts.rs` imports; GitHub review drafts take `reviewed_sha`. | 5 |
| 7 | UI and settings: the Inbox and Work screens, one status word, six settings, a copy pass, one keyboard table, four events, the command merge, and the screens settled by Decision 5. | 6 |
| 8 | Tests, mocks and docs: delete the parity fixtures and mock mirrors as their rules go; replace round-named e2e with feature suites; replace the two design docs with one short product doc. | runs alongside 1 to 7 |
| 9 | Linear: move the Jira-shaped auth and cache types into the Jira adapter, then add a Linear adapter. | 7 |

Between steps 2 and 4, no chain advances on its own. Pip drafts each next agent on the wake, and the person approves it as a StartRun draft, as in Advise mode today. That is acceptable for the length of two PRs.

## 13. Decisions for the owner

1. **Approval for Jira and GitHub writes.** Recommended: keep per-draft approval (one key). The alternative is that Pip applies a write after the person says yes in chat. That removes the card, but makes "yes" something a model interprets.
2. **Agents' MCP servers.**
   - **Recommended:** agents get the person's own MCP servers, as any Claude Code session does, and the brief routes Jira and GitHub updates through Gossamr. This is also how Pip reaches systems beyond Jira and GitHub (Slack, Confluence and others): it starts an agent that has those tools.
   - **Alternative:** launch agents with `--strict-mcp-config` and only `gossamr`. The draft gate then holds for everything except `git` and `gh`, but agents lose the person's other tools.
3. **Pip's own lockdown.** Recommended: keep it (no built-in tools, MCP only).
4. **Unrestricted agents.** Recommended: yes, accepting items 2 to 4 of Section 10. Never recommend `bypassPermissions`.
5. **Screens.** Recommended: Inbox, Board and List stay. Map, Age, Jira-sent and the PR viewer go.
6. **Pip's model.** Recommended: keep the explicit pin. Pip reads no user settings, so it cannot follow the person's default unless Gossamr reads that one value out of their settings and passes it as `--model`.
7. **Atlassian sign-in.** 3LO needs a client secret (`auth/atlassian.rs:1`), so a bundled client ships an extractable secret and needs one Atlassian app for everyone. Options:
   - keep the setup screen where each person pastes their own app's id and secret;
   - bundle a company app for internal builds only.

   Recommended: bundle for internal builds and keep the setup screen for everyone else.

## 14. Spikes before step 3

1. **MCP allow rule.** Does `--allowedTools mcp__gossamr__…` stop permission prompts for the four agent tools under each permission mode the person might use (default, `acceptEdits`, `auto`)?
2. **Resume keeps the config.** Does a flagless `--bg --resume` keep the `--mcp-config`, so a resumed agent can still report and ask?
3. **Reconnect after restart.** After the app restarts and the server comes back on the same port, does a running session reconnect to it, or does its next tool call fail? If it fails, does a resume restore it?
4. **Tool-call timeout.** How long will Claude Code wait on an MCP tool call before it gives up? This sets the `ask` timeout.
5. **Resume copies.** How often does a resume still start a copy with the 5 s settle and the id check on current Claude Code? If never, `runs/continuation.rs` can go without replacement.
