# Gossamr

A keyboard-first Jira client for macOS. It keeps a local inbox of what changed on the tickets you care about, sends native notifications, lets you transition and comment without opening Jira, and can hand a ticket to Claude Code using your existing Claude login and sessions.

Built with Tauri 2, React, TypeScript and Tailwind CSS v4.

## Requirements

- macOS with Xcode Command Line Tools
- Rust (stable) and Node 22 with pnpm
- [Claude Code](https://code.claude.com) installed and logged in, for the Ask Claude panel

## Connecting Jira

Gossamr signs in through your own Atlassian OAuth 2.0 (3LO) app:

1. Create an OAuth 2.0 integration at [developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps/).
2. Under Permissions, add the Jira API with `read:jira-work`, `write:jira-work` and `read:jira-user`.
3. Under Authorization, set the callback URL to `http://localhost:8723/callback`.
4. Start the app, paste the client ID and secret, and click **Sign in with Atlassian**.

The client secret and tokens are stored in the macOS Keychain under `dk.alfhen.gossamr`. "Try it with sample data" skips all of this.

### A company-owned Atlassian app

An admin can register one app for a team instead of everyone making their own:

1. Create an OAuth 2.0 (3LO) integration at [developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps/).
2. Add the Jira API permissions `read:jira-work`, `write:jira-work` and `read:jira-user`. The app also requests `offline_access` so sign-ins last.
3. Set the callback URL to `http://localhost:8723/callback`.
4. Distribute the client ID and secret. Atlassian needs the secret to exchange and refresh tokens, so it ships with the app or the team's setup and can be extracted from either; use this for internal builds only.

Gossamr looks for the client in this order, and the setup screen is skipped when one is found:

- entered on the setup screen (kept in the Keychain)
- the `GOSSAMR_ATLASSIAN_CLIENT_ID` and `GOSSAMR_ATLASSIAN_CLIENT_SECRET` environment variables when the app starts
- the same two variables set when the app is built, which compile the client into the binary

## The workspace

The app opens in the workspace, a board, list and age view over everything synced from Jira, with a rail of projects and saved views, tabs, a command palette (`⌘K`), a peek sheet for one ticket and Pip, the assistant, docked on the right (`⌘J`). `⌘R` (View > Reload) reloads the window; it only redraws the page and restarts nothing in the app. Everything is read from the local cache, so it starts with the last data when offline. The assistant only proposes: dropping a card on a column, a comment written in the peek sheet and Pip's suggestions all become drafts, and nothing is written to Jira until you approve one.

- **Board:** one section per project with that project's own statuses. Jira only reveals the moves open to a ticket one ticket at a time, so when you pick a card up the app asks Jira where it can go and dims the other columns.
- **Settings:** the Jira site and account, when it last synced, **Sync now**, and **Sign out**. The classic inbox is still reachable from there for now, and back again from its sidebar.
- **Errors** that don't block anything (a failed sync, a move that couldn't be checked) appear as a toast in the corner.

### Mock mode

`pnpm dev` runs the workspace in a browser on built-in sample data: four projects with different workflows, drafts, and a scripted Pip that answers a few requests and drafts a move or comment. No Jira and no Claude are involved, and the classic inbox isn't available there.

### Not yet verified against a live Jira site

The Jira adapter was written against the REST v3 documentation and tested with response bodies shaped like the documented ones. It has not been exercised on a real site, so these are the places to look first if something misbehaves:

- Creating an issue, updating fields, linking issues and creating sub-tasks (`issue/createmeta/{project}/issuetypes`, `issueLink`). Link direction follows Atlassian's own convention (the blocking issue is the inward one).
- Reading a project's statuses (`project/{key}/statuses`) and the project list (`project/search`) for board columns.
- Approving a move: the status id on the card is matched to Jira's transition id at approval time, and Jira may refuse it if the workflow has required fields.
- Reading comments from the API (`issue/{key}/comment`) for the peek sheet, and rendering their formatting; media and some panels show as plain text.
- Rewriting a ticket's title and description (`PUT issue/{key}`) from a draft you approve. The description goes to Jira as ADF built from Markdown, so images, tables, panels and macros in the old one become plain text (the draft says so, and Jira keeps the old text in the issue history). The ticket is read again just before the write, and one edited in Jira since the draft was made is refused. Jira can't make the write conditional, so an edit made in the moment between that read and the write can still be overwritten.
- Pip narrowing the view (`pip-view`, `set_view_filter`) and the nudge bubble.
- Bulk moves offer every status and rely on Jira refusing the ones a ticket can't reach.

## Ask Claude

Press `⌘J` on a ticket to ask Claude about it. The app runs your installed Claude Code headlessly (`claude -p`) with your existing login, so it uses your subscription. It does not load your CLAUDE.md, memory, skills, hooks, plugins or other MCP servers. It runs in an empty folder inside the app's data directory, and follow-ups continue the session Pip started there. It runs Sonnet at medium effort, whatever your Claude Code default is.

Agents are Claude Code sessions. Claude asks once per folder whether to trust it, because a cloned repository's own hooks, MCP servers and settings run with the agent. Gossamr never edits Claude's config or answers that question for you. When a folder isn't trusted yet, the checks before you approve show a Trust this folder button that opens Terminal there with `claude`; accept the question, close Terminal, and the checks run again. If a launch is refused anyway, the run opens with the reason and the same button, and Retry starts the same approved run again.

Claude can read the ticket through a local MCP server the app runs, and nothing else: no built-in Claude Code tools, so it can't read local files, run commands, browse the web or write files. It can't change Jira either: comments, transitions, subtasks, new tickets and new titles or descriptions for a ticket come back as cards you approve, edit or skip. A description edit shows as a before-and-after diff, and Autopilot can never make one.

## Development

```bash
pnpm install
pnpm tauri dev
```

`pnpm dev` runs only the web UI in a browser, which is handy for layout work.

### Stop the Keychain prompt after every rebuild

macOS ties Keychain access to the app's code signature. An unsigned dev build gets a new signature on every rebuild, so the "allow access?" prompt comes back each time. Run this once to sign local builds with a stable identity:

```bash
./scripts/dev-signing/setup.sh
```

It creates a throwaway signing certificate in its own keychain (`~/Library/Keychains/gossamr-dev.keychain-db`, empty password, nothing else in it). `cargo run` and `pnpm tauri dev` then sign the binary with it before launching, through the runner in `src-tauri/.cargo/config.toml`. Click **Always Allow** on the first prompt after setting it up and it stays quiet from then on. Without the identity (a fresh clone, CI) the runner just launches the binary unsigned.

To undo it, delete the keychain file.

Checks that CI runs:

```bash
pnpm typecheck && pnpm test
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
```

Two tests run the real `claude` CLI and are skipped by default. With Claude Code installed and logged in:

```bash
cd src-tauri && cargo test -- --ignored
```
