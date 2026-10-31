# Gossamr

A macOS work aide for Jira and GitHub. It keeps a local Inbox of today's activity on watched tickets and shows native notifications for new things in Needs you. Pip, the assistant, works through tickets with you and starts Claude Code agents on them, with your own Claude login and setup.

Built with Tauri 2, React, TypeScript and Tailwind CSS v4.

## Requirements

- macOS with Xcode Command Line Tools
- Rust (stable) and Node 22 with pnpm
- [Claude Code](https://code.claude.com) installed and logged in, for Pip and agents
- [GitHub CLI](https://cli.github.com) (`gh`) installed and logged in, to connect GitHub

## Connecting Jira

Gossamr signs in with an Atlassian API token that you make:

1. Start the app and enter your Jira site, like `acme.atlassian.net`.
2. Click **Create token**. Atlassian opens with the Jira app, the three scopes (`read:jira-work`, `write:jira-work`, `read:jira-user`) and the longest expiry your organisation allows already filled in. Press **Create** there and copy the token.
3. Paste your email and the token into Gossamr, and check the expiry date. Atlassian doesn't report it, so it starts at a year from today. Gossamr warns you 14 days before.

The token is kept in the macOS Keychain under `dk.alfhen.gossamr`. When it expires or is revoked, a banner offers **Make a new token**. If the page doesn't fill in, **The page didn't fill in** lists the scopes to tick. "Try it with sample data" skips all of this.

## Connecting GitHub

Gossamr signs in through `gh`. It never asks for a GitHub token and never stores one: each time it needs a token, it asks `gh` for the one it holds for that account. A token an earlier version saved stays in the Keychain until that account is connected through `gh`; **Remove** deletes it at once.

1. Install `gh` (`brew install gh`) and run `gh auth login -h github.com` in a terminal.
2. In Gossamr, open Settings › Connections and choose **Connect GitHub**. It lists the accounts `gh` knows. For an account that isn't there yet, **Another account** shows the login command, with Copy and Open Terminal.

The token is only as safe as `gh` keeps it: in the macOS Keychain, or in plain text in `hosts.yml` if you signed in to `gh` with `--insecure-storage`. Gossamr also gets every scope `gh` holds. If `gh` has no login for the account, or isn't installed, the connection shows **Not signed in** or **Not found** with the command to run in its details, and a banner says so. Gossamr never signs out or switches accounts. **Open Terminal** opens Terminal running `gh auth login -h github.com` for you to finish, and signing in a new account makes it `gh`'s active account; `gh auth switch` changes it back. Your agents run with your shell environment and git setup, so they clone and push with whatever credentials git and `gh` find there (git's credential helper or SSH key, an exported `GH_TOKEN`, otherwise `gh`'s active account). That may not be the account a Gossamr connection reads, and when it is the same account, GitHub's audit log can't tell what you approved in Gossamr from what an agent did on its own.

## The workspace

The app opens in the workspace, with Inbox, Board, List and Work over the local cache, with a rail of projects and saved views, tabs, a command palette (`⌘K`), a peek sheet for one ticket and Pip, the assistant, docked on the right (`⌘J`). `⌘R` (View > Reload) reloads the window; it only redraws the page and restarts nothing in the app. Everything is read from the local cache, so it starts with the last data when offline. The assistant only proposes: dropping a card on a column, a comment written in the peek sheet and Pip's suggestions all become drafts, and nothing is written to Jira until you approve one.

- **Board:** one section per project with that project's own statuses. Jira only reveals the moves open to a ticket one ticket at a time, so when you pick a card up the app asks Jira where it can go and dims the other columns.
- **Workstreams and agents:** a workstream is the work on one ticket. You or Pip open one, and inside it Pip starts Claude Code agents, each with a role Pip names (planner, builder, reviewer or anything else). **Work** lists every workstream with its agents, their state, role and last message. Its one filter shows Needs you. Agents report in prose; Pip reads the report on the wake and writes any drafts. There are no automatic drafts or required report headings. Pip can draft a comment or a description rewrite with a collapsed `Gossamr Plan` section. You see a before-and-after diff, and approve, edit, skip or discuss it with Pip. Pull requests open on GitHub. Review drafts keep their diff hunks in Gossamr, name the reviewer and the commit it read; only your approval posts a comment review. See [the product guide](docs/product.md) for the draft rules and safety boundaries.
- **Settings:** your connections (Jira and each GitHub account), with each one's status, name, last sync and watched projects or repositories, and how many agents run at once. The switch on a connection turns it off: Gossamr stops syncing it, its items leave your views, Pip can't see it, and its drafts wait until you turn it back on. Agents still clone and push through `gh` and git, and runs already queued still start. What it cached is kept. **Remove** on a connection deletes what Gossamr cached for it and the token it stored, and closes the drafts that target it. Your `gh` login stays as it is.
- **Errors** that don't block anything (a failed sync, a move that couldn't be checked) appear as a toast in the corner.

### Mock mode

`pnpm dev` runs the workspace in a browser on built-in sample data: four projects with different workflows, drafts, and a scripted Pip that answers a few requests and drafts a move or comment. No Jira and no Claude are involved.

### Not yet verified against a live Jira site

The Jira adapter was written against the REST v3 documentation and tested with response bodies shaped like the documented ones. Sign-in with a scoped token, the cloud id lookup and the three scopes have been checked on a real site ([Scope check](docs/real-jira-trial.md#scope-check)), but the writes below have not been tried on real tickets, so these are the places to look first if something misbehaves. [docs/real-jira-trial.md](docs/real-jira-trial.md) is the checklist for trying them on a real site, in a safe order:

- Creating an issue, updating fields, linking issues and creating sub-tasks (`issue/createmeta/{project}/issuetypes`, `issueLink`). Link direction follows Atlassian's own convention (the blocking issue is the inward one).
- Reading a project's statuses (`project/{key}/statuses`) and the project list (`project/search`) for board columns.
- Approving a move: the status id on the card is matched to Jira's transition id at approval time, and Jira may refuse it if the workflow has required fields.
- Reading comments from the API (`issue/{key}/comment`) for the peek sheet, and rendering their formatting; media and some panels show as plain text.
- Rewriting a ticket's title and description (`PUT issue/{key}`) from a draft you approve. The description goes to Jira as ADF built from Markdown, so images, tables, panels and macros in the old one become plain text (the draft says so, and Jira keeps the old text in the issue history). The ticket is read again just before the write, and one edited in Jira since the draft was made is refused. Jira can't make the write conditional, so an edit made in the moment between that read and the write can still be overwritten.
- Pip narrowing the view (`set_view_filter`, sent to the page as a `view` event of Pip's turn).
- Bulk moves offer every status and rely on Jira refusing the ones a ticket can't reach.

## Pip and agents

Press `⌘J` from any screen to open Pip, the drawer on the right (`Esc` closes it). You always talk to Pip, in General or in a workstream's own conversation. Pip sees every workstream and agent run, and drives the work: it opens and closes workstreams, starts, messages and stops agents, answers their questions or passes them to you, and drafts what should go to Jira or GitHub.

Pip runs your installed Claude Code headlessly (`claude -p`) with your existing login, so it uses your subscription. It runs Sonnet at medium effort, whatever your Claude Code default is, in an empty folder inside the app's data directory. It does not load your CLAUDE.md, memory, skills, hooks, plugins or other MCP servers, and it has no built-in Claude Code tools: it can't read local files, run commands, browse the web or write files. It acts only through tools on a local MCP server the app runs. It can't change Jira or GitHub either: comments, transitions, subtasks, new tickets, new titles or descriptions and pull request reviews come back as drafts you approve, edit or skip.

Agents are Claude Code background sessions (`claude --bg --worktree`) with your own Claude setup: your settings, CLAUDE.md, skills and MCP servers. Gossamr adds only its own MCP server, with four tools (report, ask, read_workstream and read_ticket), and a short brief: the agent's role, the ticket as data, and to push only its own branch, open draft pull requests and never merge. When an agent asks for a permission, its run shows the command and an **Open in Terminal** button, where you answer Claude yourself.

Claude asks once per folder whether to trust it, because a cloned repository's own hooks, MCP servers and settings run with the agent. Gossamr never edits Claude's config or answers that question for you. If a folder isn't trusted yet, the run says so with a **Trust this folder in Terminal** button that opens Terminal there with `claude`. Accept the question, close Terminal, and Retry the run.

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
