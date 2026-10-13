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
- **Resume** on a budget hold still works in the backend, and keeps what was spent (no reset, no `budget_reset`): it grants nothing. The header's held banner and ⌘K offer it for a budget hold only in Advise (where nothing starts on its own anyway); in Manage the banner has Allow 5 more and Switch to Advise, as the decision has, and ⌘K lists no Resume.
- **Allow 5 more is the only way to grant steps, so Manage can't be a way round it.** Changing a workstream to Manage while it is not held and its automatic steps are used up (`budget_level` spent) holds it for its budget again, with a supervisor `held` line (detail `budget`) after the `mode_set`, and the Decide need above appears again. So Switch to Advise, Resume, then Manage asks the question again with the count unchanged. The same holds when Resume puts back the Manage a tripwire took away (`rehold_spent` in `src-tauri/src/inbox/workstreams.rs`, `reheldForBudget` in the mock). `budget_reset` is now written only when the person writes in the conversation (their message counts the automatic turns from zero, with detail `message`); old audits keep it, and its wording stays.
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

### After Pip speaks up: the follow-through
- **A word check when the workstream opens (a notice, not a need).** A free, deterministic check of the ticket's description (`clarity_gaps` in `src-tauri/src/domain/clarity.rs`, `clarityGaps` in `src/lib/ticketClarity.ts`, both run `ticketClarity.fixtures.json`) looks for what done looks like (acceptance, criteria, done when, should, must, a checklist), what is in or out of scope and who is waiting, and for an empty or very short description. No agent runs and no automatic step is used. When it finds gaps the workstream shows "CA-408 may be unclear: it …" with **Ask the reporter now** (the same "Questions for the reporter" comment, one question per gap, for approval; `workstreams_clarity_ask`) and **Looks fine** (dismissed for the ticket, audited as `clarity_dismissed`; `workstreams_clarity_dismiss`). It counts nowhere and blocks nothing; it goes once a Triage ran, since the Triage's verdict stays the authority. Pip's block and first turn name the same gaps.
- **Waiting on the reporter** is read from the audit (`reporter_follow` / `reporterFollow`): it starts when the comment of a `readiness_asked` or `clarity_asked` is approved, and ends at the first of the ticket changing (`basis_drifted`), the person choosing I'll answer or Plan anyway, or resuming. The row says "Waiting on the reporter", the Next line "Waiting on the reporter since <time>; nothing starts on its own.", the Triage-to-Plan rule stays off, and after `WITHER_DAYS.ticket` days the cobweb says "Reporter hasn't answered for N days". It is not a need. When the ticket changed while waiting, the hold the change puts on says so ("Held: CA-408's description changed while waiting on the reporter. Resume, then decide whether to plan now."; the view's `changedWhileWaiting`, other drift holds keep their usual wording), and the readiness question comes back as the Decide need "CA-408 changed: plan now?" with **Plan now** and **Still unclear (ask again)** (once the person has resumed the hold the change put on). Its decision shows what the ticket says now ("The ticket now says": the description, or its start with the rest a disclosure away).
- **I'll answer** now has an end: Pip drafts one comment "Answers to the open questions" with each answer under the question it answers, for approval (a comment, never a description rewrite). Pip proposes the plan only on its next turn after that comment is posted, not beside it. Like the questions to a reporter it is never one of "Approve N safe drafts".
- **Asking the reporter** retires the Triage's own pending comment that repeats the questions (superseded by the questions draft), unless the person edited it. So do **I'll answer** and **Plan anyway** (`retire_triage_notes`; the note says the ticket can't be sized, which would contradict what follows in Jira); the answers draft also supersedes such a note if one still waits. Another run's comment (an Investigate's findings) is never touched.
- **Plan anyway** passes the open questions into the plan's prompt as "Open questions the plan assumes answers to", so its description draft lists them, each as the question and "Assumed: <the answer the plan assumed>". The plan opens with, and its summary carries, "Assumes answers to N open questions from triage (listed at the end)."

### A NeedGroup
- One per workstream, plus General (null).
- `{ workstreamId, title, top: Need, rest: Need[], count, safeBatch: Need[] }`.
- `top` is the highest-ranked need.
- `safeBatch` holds the batchable pending drafts (comment, transition, subtasks), offered as "Approve N safe drafts" (the one label everywhere, here and on the step rail; `batchLabel` in `pipHomeLogic.ts`) with one combined preview.

### One count
- `needsCount = needs.length`. One number everywhere:
  - the rail badge (one badge, on Pip home; the Agents badge is removed)
  - the composer footer
  - the palette ("Show what needs me")
  - the launcher (no longer a separate pending-drafts count)
- Badge accessible text: "N things need you".

## UI: the Needs-you list (replaces the tray, the Agents "Needs you" lane and the separate badges)
- **Pip home** is the screen's name: a slim header with its one `h1`, "Pip home". Under it the layout is three columns (two below about 1100px):
  - **Left: Needs you is the main column.** It takes the full column height (260-340px wide, so titles have room) and scrolls inside it, never under a cap of its own (`NeedsYouList` with `main`). The workstream list is a compact section under it (`WorkstreamList`: General and the open workstreams, "Start a workstream…" and "Show closed" in one row), at most 45% of the column, scrolling inside that, so both are usable at 1440x900 with a few workstreams and a few needs. Needs you is a region of its own ("Needs you"), not a part of the workstreams' navigation.
  - **Middle:** the timeline and the composer, with the decision pane opening above the timeline.
  - **Right:** the steps.
  - A group's title wraps to two lines (`line-clamp-2`), as a need's and its reason do, instead of being cut to one.
  - **F6 reaches every region**, in the order they sit on screen: Needs you, the workstreams, the timeline, the decision pane (only while one is open), the step rail (only while a workstream gives it steps) and the composer. Shift+F6 and Cmd/Ctrl+[ go back, Cmd/Ctrl+] forward, both wrapping (`PIP_HOME_REGIONS`, `stepRegion` in `pipHomeKeys.ts`). It lands on the first Needs you row (the open one first), the selected workstream, the newest timeline entry, the decision's own first button, where the rail was left, and the composer.
  - **j/k go row by row through the visible rows** of the left column: the Needs you rows, then the workstreams'. A folded group is one row. An open group is its own row, then one row for each of its other needs: its top need is listed again under it, and j/k step past that second row (`data-needs-top`) so no need is stopped on twice. Enter or o (or →) on a group expands it and opens its top need; ← folds it. Esc closes. The `data-pip-home-column` and `data-needs-you-*` handles are as they were.
- It also opens as the rail popover.
- **Rows**: one per NeedGroup. Each row shows:
  - the ticket key and title
  - a group chip (Decide / Unblock / Approve)
  - `top.why`
  - an age
  - "+N more" when there is more than one need
- **Expanding** a row (Enter or →) lists every need in the group, plus "Approve N safe drafts" when `safeBatch` has 2 or more. That button, and the palette's "Approve all safe drafts in …", open the combined preview in the decision pane like any other decision (`batch` in `pipHomeStore`, `BatchDecision` in `NeedsPane.tsx`): what each draft would do, fixed as it was when the pane opened, then one confirm ("Yes, approve N"). Cancel, ×, Esc or opening another decision keep every draft as it is; the outcome is said in the pane and in a toast.
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
- **Pane header**: `why` + `ifYouWait`, with a link "Open in workstream". It stays in view (sticky) while the decision under it scrolls.
- **One decision, shown once.** A decision open in the pane is not repeated anywhere else on Pip home (`DecisionShownContext`, `decisionShown` in `src/workspace/decisionShown.ts`):
  - An escalation's card is not on the rail while the pane has it, and its card in the pane leaves out its own "R3 still blocks after 2 fix rounds. What next?" line, since the header says it.
  - A system hold's banner is not on the rail while the pane has it.
  - A draft the pane shows (a draft need's, a question's reply draft, the review draft folded into an escalation) is not a card on the timeline (a line stands in, which opens the same need) or in the step rail. Closing the pane puts them back.
  - The Pip pane (outside Pip home) and the ticket peek keep showing what they show; there is no pane to repeat.
- **One scroll, nothing hidden.** The pane is the one scroll container in its place (at most 60% of the conversation column); nothing inside it scrolls. A draft's action bar is in the flow at the card's end there rather than sticky, so it never floats over the draft's text or the review comments under it. (On the timeline, the rail and the peek the bar stays sticky.)
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

Global shortcuts: Cmd/Ctrl+0 goes to Pip home from anywhere, the Agents screen with a card's button focused included (a button on a card keeps plain keys from the list's own, but lets a Cmd/Ctrl shortcut through: `ownKey` in `agentKeys.ts`). It works from Pip's composer too, never from another field or behind the open palette. Cmd/Ctrl+K opens the palette, Cmd/Ctrl+J Pip.

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
- **Fix rounds** each have a line, from the audit: "Fix round 1 sent to R3 automatically" for the rules' rounds, "Fix round 3 sent to R3" for one the person chose. It opens the build it went to.
- **A failed run's heading is short** ("Build R4 failed"); what the run said went wrong is the entry's `detail`, in smaller type under it.
- **Audit lines** are worded as Activity words them. The lines a run's or a draft's own entry already tells are left out (`run_approved`, `autostart`, `wake`, `draft_created`, `draft_retired`, `notes_set`). The same line repeated in a row collapses into one ("… (3 times)").
- **Linking to Needs you**: a waiting run, a waiting draft, the hold the system made that still holds (and a used-up budget's question), and the open escalation carry the need's key. A hold the person chose has no need, so its line opens nothing.
- **Ordering**: by when things happened; a tie goes to what was said, then the audit, then runs, then drafts. Cause precedes effect whatever the clocks say: a draft a run left never stands before that run, and an audit line about a draft (approved, skipped, a review posted) never before the draft, nor before the run it came of. In Every workstream the parts' lists are merged, each keeping its own order. Turns now carry `at` (the stored turn's `createdAt`, or when it was asked).
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
    - Its filter is its own (a group named "Filter", not "Timeline filter"), so filtering the pane leaves Pip home's filter as it was. It has no scope toggle: the pane is one workstream. Its Runs filter has a link, "Runs in every workstream", to Pip home's Runs timeline in Every workstream.
    - Runs render with the pane's narrow `PipRunCard` (with its Open button), not the Agents row, so the Agents screen's row and its `agent-<id>` id stay the only ones on screen when both show. Enter on the card opens the entry (`timelineKeyAction(…, runOpensItself = false)`).
    - General's conversation in the pane is unchanged: it follows the screen, lists the runs going ("Your agents", "See all in Agents") and the drafts waiting with the ticket on screen first and the rest folded. On Pip home General is a timeline as before.
- **Scope: This workstream / Every workstream.** Beside the filter, a toggle (group "Timeline scope") says whose timeline it is. It applies to every filter and lives in `pipHomeStore` (`timelineScope`) beside `timelineFilter`.
  - **Every workstream** is every open workstream's timeline plus General's, merged by time (`timelineAcross(everyWorkstreamParts(…))` in `src/lib/timeline.ts`, pure). Each part is the same `timeline()` its own workstream shows (its turns, its runs, the drafts its conversation shows, its audit), then General's. Something two parts both show (a draft waiting on a workstream's ticket, which General lists too) is one entry, in the workstream's part. Ties keep the order by kind, then the parts' order.
  - Each entry carries a small label (`data-timeline-workstream`): its ticket key, the workstream's title without one, or "General". Its accessible name starts with it.
  - While Every workstream is shown, every open workstream's conversation and audit are loaded. The composer stays the selected workstream's; the workstream intro shows only in This workstream.
  - **Runs + Every workstream is a timeline like the others.** Choosing Runs with Every workstream stays on Pip home and shows the runs of every open workstream and General, merged by time, each labelled with its workstream (`showTimeline` in `TimelineFilterBar.tsx` sets the filter and the scope and goes to Pip home; there is no redirect and no `isAgentsView`). The scope toggle has no title about another screen.
  - **The Agents screen is the operations view**: what is running, the capacity, Stop all, Start an agent, and safety and settings. It is reached by the rail's Agents button and the "Open Agents" command in ⌘K (keywords: agents, running, capacity, operations, stop all). It has no timeline filter of its own; its header has a "Runs timeline" button that goes to Pip home's Runs in Every workstream. Its selection, keys (`agentKeys.ts`), settings, banners, lanes and layouts are unchanged, except that its list keeps clear of the floating Pip launcher like the other screens: room under the last row (`--ws-launcher-clear`) and a right gutter (`--ws-launcher-gutter`, `LAUNCHER_GUTTER`) so no card or "Show" link stands under it.
  - Asking Pip home to show a card (`focus`) sets the filter back to All and the scope back to This workstream.
