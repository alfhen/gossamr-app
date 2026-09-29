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

## Ask Claude

Press `⌘J` on a ticket to ask Claude about it. The app runs your installed Claude Code headlessly (`claude -p`) with your existing login, so it uses your subscription and loads your CLAUDE.md, memory and skills. You can continue this ticket's last session, continue any recent CLI or desktop session, or start a new one in a recent folder. It runs Sonnet at medium effort, whatever your Claude Code default is.

Claude can read the ticket through a local MCP server the app runs, and read code and git history in the session's folder. It can't write files or change Jira: comments, transitions and subtasks come back as cards you approve, edit or skip.

## Development

```bash
pnpm install
pnpm tauri dev
```

`pnpm dev` runs only the web UI in a browser, which is handy for layout work.

Checks that CI runs:

```bash
pnpm typecheck && pnpm test
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
```

Two tests run the real `claude` CLI and are skipped by default. With Claude Code installed and logged in:

```bash
cd src-tauri && cargo test -- --ignored
```
