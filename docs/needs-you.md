# One "Needs you": spec (owner approved: "build all your recommendations")

## Problems this solves (from the surface map)
- The same need shows in up to 11 places and is counted by four different numbers: the tray, the Agents badge, the launcher, and Activity.
- Some needs are counted nowhere: stopped-at-limit, unknown, quiet and possible-continuation runs.
- `systemBlocked` (a sign-in) is labelled "needs permission".
- Opening Agents silently clears unseen failures.
- An escalation and its review draft count twice.
- Ten near-identical rows for one ticket bury the decision.
- The tray only navigates; decisions happen in six other places.

## Model: `src/lib/needs.ts` (pure, the only source)
`needs(input) -> Need[]` and `needGroups(needs) -> NeedGroup[]`. Input is proposals, runs, workstreams (with escalation and hold), and dismissed ids.

### A Need
- `{ key, group: 'decide'|'unblock'|'approve', kind, workstreamId|null, ticketKey?, title, why, ifYouWait, at, primary: ActionSpec, secondary: ActionSpec[], target, batchable }`
- **group** is what the person is being asked to do:
  - **decide**: escalation, plan or description approval.
  - **unblock**: permission, question, sign-in, failure, stopped at limit, quiet over 30 minutes, unknown, possible continuation, hold.
  - **approve**: a Jira draft, a GitHub review draft, a run start.
- **Rank**: decide, then unblock, then approve. Within a group, oldest first, then by key.
- **why**: one plain sentence saying why it is asked. Examples:
  - "R5 wants to run `git push origin ca-401`."
  - "The review still blocks after 2 fix rounds."
- **ifYouWait**: one plain sentence saying what happens meanwhile. Examples:
  - "The run stays paused; nothing else in CA-401 moves."
  - "Nothing is posted until you choose."
- **Folding**:
  - A runAnswer draft folds into its question (as today).
  - An escalation's review draft folds into the escalation, so it is not listed twice.
  - A retired or superseded draft never shows.
- **Failures** leave only when dealt with: Retry, a fix, or an explicit Dismiss. Viewing never clears them, so remove the `markSeen` effect on needs.
- `systemBlocked` reads "needs you to sign in to Claude".

### A NeedGroup
- One per workstream, plus General (null).
- `{ workstreamId, title, top: Need, rest: Need[], count, safeBatch: Need[] }`.
- `top` is the highest-ranked need.
- `safeBatch` holds the batchable pending drafts (comment, transition, subtasks), offered as "Approve N" with one combined preview.

### One count
- `needsCount = needs.length`. One number everywhere:
  - the rail badge (one badge, on Pip home; the Agents badge is removed)
  - the composer footer
  - the palette ("Show what needs me")
  - the launcher (no longer a separate pending-drafts count)
- Badge accessible text: "N things need you".

## UI: the Needs-you list (replaces the tray, the Agents "Needs you" lane and the separate badges)
- It lives where the tray is on Pip home, and also opens as the rail popover.
- **Rows**: one per NeedGroup. Each row shows:
  - the ticket key and title
  - a group chip (Decide / Unblock / Approve)
  - `top.why`
  - an age
  - "+N more" when there is more than one need
- **Expanding** a row (Enter or →) lists every need in the group, plus "Approve N safe drafts" when `safeBatch` has 2 or more.
- **Decision pane**: selecting a need opens its decision inline in Pip home's middle column, reusing the existing components:
  - PermissionAsk
  - RunAnswer (question, limit-resume)
  - FailureNext
  - the sign-in box
  - DraftCardBody / ReviewDraft
  - EscalationCardView
  - the held banner Resume
  - PlanApproval
  - InlineStart (run start)
- **Pane header**: `why` + `ifYouWait`, with a link "Open in workstream".
- **After a decision**: focus moves to the next need in rank order. When none are left: "Nothing needs you."
- **Agents screen**: drops the "Needs you" lane. Runs that need the person show a pill "In Needs you", and pressing it opens that need.
- **Other surfaces** keep showing their context (draft cards in the conversation, the step rail, the peek) but no longer count. Only the list counts.

