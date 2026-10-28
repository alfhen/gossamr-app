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
  - **decide**: escalation, plan or description approval, a workstream that used its automatic steps (`budget`).
  - **unblock**: permission, question, sign-in, failure, stopped at limit, a hold the system made (restart, a tripwire, the daily cap, the quota).
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

### Runs: what is and is not a need
- A run is a need while it waits on an answer (question, permission, sign-in). Finished runs, runs started or stopped by the person, quiet runs, runs in a state Gossamr can't read and possible continuations are states, not needs: no count, no badge.
- A failed or limit-stopped run is a need only while it is the **latest** run of its kind on its ticket (`latestRuns`; the repository stands in for a ticket). A newer run in any state, or a Dismiss, closes it, so several Plan runs that failed for the same untrusted folder are one need, on the latest run, offering the trust step and Retry.
- An **archived** run (`archivedAt`) is closed: never a need, but it still counts as the latest of its kind, so archiving the newest failure does not bring an older one back. The runs store keeps archived runs apart (`archived`), so no badge or list counts them. Only a run that is over can be archived. "Clear finished…" leaves out runs with a draft still to approve and runs that are Needs you items (`src/lib/archiveRuns.ts`, `src-tauri/src/runs/archive.rs`).
- **One count**: `needs.length`. The rail badge (on Agents), the Needs you chip, the composer, the palette, the launcher, Agents' tags and header, and Activity's Your turn (a list of these needs, not of unread feed rows) all read it. The bell has no number; Activity's other chips are information.
- **System notifications** (`runs/notices.rs`) fire only for a stream that newly starts waiting (or waits on a higher group), only while the window is not focused, and never for a finished run. A failed or limit-stopped run notifies only while it is the latest of its kind and ended within `FAILURE_NEWS`; a hold the person chose never does.

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
- **Allow 5 more is the only way to grant steps, so Manage can't be a way round it.** Changing a workstream to Manage while it is not held and its automatic steps are used up (`budget_level` spent) holds it for its budget again, with a supervisor `held` line (detail `budget`) after the `mode_set`, and the Decide need above appears again. So Switch to Advise, Resume, then Manage asks the question again with the count unchanged (the budget level, the steps, and these sequences of actions are in `src/lib/workstreamHold.fixtures.json`, which Rust and the mock both run). The same holds when Resume puts back the Manage a tripwire took away (`rehold_spent` in `src-tauri/src/inbox/workstreams.rs`, `reheldForBudget` in the mock). `budget_reset` is now written only when the person writes in the conversation (their message counts the automatic turns from zero, with detail `message`); old audits keep it, and its wording stays.
- **The Next line** for such a workstream points at the need ("Next: the automatic steps are used up. Choose in Needs you: allow 5 more, or switch to Advise.") and opens it. Any other hold keeps "held: … Resume to continue."

### A NeedGroup
- One per workstream, plus General (null).
- `{ workstreamId, title, top: Need, rest: Need[], count, safeBatch: Need[] }`.
- `top` is the highest-ranked need.
- `safeBatch` holds the batchable pending drafts (comment, transition, subtasks), offered as "Approve N safe drafts" (the one label everywhere, here and on the step rail; `batchLabel` in `workViewLogic.ts`) with one combined preview.

### One count
- `needsCount = needs.length`. One number everywhere:
  - the rail badge (one badge, on the Agents button; there is no other)
  - the composer footer
  - the palette ("Show what needs me")
  - the launcher (no longer a separate pending-drafts count)
- Badge accessible text: "N things need you".

