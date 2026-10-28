# Needs you

Needs you is the one list of decisions waiting for the person. `src/lib/needs.ts` derives it from runs, pending drafts and open workstreams. The Work filter, rail and Dock badges, Pip footer and workstream status use that result.

An item belongs in Needs you when it is:

- an agent's question, permission prompt or sign-in request;
- a failed agent that has not been dismissed or superseded by a newer run of the same role on the same work;
- a pending draft that has not been replaced;
- a question Pip asked with `ask_person`;
- a paused workstream.

A finished agent, an unread activity event, a quiet agent and a workstream's age do not add a need. Looking at a failed run does not dismiss it. A run or draft leaves when it is dealt with, dismissed or replaced.

Needs are grouped by workstream and General. The count is the number of items, including every pending draft. A workstream with any need says **Needs you**. Otherwise its status says **Failed** for a failed agent, **Running** for an active or queued agent, **Done** for a closed or done workstream, or **Idle**.

Native notifications are on or off. When on, each new need produces one notice while it stays open. A failed delivery may retry; opening the app counts the visible need as seen. Jira activity in the Inbox does not produce a native notice. The backend mirrors the five need kinds for notices in `src-tauri/src/runs/tracker.rs` and tracks announced item keys in `src-tauri/src/runs/notices.rs`.

Every Jira and GitHub write remains a draft until the person approves it. Permission prompts are answered in Terminal.