## Keyboard (one model, app-wide since step 4)
The same keys mean the same thing in every list that holds actionable items (the Needs you list, draft cards in the conversation and the step rail, Activity's Drafts, the ticket peek's drafts, the Agents list); a place that can't do what a key says ignores it. The table is `src/workspace/keyMap.ts`.
- j/k (or the arrows): move.
- Enter or o: open. On a Needs you row also → (expand) and ← (collapse).
- a: approve or allow (the primary), confirmed with Enter, since it posts, writes or reaches an agent.
- e: edit.
- d: dismiss (a failure, a draft) or deny (a permission, which reaches the agent, so it keeps its Enter).
- s: skip a draft. d and s on a draft, and d on a failure, act at once and offer Undo.
- Esc: back.

## Undo (step 4)
Reversible actions act at once and offer Undo in a toast for about 8 seconds (`src/workspace/undo.ts`): skipping a draft, dismissing a failed or stuck run, holding a workstream, switching it to Advise. Undo restores the exact previous state; when the action wrote an audit line the undo writes its own (`undone`). The backend allows an undo for 60 seconds, only while that change is the last line of the workstream's audit, so a stale toast can't undo over later changes. Anything that reached Jira, GitHub or an agent (post, approve, apply, Deny, Allow, Stop, Resume, start) keeps its confirm.

## One timeline per workstream (step 3)
A workstream's story used to be spread over the conversation, the run strip, the step rail, draft cards, the audit and the Agents screen. It is now one chronological list in Pip home's middle column.

