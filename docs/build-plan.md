# Gossamr build plan

Source of truth for design: `docs/design-connectors.html`. Visual target: `prototype/claude-companion.html`.

## How each step is built

One sub-agent per step (Sonnet 5.5, medium effort), each in its own git worktree and branch, one PR per step.

1. I write the brief: goal, "done when", files likely touched, what not to touch, the design doc sections to read.
2. The agent implements, runs `pnpm typecheck`, `pnpm test`, `pnpm build`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, and opens the PR.
3. CI and CodeRabbit run. Findings are fixed on the same branch (by the agent, or by me via Auto-fix), replied to, and resolved.
4. I review the diff against "done when", report to you, and merge only on your go-ahead.
5. The next step branches from updated main. Steps that don't depend on each other run in parallel.

Rules for every agent: no Hobbii references, bundle id stays `dk.alfhen.gossamr`, comments sparingly, small PRs (split a step if it grows past roughly 800 changed lines), no visible regression in the running app unless the step says so.

## Steps

| # | Step | Depends on | Done when |
|---|------|-----------|-----------|
| 0a | Domain model: neutral types (ItemRef, Workflow, WorkItem, Comment, Event, Proposal, Filter AST) in a `domain` module, with tests | none | Types compile and are covered; nothing uses them yet |
| 0b | Jira behind `WorkTracker`: adapter translates Jira to domain types (ADF, JQL, transition ids stay inside) | 0a | Core holds a connection registry; no UI-facing code imports `jira` |
| 0c | `Authenticator` trait; Atlassian OAuth and token sign-in behind it; `Scope` becomes `Connection` | 0b | Existing sign-in works unchanged; existing tests pass |
| 1a | SQLite schema keyed by (connection_id, external_id); cache read path; sync scheduler with ETags | 0b | UI reads from the cache; offline start shows last data |
| 1b | Persisted proposals + single `apply(&Intent)` executor behind approval; `reconcile` as a pure function | 0a | Drafts survive restart; approve goes through `apply` only |
| 1c | `AgentProvider` trait, Claude Code as first adapter; neutral MCP tools incl. `list_proposals`; fresh sessions with screen context | 1b | Pip can list and revise its own drafts; conformance tests exist |
| 2a | Frontend store on normalised entities + mock connector + filter engine | 1a | App runs fully on the mock with no network |
| 2b | Workspace shell: rail, tabs, project switching, ⌘K, ⌘J, theme (Dew & ink) | 2a | Navigation matches the prototype |
| 2c | Board (per-project workflows, drag to draft), list, age view with wither and spiders | 2b | Boards adapt per workflow; drops become drafts |
| 2d | Map view | 2b | Pan/zoom map works on the mock |
| 2e | Peek sheet, Pip pane (docked), draft cards that jump to context, nudge bubble, Claude-driven filters | 2b, 1c | Draft on a hidden ticket is visible and clickable |
| 2f | Real Jira connector wired into the new UI; old screens removed | 2c, 2e | Daily use works on real data; old inbox UI deleted |
| 3a | GitHub connector: device-flow sign-in, `CodeHost` | 0c | Real PR listed |
| 3b | Link discovery (PR title/branch to ticket), identity mapping, `EventSource`, Activity screen incl. Drafts filter | 3a, 2f | A real PR shows on its ticket and produces events |
| 4a | Autopilot rules engine + settings (opt-in, per project, per behaviour, assignment-scope rule) | 1b, 3b | Each rule has unit tests; off means zero proposals |
| 4b | Reconcile on every sync; bulk actions | 4a | Drafts stay current; bulk limited to transitions |
| 5 | Second tracker (Linear or GitHub Issues); write down every core gap | 2f | Gap list short; no connector branches in UI |
| 6 | Second provider (Codex CLI or API) + conformance suite + per-task setting | 1c | Suite passes for both |
| R | Release: Developer ID, notarisation, GitHub Actions, company Atlassian app | 2f | Signed installer builds in CI |

Parallel waves: (0a) then (0b, 1b) then (0c, 1a, 1c) then (2a) then (2b) then (2c, 2d, 2e) then (2f) then (3a, 3b) then (4a, 4b). Phase 2 is a usable product on its own, so 5, 6 and R are optional after it.

## Prerequisite

`docs/design-connectors.html` and this file are untracked, so agents in worktrees can't see them. Commit both to a `docs/design` PR first (step D), merge, and branch from there.