- **⌘K ranking**: a command the query names comes before any ticket or search result. A query names a command when each of its words is a word of the command's title or keywords, or the start of one ("runs", "timel", "agents", "stop all"); `namesCommand` and `searchOrder` in `commands.ts`. A ticket whose key starts with what was typed still leads, so typing a key finds the ticket, and fuzzy ticket search is unchanged after the commands the query names.
- **⌘K**: "Timeline: All", "Timeline: Runs", "Timeline: Drafts", "Timeline: Decisions", "Timeline: This workstream" and "Timeline: Every workstream" (`timelineCommands` in `commands.ts`, in the Workstreams group, while Agents are on). A filter keeps the scope and a scope keeps the filter, as the buttons do; every one goes to Pip home. The filter and scope on screen are marked current, while Pip home is on screen; no combination is marked as another screen.
- **Keyboard** (`src/workspace/timelineKeys.ts`, the `keyMap.ts` model):
  - j/k (or the arrows) move from entry to entry. An entry's stop is its draft card, its run row, or the entry itself.
  - Enter or o opens the target. A draft card keeps its own keys (a, e, d, s, Enter, o), and a run row opens on Enter.
  - ArrowUp from the empty composer reaches the newest draft waiting, else the newest entry.
  - The footer says "j k move through the timeline · ↵ o open what it is about" while the keyboard is on an entry.
  - Asking Pip home to show a card (`focus`) sets the filter back to All (and the scope to This workstream).

