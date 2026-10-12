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
  - **decide**: escalation, plan or description approval, a workstream that used its automatic steps (`budget`), a ticket the triage found not clear enough to plan (`readiness`).
  - **unblock**: permission, question, sign-in, failure, stopped at limit, quiet over 30 minutes, unknown, possible continuation, a hold the system made (restart, a tripwire, the daily cap, the quota).
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

### Holds: only the system's are needs
A hold's cause is its reason (`heldReason`; the audit's `held` line carries the same reason and its actor). `person` (Hold, Stop) and `hold_all` (Hold all) are the person's own, and the audit says actor `person` for them.
- **A hold the person chose is not a need.** It creates no need, is in no count (the rail badge, the composer footer, the palette, the launcher, Activity) and has no row. The workstream's header shows its banner, "Held by you" (or "Held by you (Hold all)"), with a line saying so ("You chose this, so it is not in Needs you…") and a Resume button. `isHeldByYou` in `src/lib/workstreamHold.ts` is the one test. Undo of a hold is unchanged (it reads the audit, not the need).
- **A hold the system makes stays a need** (`hold`, Unblock, primary Resume): a restart, the ticket changed under the run (basis drift), the other tripwires (a marker, a repeated failure, a refused chain step), the daily cap and the quota.
- **Budget is the exception**: it is a Decide need of its own (below), not a plain hold.

### One budget unit, and running out is a question
- The page counts one unit, **automatic steps**: "N of M automatic steps left", "N of M automatic steps used", "Held: automatic steps used up". It never says "turns" or "wakes". Behind it the backend still keeps two counters (`autoTurns` and `wakes`, one of each per Pip turn the supervisor starts); `stepsOf` in `src/lib/workstreamHold.ts` picks the one nearer its limit, so the page's number is always the one that will stop the workstream first.
- **Automatic fix rounds cost no step**, in Rust (`wake_for` in `src-tauri/src/agent/supervisor.rs`) and in the mock (`MockSupervisor.handle`): a wake whose facts are all the review that sent a round (`fix_round` note) or the build that went back for one (`fix_round_builds`) is not charged, never holds the workstream for its budget, and still tells Pip. Rounds are capped at 2 per review. A whole chain (investigate, triage, plan, build, review, verify) is 6 steps whatever the rounds, against the default of 11.
- **When a workstream used its allowance it is held for its budget, and Needs you gets a Decide need** (kind `budget`, key `budget:<workstream id>`):
  - title "CA-401 used its 11 automatic steps" (the ticket, or "This workstream" without one),
  - why "Pip and the automatic steps are paused until you decide.",
  - choices **Allow 5 more** (primary) and **Switch to Advise** (secondary).
- **Allow 5 more** is `workstreams_allow_more` (Rust, `Core::allow_more_steps`; `workstreamsAllowMore` in the backend interface and the mock). It raises both allowances by 5 (`ALLOW_MORE_STEPS`), keeps what was spent, lifts the hold, and writes `steps_allowed` (detail "5") and `resumed`, both with actor `person`. It is refused unless the workstream is held for its budget, so a stale button changes nothing. It reaches nothing outside Gossamr, but it starts agent work again, so on the keyboard it asks for Enter. Pip has no tool for it.
- **Switch to Advise** is the existing mode switch (with its Undo). In Advise nothing starts on its own, so the need is answered and goes; the hold stays, and the header's Resume lifts it (which starts the count again).
- **Resume** on a budget hold still works and starts the count from zero (`budget_reset`).
- **The Next line** for such a workstream points at the need ("Next: the automatic steps are used up. Choose in Needs you: allow 5 more, or switch to Advise.") and opens it. Any other hold keeps "held: … Resume to continue."

### Unclear tickets: Pip speaks up, and the Triage is a hard stop
The owner's tickets are often not well defined, and Gossamr exists to make them look at the ticket and at what goes to Jira, because other people depend on it. So Pip says when a ticket is unclear, twice: at intake, where it only speaks, and after the Triage, where nothing starts until the person chooses.

**Readiness list.** Four things a ticket needs: the goal; how anyone will know it is done (acceptance criteria); what is in and out of scope; who asked for it and who is waiting on it.

