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

## Later steps (separate PRs)
- **2.** Workstream header shows "Next: …" and "N of M automatic steps left". (The budget PR adds the numbers.)
- **3.** One timeline per workstream: conversation, runs, drafts and audit merged. Agents becomes a filter view.
- **4.** Done: undo for reversible actions, one key model app-wide, and every action in ⌘K (see above).
- **5.** Notifications per workstream state change ("CA-401 is waiting on you"), not per event, with an optional digest setting.