## Explaining the modes and Allow once (dogfood B10)
Two things the person was never told, said where they decide.
- **The mode line.** One short line directly under the Manage switch, in the workstream header on Pip home's rail and in the Pip pane's header (`WorkstreamControlsView`, `MODE_LINE`, `data-mode-line`). It changes with the mode:
  - Manage: "Pip manages: it starts the next step by itself and drafts what's next; nothing reaches Jira without you."
  - Advise: "Pip advises: it answers when asked and starts nothing by itself."
- **Allow once, said once.** On the first permission prompt the person ever sees, a one-time explainer sits above the buttons (`PermissionExplainer` in `PermissionAsk.tsx`, `data-permission-explainer`):
  - Allow once in Terminal records your choice, opens this run in Terminal with the exact command copied, and you confirm there; nothing runs until you do. (Left out where the run can't be allowed, which has only Deny.)
  - Deny tells the agent no, and it carries on without it.
  - A "Got it" button dismisses it, and the keyboard lands on the prompt's first answer. Dismissal is kept in the prefs as `permissionExplainerSeen` (`src/workspace/prefs.ts`, the same store and the same way as the orientation card's `pipOrientationSeen`), so it never shows again. While it shows, the one-line Allow once note under the command is left out, since it says the same; it is back once dismissed.
  - It shows wherever the prompt does until dismissed (the decision pane, a run's card, the run sheet). The e2e profile starts with it dismissed (`SEEDED_PREFS`), as with the orientation card.

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
- **3.** Done: one timeline per workstream, with the Runs filter across every workstream (the Agents screen is now the operations view), a This workstream / Every workstream scope, the timeline in the Pip pane, and ⌘K commands for the filter and scope (see above).
- **4.** Done: undo for reversible actions, one key model app-wide, and every action in ⌘K (see above).
- **5.** Notifications per workstream state change ("CA-401 is waiting on you"), not per event, with an optional digest setting.
