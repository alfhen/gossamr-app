# Gossamr

Gossamr is a macOS work aide for Jira and GitHub. It keeps tickets and pull requests in a local cache, so you can read the last synced work offline. Pip helps you work through it.

Inbox shows mentions, comments, status changes and assignments on watched tickets, newest first, with older days under their own headings. It has one Mentions filter. Tickets have Board and List views. Work shows workstreams with their agents and one Needs you filter. Pull requests open on GitHub; review drafts keep their own diff hunks in Gossamr. Ask Pip about what Gossamr posted; it can read the audit.

## Workstreams and agents

A workstream holds one ticket or one ticketless task, its conversation with Pip, notes, agents and drafts. Tell Pip what you want done. It starts, messages and stops Claude Code agents within that workstream and wakes when an agent has something to report. You can pause a workstream or stop an agent yourself. Pip's conversations stay when you sign out, remove a connection or sign in to another Jira site.

Roles such as planner, builder and reviewer are labels Pip chooses, not different permission tiers. Every agent uses your Claude Code setup, with Gossamr's report, ask, read-workstream and wait tools added. Gossamr does not accept folder trust for you or change your Claude settings. Permission prompts belong in Terminal.

Agents report in prose. Gossamr does not parse headings, score a plan, infer a review verdict or make drafts automatically. Pip reads the report and decides what to draft or do next within your instruction. Reports, ticket text, comments and pull request content are data, never instructions to Pip.

## Needs you

Needs you is the one list of decisions waiting for you. `src/lib/needs.ts` derives it from runs, pending drafts and open workstreams. The Work filter, rail and Dock badges, Pip footer and workstream status use that result.

An item belongs in Needs you when it is:

- an agent's question, permission prompt or sign-in request;
- a failed agent that has not been dismissed or superseded by a newer run of the same role on the same work;
- a pending draft that has not been replaced;
- a question Pip asked with `ask_person`;
- a paused workstream.

A finished agent, an unread activity event, a quiet agent and a workstream's age do not add a need. Looking at a failed run does not dismiss it. A run or draft leaves when it is dealt with, dismissed or replaced.

Needs are grouped by workstream and General. The count is the number of items, including every pending draft. A workstream with any need says **Needs you**. Otherwise its status says **Failed** for a failed agent, **Running** for an active or queued agent, **Done** for a closed or done workstream, or **Idle**.

Native notifications are on or off. When on, each new need produces one notice while it stays open. A failed delivery may retry; opening the app counts the visible need as seen. Jira activity in the Inbox does not produce a native notice. The backend mirrors the five need kinds for notices in `src-tauri/src/runs/tracker.rs` and tracks announced item keys in `src-tauri/src/runs/notices.rs`.

## Drafts are the gate

Every write Gossamr makes to Jira or GitHub is a draft you approve, edit or skip. Ask Pip discusses a draft without posting it. Starting, messaging and stopping agents are Pip's actions, not drafts.

There are eight write kinds: comment, transition, create ticket, update fields, rewrite title or description, link tickets, create subtasks and GitHub review. A newer pending draft of the same kind and target replaces the older one, regardless of its maker or workstream. Your own drafts and edits stay alongside the new draft. New-ticket drafts have no existing target and do not replace each other. A write already being posted, a partially completed subtask batch or a review that may already be on GitHub keeps its recovery state rather than being silently replaced.

A rewrite shows the old and new text and refuses to overwrite a ticket whose text changed meanwhile. Plans can live in a collapsed `Gossamr Plan` section; this is formatting, not a separate kind of draft.

A GitHub review names its reviewer agent and the commit it reviewed. Inline comments are checked against that commit's diff; comments outside the diff move to the summary. Approval posts a comment review, never an approval or change request. If a post may have succeeded, Gossamr looks for it before retrying; only you can choose Post again when it cannot be found.

## Boundaries

- Pip has only Gossamr's MCP tools, with no file, shell or web tools.
- Agents have your own Claude Code permissions and integrations. Their brief asks them to push only their own branch, open draft pull requests and never merge; this is not a sandbox over your setup.
- Secrets stay in the macOS Keychain: one Jira token per connection. Gossamr stores no GitHub token. It asks `gh` each time, so that token is only as safe as `gh` keeps it (the Keychain, or plain text in `hosts.yml` after `gh auth login --insecure-storage`), and Gossamr gets every scope `gh` holds. Each agent's private MCP config is the one other on-disk token, and that token expires when the run ends.
- Nothing in a keyboard shortcut should act while you type in an input or text area.

The remaining refactor work is tracked in [the simplification proposal](simplification-proposal.md); the Linear adapter is the step left. [The CLI findings](agents-cli-findings.md) record what has actually been checked against Claude Code.