### Model: `src/lib/timeline.ts` (pure)
`timeline(input) -> TimelineEntry[]`, oldest first. Input is the conversation's turns, the runs, the drafts, the workstream's audit (`workstreams_events`), Needs you, run labels and review verdicts. It reads what the stores already hold; there is no Rust change.
- **An entry** is `{ key, kind, at, updatedAt, ticketKey, text, target, needKey, decision }`.
  - `kind` is `said` (the person's question), `pip` (a turn Pip took by itself), `run`, `draft` or `audit`.
  - `key` is stable: `turn:<request id>`, `run:<id>`, `draft:<id>`, `audit:<workstream id>:<seq>`.
  - `text` is one plain sentence: "Build R2 finished", "Review R3 finished: changes needed", "Plan R1 is waiting on you: it asks a question", "Pip drafted a comment on CA-401: posted", "You held the workstream".
  - `target` is what opening it shows: a run id (its sheet), a draft id (its card), or a need key. An entry about something in Needs you always targets its need.
- **A run is one entry**, updated in place: it stands where the audit says it was approved or started by a rule (else when it was queued), and its `phase` (queued, started, waiting, finished, failed, stopped, stopped at limit, unknown) and `lifecycle` change as it moves. A finished review says its verdict.
- **A draft is one entry**, at when it was made, saying who made what and how it stands (waiting, posting, posted, sent, started, skipped, replaced, no longer needed).
- **Audit lines** are worded as Activity words them. The lines a run's or a draft's own entry already tells are left out (`run_approved`, `autostart`, `wake`, `draft_created`, `draft_retired`, `notes_set`). The same line repeated in a row collapses into one ("… (3 times)").
- **Linking to Needs you**: a waiting run, a waiting draft, the hold that still holds and the open escalation carry the need's key.
- **Ordering**: by time; a tie goes to what was said, then the audit, then runs, then drafts. Turns now carry `at` (the stored turn's `createdAt`, or when it was asked).
- **Filters**: All, Runs (`kind` run), Drafts (`kind` draft), Decisions (what the person did, what asks them to decide, and whatever waits in Needs you).

### UI
- **Pip home's middle column** is the timeline (`src/workspace/Timeline.tsx`), under the filter bar with a count per filter.
  - Turns render with `TurnView`.
  - Runs render with the Agents screen's `AgentRow`, under their sentence.
  - Drafts waiting, drafts Pip made in this conversation, and drafts retired while shown render with `LiveDraftPreview`. Other decided drafts are one line that opens the draft.
  - Audit lines are one line each.
  - Lines for things in Needs you have an "In Needs you" pill and open their need with the same `openNeed`.
  - The composer, the Next line, the decision pane and the Needs you list are unchanged. General's timeline holds the runs and drafts in no workstream, plus every draft still waiting, as its old "Drafts waiting" did.
  - **The Pip pane** (outside Pip home) shows the same `TimelineView` for the pane's workstream (`pane`), under its header (Manage switch, Hold, what Pip sees) and over its composer, which are unchanged.
    - Its filter is its own (a group named "Filter", not "Timeline filter"), so filtering the pane leaves Pip home's filter as it was. It has no scope toggle: the pane is one workstream. Its Runs filter links to Agents.
    - Runs render with the pane's narrow `PipRunCard` (with its Open button), not the Agents row, so the Agents screen's row and its `agent-<id>` id stay the only ones on screen when both show. Enter on the card opens the entry (`timelineKeyAction(…, runOpensItself = false)`).
    - General's conversation in the pane is unchanged: it follows the screen, lists the runs going ("Your agents", "See all in Agents") and the drafts waiting with the ticket on screen first and the rest folded. On Pip home General is a timeline as before.
- **Scope: This workstream / Every workstream.** Beside the filter, a toggle (group "Timeline scope") says whose timeline it is. It applies to every filter and lives in `pipHomeStore` (`timelineScope`) beside `timelineFilter`.
  - **Every workstream** is every open workstream's timeline plus General's, merged by time (`timelineAcross(everyWorkstreamParts(…))` in `src/lib/timeline.ts`, pure). Each part is the same `timeline()` its own workstream shows (its turns, its runs, the drafts its conversation shows, its audit), then General's. Something two parts both show (a draft waiting on a workstream's ticket, which General lists too) is one entry, in the workstream's part. Ties keep the order by kind, then the parts' order.
  - Each entry carries a small label (`data-timeline-workstream`): its ticket key, the workstream's title without one, or "General". Its accessible name starts with it.
  - While Every workstream is shown, every open workstream's conversation and audit are loaded. The composer stays the selected workstream's; the workstream intro shows only in This workstream.
  - **Runs + Every workstream is the Agents screen** (`isAgentsView`, `showTimeline` in `TimelineFilterBar.tsx`): choosing Runs in Every workstream, or Every workstream with Runs, goes to Agents. The Agents screen has the same filter bar with Runs pressed and the scope toggle on Every workstream; choosing All, Drafts or Decisions goes to Pip home's timeline in Every workstream, and This workstream goes to Pip home's Runs for the selected workstream. Pip home keeps the scope it was last shown with. The rail's Agents button still lands on the Agents screen. Its selection, keys (`agentKeys.ts`), settings, banners, lanes and layouts are unchanged.
  - Asking Pip home to show a card (`focus`) sets the filter back to All and the scope back to This workstream.
- **⌘K**: "Timeline: All", "Timeline: Runs", "Timeline: Drafts", "Timeline: Decisions", "Timeline: This workstream" and "Timeline: Every workstream" (`timelineCommands` in `commands.ts`, in the Workstreams group, while Agents are on). A filter keeps the scope and a scope keeps the filter, as the buttons do; from anywhere but Pip home or Agents they go to Pip home. The filter and scope on screen are marked current, and Runs in every workstream is marked "Agents".
- **Keyboard** (`src/workspace/timelineKeys.ts`, the `keyMap.ts` model):
  - j/k (or the arrows) move from entry to entry. An entry's stop is its draft card, its run row, or the entry itself.
  - Enter or o opens the target. A draft card keeps its own keys (a, e, d, s, Enter, o), and a run row opens on Enter.
  - ArrowUp from the empty composer reaches the newest draft waiting, else the newest entry.
  - The footer says "j k move through the timeline · ↵ o open what it is about" while the keyboard is on an entry.
  - Asking Pip home to show a card (`focus`) sets the filter back to All (and the scope to This workstream).

## Later steps (separate PRs)
- **2.** Workstream header shows "Next: …" and "N of M automatic steps left". (The budget PR adds the numbers.)
- **3.** Done: one timeline per workstream, with Agents as its Runs filter, a This workstream / Every workstream scope, the timeline in the Pip pane, and ⌘K commands for the filter and scope (see above).
- **4.** Done: undo for reversible actions, one key model app-wide, and every action in ⌘K (see above).
- **5.** Notifications per workstream state change ("CA-401 is waiting on you"), not per event, with an optional digest setting.