**(a) At intake.** Pip's first turn in a workstream (its block shows stage Intake, no runs, and "Pip's notes: none yet") starts by reading the ticket against the list. If anything is missing it says so plainly in its first line, naming the ticket and the gap: "CA-401 doesn't say what done looks like." It carries on with what it was asked, never fills a gap with a guess, and says nothing when the ticket has it all. This is the Manager prompt (`MANAGER` in `src-tauri/src/agent/context.rs`), so the real Pip does it; the sample's scripted Pip does it for one deliberately vague ticket, CA-408 ("Make the winback flow better."), which it recognises by a description of one short line (`src/backend/mockReadiness.ts`; the sample can't judge, so a ticket with no description or a real one is left alone).

**(b) At Triage, a hard stop.**
- **The verdict.** The Triage instruction (`TRIAGE_INSTRUCTION`) asks for `Ready to plan: yes` or `Ready to plan: no` on a line of its own, and with a no an `Open questions:` list, one line per question. It is parsed from the run's whole written answer as `Plan recommended:` is (`readiness` in `src-tauri/src/runs/result.rs`, `readiness` in `src/backend/mockSupervisor.ts`; both run `readiness` in `src/backend/supervisor.fixtures.json`): case-insensitive, through headings, bullets and emphasis, never from a code fence or a `>` quote, and two lines that disagree count as none. The questions are the agent's words: cleaned, one line each, at most 8, each at most 300 characters. **No verdict reads as ready**, so a Triage from before this changes nothing. A report made through the report tool leaves the written line in use; the tool has no flag for it.
- **The rule.** In Manage the Triage-to-Plan rule starts the Plan only when the Triage recommends one **and** is not `Ready to plan: no` (`decide` in `src-tauri/src/agent/autostart.rs`, `decideAutostart` in `src/backend/mockSupervisor.ts`; the autostart fixtures cover both). Pip is told in the wake's event line ("not ready to plan, 3 open questions") and in its workstream block (the count, never the questions' words) that the person decides, and has no tool for any choice.
- **The need.** The workstream's view carries `readiness` (`ReadinessStop`: the Triage's run and label, its questions, when it finished) while its newest Triage on a ticket is done, not ready, in Manage, with no choice made and no Plan started since (`readiness_of` in `src-tauri/src/inbox/workstreams.rs`, `readinessOf` in the mock). Needs you turns it into a Decide need (kind `readiness`, key `readiness:<triage run>`): title "CA-401 isn't clear enough to plan", why "R2 left these questions open: … · …", `ifYouWait` "No plan starts until you choose; nothing is posted to Jira.". A hold does not hide it (the person may still choose); Advise does, since nothing starts on its own there.
- **Three choices**, each the person's alone (Pip has no tool for any), each a command that is refused with "This ticket isn't waiting for your choice…" unless the stop is still about that Triage:
  1. **Ask the reporter** (`workstreams_readiness_ask`, `Core::ask_reporter`). Only Pip proposes drafts through its tools, so Core drafts the comment itself, deterministically, from the parsed questions in a fixed frame ("Hi @Reporter, Before CA-401 can be planned we need a few things cleared up: - … Could you answer them here on the ticket? Thanks."; the four readiness questions when the Triage listed none; the reporter is mentioned when the cache knows them). It is an ordinary pending Jira comment draft made by Gossamr from that Triage run (provenance: a run draft, `created_by` agent, label "Questions for the reporter", in the workstream), so it goes through the normal approval and nothing posts without it. It never replaces, and is never replaced by, a run's own comment draft. Records `readiness_asked` (the person's, naming the Triage and the draft).
  2. **I'll answer** (`workstreams_readiness_answer`). Records `readiness_answered` and opens the workstream's conversation with the questions quoted on one line in the composer ("R2's open questions about CA-401: “…” · “…”. My answers: "). It starts nothing.
  3. **Plan anyway** (`workstreams_readiness_override`). Records `readiness_overridden` (the person's, naming the Triage) and tells the supervisor to look again. The Plan then starts as the rule would have, with the rule's own audit line (`autostart`, `triage_plan after <run>`): the override is read only from the person's own line (`autostart::readiness_overridden`: a line by Pip, the supervisor or a run counts for nothing), starts the Plan even when the Triage recommended none or the rule is switched off (they chose it), and still needs everything else: Manage, not held (the override waits on record for Resume), within budget, and no run a tripwire named.
- **Resolved** by any of the three, by a later Triage that says ready (or says nothing: no verdict reads as ready), by a Plan started since, and when the workstream leaves Manage.
- **Next line.** "Next: waiting on you. …" with the need's reason, as for any Decide need; while a Triage runs it says a plan starts automatically "only if it recommends one and finds the ticket ready to plan".
- **Timeline and Activity.** The three audit lines read "You asked the reporter about R2's open questions", "You chose to answer R2's open questions" and "You chose to plan anyway after R2 found the ticket not ready" (`eventText` in `src/workspace/activityLogic.ts`, which is what puts a line in the timeline), and the person's count as decisions (`DECIDED` in `src/lib/timeline.ts`). A Triage waiting on this says "Triage R2 finished: the ticket isn't clear enough to plan" and opens the need.

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
- a: approve or allow (the primary; on a used-up budget, "Allow 5 more"), confirmed with Enter, since it posts, writes or reaches an agent.
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
- **Linking to Needs you**: a waiting run, a waiting draft, the hold the system made that still holds (and a used-up budget's question), and the open escalation carry the need's key. A hold the person chose has no need, so its line opens nothing.
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

## Workstream cobwebs: work is happening but Jira hasn't heard
A ticket row withers when the ticket itself is untouched (`witherLevel`, `WITHER_DAYS`, the `Cobweb` component and the spider CSS). A workstream can be busy while its ticket is quiet: agents run and Pip takes turns, and nothing reaches Jira or GitHub, which is what other people read. So each workstream's row on Pip home gets the same cobweb, on a different clock.
- **The clock** (`workstreamWither` in `src/lib/workstreamWither.ts`, pure and unit-tested): the days since the person's last post to Jira or GitHub for that workstream, else since it opened. A post is the person's audit line for an approved (applied) comment, description, transition or subtask draft (and the other Jira writes: a new ticket, a change, a link), or a posted review (`review_posted`, `escalation_posted`). A draft that starts an agent, sends one back or answers one, a skipped or unknown draft, and any line by Pip, the supervisor or a run are no post. The draft's kind is read from the draft the line names.
- **The stages** are `WITHER_DAYS.ticket` (2, 3, 5, 7, 10 days): the first dries the row out, the second draws the web, each after it adds a spider.
- **The condition that matters:** it counts only while the agents or Pip were at work since that post (a run started or finished, a Pip turn: the conversation's turns, else the audit's `wake` lines). With no activity since there is no cobweb: the ticket's own cobweb in the ticket list covers a ticket nobody touches.
- **Words:** the row's `title` and a screen-reader line inside it (`data-workstream-wither`) say "No Jira update for 5 days (3 runs since)" (runs and Pip turns: "(3 runs and 2 Pip turns since)"). The drawing is `aria-hidden`.
- **Never a need, never counted.** It is a look, not a duty: it adds nothing to Needs you or to any count, and hovering or selecting the row sweeps the web away as it does on a card.
- **Where.** Pip home's workstream list is the only list whose rows are workstreams (`WorkstreamList`, fed by `useWorkstreamWithers`, which reads every open workstream's audit and conversation while the list shows, and the audits again when a draft is applied). The Agents screen's group headings, Needs you's groups, ⌘K and Activity are not rows of workstreams and have none.
- **In the sample.** Its clock is the browser's, which a test can't move, so `__gossamrMock.seedWorkstreamEvent(key, {actor, action, at})` adds an audit line as of a time and `__gossamrMock.backdateWorkstream(key, days)` makes a workstream older.

## Later steps (separate PRs)
- **2.** Workstream header shows "Next: …" and "N of M automatic steps left". (The budget PR adds the numbers.)
- **3.** Done: one timeline per workstream, with Agents as its Runs filter, a This workstream / Every workstream scope, the timeline in the Pip pane, and ⌘K commands for the filter and scope (see above).
- **4.** Done: undo for reversible actions, one key model app-wide, and every action in ⌘K (see above).
- **5.** Notifications per workstream state change ("CA-401 is waiting on you"), not per event, with an optional digest setting.