## UI: Needs you is a filter on Agents, and a section of each workstream's detail
Agents is the one work view (`AgentsView.tsx`, the rest in `AgentsHome.tsx`). There is no separate Needs you section, strip or pane: what needs the person is seen by filtering the list and decided in the detail of the workstream it belongs to. The screen is, top to bottom:
- **The header and its filter chips.** The header's summary is a group of toggles named "Show": **Needs you**, **Ready to review**, **Failed or stuck** and **All** (`SummaryChips`; `CHIPS`, `activeChip`, `chipFilters` and `chipCounts` in `agentsLogic.ts`). Each chip says how many it holds. Needs you's number is `needs.length`, the same count the rail badge gives; the other two are the lanes of those names, card for card. A chip with nothing behind it is not shown, unless it is the one that is on. What is running ("2 running · 1 queued") is said beside them.
- **The chips are the existing filters.** Needs you is the `needs` filter (`AgentFilters.needs`), Ready to review and Failed or stuck are the State filter's `done` and `bad`, All clears both. They sit with State, Repo and Ticket in the filter row, which shows the same state, and "Clear" clears them. The default is All. Pressing the chip that is on goes back to All. Needs you also switches the grouping to Workstream, since needs belong to workstreams.
- **What the Needs you filter shows** (`needsScope`): the runs that are a need, and every workstream that holds a need, even when none of its runs is the need (an escalation, a used-up budget, a hold); and No workstream when a need belongs to none. A group left with no run says "Open it to see what needs you." Other filters on top (repo, ticket, state) hide the groups with no run to match, as they always did.
- **The toolbar:** layout (Cards or List), "Group by" State or Workstream, the filters, then "Start a workstream…", "Show closed", "What the words mean" and "How agents work".
- **The list.** **The default grouping is Workstream** (`agentsGroup`): each open workstream is a group with its ticket key and title, its stage, its one status word (`StatusPill`), a badge "N need you" and an accent bar on its left edge when it holds a need (so it stands out with no filter on), its cobweb and an **Open** button, over its agents as cards. The agents that belong to no workstream are under **No workstream**, which has the same badge, accent and Open button when it holds a need. An open workstream with no agent yet is a group too (only while no filter is on, or while Needs you is the only filter and it holds a need). **State** groups by lane; a run that is a need shows an "In Needs you" pill that opens its need.
- **Opening a workstream's detail** (the group's Open button, a need's pill, ⌘K "Open the workstream on …", a plan item, an Activity row, a notification) opens it as a **sheet beside the list** (`WorkstreamSheet`, `#workstream-sheet`): where it stands, the ticket, "Ask Pip about this", its controls and its steps with their runs, drafts and pull request (`StepRail`). The Pip drawer keeps the right-hand column. Esc or its × closes it; leaving Agents puts it away. No workstream opens the same sheet, titled "No workstream", holding only its needs (`id` "general" in `workViewStore`).
- **Needs you, at the top of the detail.** Under a "Needs you" heading with a count, above the steps and runs, sits one item for each need the workstream holds (`WorkstreamNeeds` in `NeedsPane.tsx`), most urgent first (Decide, then Unblock, then Approve; oldest first within a group). Each says what is asked and why; the open one also says what waiting does ("If you wait") and holds the decision itself, built from the existing components:
  - PermissionAsk
  - RunAnswer (question, limit-resume)
  - FailureNext
  - the sign-in box
  - DraftCardBody / ReviewDraft (a comment draft, with approve, edit and skip), the plan's description update ("Approve the plan")
  - EscalationCardView
  - the held banner Resume
  - PlanApproval
  - PipAskBody (a question Pip asked, with "Answer in Pip" and Dismiss)
  - the trust-folder step and the budget's "Allow 5 more"
  The most urgent need is open when the detail opens, unless a link already chose another. Only one is open at a time: "Decide" opens another, "Hide" closes the open one. Once a need is dealt with the next one of the same workstream opens in its place and a line says what was done; with none left a toast says it and the section goes away. A "Approve N safe drafts" preview (the palette's "Approve all safe drafts in …") opens above the stack, with the one confirm ("Yes, approve N"); Cancel, ×, Esc or opening a need keeps every draft as it is.
- **One decision, shown once.** The open need is not repeated anywhere else while its workstream's detail is open (`DecisionShownContext`, `decisionShown` in `src/workspace/decisionShown.ts`):
  - An escalation's card is not on the step rail while the stack has it, and its card there leaves out its own "R3 still blocks after 2 fix rounds. What next?" line, since the header says it.
  - A system hold's banner is not on the rail while the stack has it.
  - A draft the stack shows (a draft need's, a question's reply draft, the review draft folded into an escalation) is not a card on the Pip drawer's timeline (a line stands in, which opens the same need) or in the step rail.
  - The Pip drawer and the ticket peek keep showing what they show.
- **Where a link to a need lands.** The rail badge's popover (a right click, or Shift+F10, on the Agents button, which still lists the needs), a run's "In Needs you" pill, the timeline's "In Needs you" lines, ⌘K's "Show what needs me", a nudge and a system notification all do the same (`openNeed` in `needsActions.ts`): Agents with the Needs you filter on and Workstream grouping, the need's workstream (or No workstream) open, and the need open at the top of its detail with the keyboard on its heading. A notification or nudge for a run that holds a need opens that need; for any other run, the run's sheet. "Open in workstream" (the palette, for a need) opens the detail with the card in view and leaves the filters alone; for a need outside any workstream it opens No workstream, or the run's sheet for a run.
- **Keys.** j and k step through the runs as shown, Enter opens a run's sheet, and the keys on a run's card (o open; a, d, s, e act on its need, asking for Enter first where the key writes something) are as before. The decision in the detail is an ordinary part of the page: Tab reaches its buttons, Esc hides the open need (or ends an edit first), and the focus lands on the need's heading when a key or a link opened it. F6 and Shift+F6 are the workspace layout's.
- **After a decision**: focus moves to the next need of that workstream. When none are left, a toast says what was done.
- **Other surfaces** keep showing their context (draft cards in the conversation, the step rail, the peek) but no longer count. Only the list counts.

## Keyboard (one model, app-wide since step 4)
The same keys mean the same thing in every list that holds actionable items (the Needs you list, draft cards in the conversation and the step rail, Activity's Drafts, the ticket peek's drafts, the Agents list); a place that can't do what a key says ignores it. The table is `src/workspace/keyMap.ts`.
- j/k (or the arrows): move.
- Enter or o: open. 
- a: approve or allow (the primary; on a used-up budget, "Allow 5 more"), confirmed with Enter, since it posts, writes or reaches an agent.
- e: edit.
- d: dismiss (a failure, a draft) or deny (a permission, which reaches the agent, so it keeps its Enter).
- s: skip a draft. d and s on a draft, and d on a failure, act at once and offer Undo.
- Esc: back.

Global shortcuts: Cmd/Ctrl+K opens the palette, Cmd/Ctrl+J toggles the Pip drawer from every screen, Agents included; Esc closes it. A button on a run's card keeps plain keys from the list's own but lets a Cmd/Ctrl shortcut through (`ownKey` in `agentKeys.ts`). The way to the work view is the rail's Agents button, or ⌘K "Open Agents"; Cmd/Ctrl+0 is not a shortcut.

## Undo (step 4)
Reversible actions act at once and offer Undo in a toast for about 8 seconds (`src/workspace/undo.ts`): skipping a draft, dismissing a failed or stuck run, holding a workstream, switching it to Advise. Undo restores the exact previous state; when the action wrote an audit line the undo writes its own (`undone`). The backend allows an undo for 60 seconds, only while that change is the last line of the workstream's audit, so a stale toast can't undo over later changes. Anything that reached Jira, GitHub or an agent (post, approve, apply, Deny, Allow, Stop, Resume, start) keeps its confirm. A toast can be reached from the keyboard: F6 stops at the one on screen (`focusToast`), and Esc on it dismisses it and gives the keyboard back to where it was.

## One timeline per workstream (step 3)
A workstream's story used to be spread over the conversation, the run strip, the step rail, draft cards, the audit and the Agents screen. It is now one chronological list, in the Pip drawer.

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
- **Ordering**: by when things happened; a tie goes to what was said, then the audit, then runs, then drafts. Cause precedes effect whatever the clocks say: a draft a run left never stands before that run, and an audit line about a draft (approved, skipped, a review posted) never before the draft, nor before the run it came of. Turns now carry `at` (the stored turn's `createdAt`, or when it was asked).
- **Filters**: All, Runs (`kind` run), Drafts (`kind` draft), Decisions (what the person did, what asks them to decide, and whatever waits in Needs you).

### UI
- **The Pip drawer's conversation** is the timeline (`src/workspace/Timeline.tsx`, `TimelineView`), under its filter bar (a group named "Filter") with a count per filter, over the composer.
  - Turns render with `TurnView`.
  - Runs render with the drawer's narrow `PipRunCard` (with its Open button), so the Agents list's row (and its `agent-<id>` id) stays the only one of its kind on screen. Enter on the card opens the entry (`timelineKeyAction(…, runOpensItself = false)`).
  - Drafts waiting, drafts Pip made in this conversation, and drafts retired while shown render with `LiveDraftPreview`. Other decided drafts are one line that opens the draft.
  - Audit lines are one line each.
  - Lines for things in Needs you have an "In Needs you" pill and open their need with the same `openNeed`, which opens its decision on Agents.
  - Its Runs filter has a link, "Runs in every workstream", to the Agents screen.
  - The composer, the Next line, and the Needs you section of a workstream's detail are unchanged. General's conversation holds the runs and drafts in no workstream, plus every draft still waiting, as its old "Drafts waiting" did; it follows the screen, listing the runs going ("Your agents", "See all in Agents") and the drafts waiting with the ticket on screen first and the rest folded.
- **There is no timeline of every workstream.** The scope toggle ("This workstream" / "Every workstream"), `timelineAcross` and ⌘K's "Timeline: …" entries do not exist. What is running across every workstream is the Agents list, grouped by workstream; what each workstream did, in order, is its conversation in the drawer.
- **The Agents screen is the one work view**: the summary chips (Needs you, Ready to review, Failed or stuck, All), every workstream with its agents, Start an agent, Stop all, and safety and settings. It is reached by the rail's Agents button and the "Open Agents" command in ⌘K (keywords: agents, running, capacity, operations, stop all, workstreams, needs you). Its list keeps clear of the floating Pip launcher like the other screens: room under the last row (`--ws-launcher-clear`) and a right gutter (`--ws-launcher-gutter`, `LAUNCHER_GUTTER`) so no card or "Show" link stands under it.
- **⌘K ranking**: a command the query names comes before any ticket or search result. A query names a command when each of its words is a word of the command's title or keywords, or the start of one ("runs", "timel", "agents", "stop all"); `namesCommand` and `searchOrder` in `commands.ts`. A ticket whose key starts with what was typed still leads, so typing a key finds the ticket, and fuzzy ticket search is unchanged after the commands the query names.
- **Keyboard** (`src/workspace/timelineKeys.ts`, the `keyMap.ts` model):
  - j/k (or the arrows) move from entry to entry. An entry's stop is its draft card, its run row, or the entry itself.
  - Enter or o opens the target. A draft card keeps its own keys (a, e, d, s, Enter, o), and a run row opens on Enter.
  - ArrowUp from the empty composer reaches the newest draft waiting, else the newest entry.
  - The footer says "j k move through the timeline · ↵ o open what it is about" while the keyboard is on an entry.

## Explaining the modes and Allow once (dogfood B10)
Two things the person was never told, said where they decide.
- **The mode line.** One short line directly under the Manage switch, in a workstream's detail on Agents and in the Pip pane's header (`WorkstreamControlsView`, `MODE_LINE`, `data-mode-line`). It changes with the mode:
  - Manage: "Pip manages: it starts the next step by itself and drafts what's next; nothing reaches Jira without you."
  - Advise: "Pip advises: it answers when asked and starts nothing by itself."
- **Allow once, said once.** On the first permission prompt the person ever sees, a one-time explainer sits above the buttons (`PermissionExplainer` in `PermissionAsk.tsx`, `data-permission-explainer`):
  - Allow once in Terminal records your choice, opens this run in Terminal with the exact command copied, and you confirm there; nothing runs until you do. (Left out where the run can't be allowed, which has only Deny.)
  - Deny tells the agent no, and it carries on without it.
  - A "Got it" button dismisses it, and the keyboard lands on the prompt's first answer. Dismissal is kept in the prefs as `permissionExplainerSeen` (`src/workspace/prefs.ts`, the same store and the same way as the orientation card's `pipOrientationSeen`), so it never shows again. While it shows, the one-line Allow once note under the command is left out, since it says the same; it is back once dismissed.
  - It shows wherever the prompt does until dismissed (the decision pane, a run's card, the run sheet). The e2e profile starts with it dismissed (`SEEDED_PREFS`), as with the orientation card.

## Workstream cobwebs: work is happening but Jira hasn't heard
A ticket row withers when the ticket itself is untouched (`witherLevel`, `WITHER_DAYS`, the `Cobweb` component and the spider CSS). A workstream can be busy while its ticket is quiet: agents run and Pip takes turns, and nothing reaches Jira or GitHub, which is what other people read. So each workstream's heading in the Agents list gets the same cobweb, on a different clock.
- **The clock** (`workstreamWither` in `src/lib/workstreamWither.ts`, pure and unit-tested): the days since the person's last post to Jira or GitHub for that workstream, else since it opened. A post is the person's audit line for an approved (applied) comment, description, transition or subtask draft (and the other Jira writes: a new ticket, a change, a link), or a posted review (`review_posted`, `escalation_posted`). A draft that starts an agent, sends one back or answers one, a skipped or unknown draft, and any line by Pip, the supervisor or a run are no post. The draft's kind is read from the draft the line names.
- **The stages** are `WITHER_DAYS.ticket` (2, 3, 5, 7, 10 days): the first dries the row out, the second draws the web, each after it adds a spider.
- **The condition that matters:** it counts only while the agents or Pip were at work since that post (a run started or finished, a Pip turn: the conversation's turns, else the audit's `wake` lines). With no activity since there is no cobweb: the ticket's own cobweb in the ticket list covers a ticket nobody touches.
- **Words:** the heading's `title` and a screen-reader line inside it (`data-workstream-wither`) say "No Jira update for 5 days (3 runs since)" (runs and Pip turns: "(3 runs and 2 Pip turns since)"). The drawing is `aria-hidden`.
- **Never a need, never counted.** It is a look, not a duty: it adds nothing to Needs you or to any count, and hovering the heading sweeps the web away as it does on a card.
- **Where.** The Agents list, grouped by workstream, is the only list whose headings are workstreams (`WorkstreamHeadExtras`, fed by `useWorkstreamWithers`, which reads the workstream's audit and conversation, and the audit again when a draft is applied). The Agents list's State lanes, Needs you's groups, ⌘K and Activity are not rows of workstreams and have none.
- **In the sample.** Its clock is the browser's, which a test can't move, so `__gossamrMock.seedWorkstreamEvent(key, {actor, action, at})` adds an audit line as of a time and `__gossamrMock.backdateWorkstream(key, days)` makes a workstream older.

## Habits: looking at the day
The owner's tickets are often vague and plans slip, and other people read what goes to Jira. Start my day makes that harder to skip. It posts nothing by itself, and is not a need or counted.

### Start my day (`src/lib/startMyDay.ts`, `src/workspace/StartMyDay.tsx`)
- **The card** sits at the top of the Agents list (a region of its own, `data-start-my-day`), built by the pure `startMyDay` from what the page holds: Needs you by group (Decide, Unblock, Approve), the unclear tickets, the workstreams waiting on the reporter (with days), the cobwebbed ones (with days) and the Jira drafts waiting to be posted. A line with nothing in it is left out; a quiet day says so. Each line lists its first three entries ("and N more"), and each entry has one button that opens the thing: the need's decision, the workstream, the ticket's peek, or (for a reporter who has been silent 2 days) "Draft a nudge". It gives its place while a need or a batch preview is open in a workstream's Needs you.
- **Only when asked for.** It does not open by itself: it repeats the Needs you lines, which the badges and each workstream's detail already give. ⌘K "Start my day" opens it and puts the keyboard on it; "Done for now" puts it away (`dayOpen` in `workViewStore`; nothing is stored).
- **The unclear line** is every open workstream whose clarity notice still names a gap (whoever the ticket is assigned to: a workstream is always opened on purpose), then the signed-in person's own open tickets with no workstream that read thin to the same word check, minus the gaps "Looks fine" taught away. A ticket that already has a need (its workstream's, or one in General about it) is left out: it is in its Needs you group, and the need comes first. The ticket cache has no sprint, so "in an active sprint" can't be told and assigned is the whole scope.

Pip answers questions about what was sent to Jira from the workstream audit.

## One status word per workstream, and Plan my week
A first-time user meets about ten concepts, so each workstream says where it stands in one word, and the week gets a short plan.

### The status word (`workstreamStatus` in `src/lib/workstreamStatus.ts`, `src/workspace/StatusPill.tsx`)
- **One pure function** gives every workstream's heading in the Agents list and the workstream header the same pill: a word, a colour token and at most one short detail ("2 waiting", "Build"). The stage ("Build"), the cobweb's drawing, tooltip and screen-reader sentence stay on the heading.
- **The order is the order of this document: what asks the person comes first.** (1) **Needs you**: a need in this workstream (detail "2 waiting"). It is first because Needs you is the one place decisions are made. (2) **Paused**: the pause is the only need; the person resumes it. (3) **Running**: a run is going, or queued for a slot (detail "Build" or "Build queued"). (4) **Done**: closed, or its stage is done. (5) **Idle**: otherwise (detail "Review failed" after a failed run).
- **The Agents list does not narrow by status.** The status word says where each workstream stands; the filters (state, repo, ticket) narrow the agents under them.

### Plan my week (`src/lib/planMyWeek.ts`, `src/workspace/PlanMyWeek.tsx`)
- **⌘K "Plan my week"** and a link on the Start my day card open a card above the list on Agents. Pip proposes `WEEK_PICKS` (3) of the person's open workstreams and assigned tickets, by a pure ranking: no agent turn, no automatic step, nothing written to Jira. Each pick has a one-line "Because …".
- **The ranking:** workstreams with a need first (decide, then unblock, then approve, oldest first); then by score: priority, age, a cobweb or a run already going for a workstream, and a ticket whose description reads thin (the same word check as the clarity notice, minus what "Looks fine" taught away) ranked lower. That pick is asking work, not building: it reads "Clarify CA-408 with the reporter" (`work: "clarify"`) and its because line says what is thin and how many questions that makes; a workstream with the notice standing and nothing else going on is proposed the same way. The proposal holds at most one such pick; further ones fill the week only when nothing else is left. Every because line says what sets this ticket apart (its priority, its age, who or what needs you, the cobweb), and a need's line adds the ticket's priority and age. Workstreams waiting on the reporter, held (unless they have a need), closed or done are left out; so are tickets with a workstream already (the workstream stands for them) and tickets that are Done.
- **There is no Triage size to read.** A Triage's "size 3" is a sentence in its result "For Jira", not a field, and no ticket carries an estimate or story points, so the plan uses readiness and state only.
- **The person edits it:** drag a row, or Alt+↑/Alt+↓ on a focused row (the buttons do the same), Remove, and add a ticket by key or words (several title matches show a short list of up to 5, the person's own first, to choose from with ↑ ↓ and Enter; Esc cancels). Plain ↑ ↓ (or j k) on a row move between the rows. "Keep this plan" stores it in the prefs per ISO week (`weekPlans`, the newest 8 weeks, on this device) and it shows as "This week" above the list on Agents. Each item opens its workstream (or its ticket); it is ticked when it is done: its workstream closed on a ticket that is Done in Jira, or its ticket is Done. A workstream closed on a ticket that is not Done is **closed, not done** (`itemOutcome`): the item is muted with another mark (⊘), the title says why, and it is not ticked. A ticked or closed item has **Reopen**, which keeps it open whatever its workstream or ticket says (`reopened`, stored with the kept plan).

## Later steps (separate PRs)
- **2.** Workstream header shows "Next: …" and "N of M automatic steps left". (The budget PR adds the numbers.)
- **3.** Done: one timeline per workstream, with the Runs filter across every workstream (the Agents screen is now the operations view), a This workstream / Every workstream scope, the timeline in the Pip pane, and ⌘K commands for the filter and scope (see above).
- **4.** Done: undo for reversible actions, one key model app-wide, and every action in ⌘K (see above).
- **5.** Notifications per workstream state change ("CA-401 is waiting on you"), not per event, with an optional digest setting.

## One Pip drawer

Pip is one conversation surface: the drawer on the right (`PipPane`), toggled by Cmd/Ctrl+J, the rail's Pip button or any link that asks Pip something (`askPip`, `usePip.openWith`, `askAbout`, `focusPip`, a suggestion's button). Whether it is open is kept for the session only. It has the suggestion chips, image attach, the first-run "New here?" card (until Got it) and, under the input, a status line (`composerFooter`: agents running, then the one Needs you count).

On Agents the drawer shows the conversation of the workstream whose detail is open (otherwise the ticket in the peek's, otherwise General's); the workstream's detail is a sheet in the main area beside it, never under it. The drawer keeps the right-hand column on every screen.
