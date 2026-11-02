# Goals

Gossamr makes it less tedious to work with planning software such as Jira and Linear, orchestrates agents that plan and carry out the work, and keeps the task tracker up to date. It is built for its maintainer to use at work, and could be useful to others in the industry, on the same team or at the same company.

## Goals

- Do the day's tracker work in one place: the Inbox, board and ticket peek cover reading and acting on watched tickets, so you rarely need Jira's or Linear's web app. A change serves this goal if it removes a reason to open the tracker's own UI.
- Agents take a ticket from plan to pull request, and you only make the decisions: Pip plans, starts, messages and stops agents within a workstream, and you step in only for what is in Needs you. A change serves this goal if it removes a manual step, or a need that is not a real decision.
- The tracker reflects the work: what the agents and you do becomes ready drafts (status moves, comments, PR links, plans) that you approve in one click, so the tracker stays current without updates by hand. A change serves this goal if it cuts the time between work happening and the tracker showing it.
- Work with the tools you already use: Jira and Linear, GitHub through `gh`, Claude Code (and Codex in beta), with several accounts of each. A change serves this goal if it removes a reason someone's setup can't use Gossamr.

## Non-goals

- No writes to Jira without a draft you approve. You stay in control of what your team sees.
- Not a replacement for the tracker. No task database or project management of its own; Jira and Linear stay the source of truth.
- No hosted service, for now. Gossamr runs on your Mac, with a local cache and secrets in the Keychain.
- No sandbox or agent harness of its own. Agents use your own Claude Code or Codex setup; Gossamr is not building a replacement harness.
- Pip stays locked down: only Gossamr's own tools, no file, shell or web access. Pip orchestrates; the agents it starts do the work.
- macOS only, for now.

## Users

- Developers: work their Jira or Linear tickets and GitHub pull requests from one place, and have agents plan, build and review while the tracker stays current. The maintainer is the first of these, using it at work.
- PMs (product or project managers): keep tickets, statuses and plans up to date and see the state of the work, without chasing people or updating the tracker by hand.

## How to change this file

Only the maintainer changes the goals and non-goals, in a PR of their own. Plans are checked against this file before anything is built.
