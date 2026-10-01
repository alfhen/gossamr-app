# Claude CLI findings for background agent runs

Verified against Claude Code 2.1.286 on macOS. The wrapper is `src-tauri/src/runs/`; it is the only code that runs `claude` for agent runs. Pip's headless run in `claude/mod.rs` is separate and untouched.

## Commands

| Command | Behaviour |
|---|---|
| `claude --bg [--name N] [--worktree W] [--append-system-prompt S] -- "<prompt>"` | stdout: optionally `Starting background service…`, then `backgrounded · <8 hex> · <name>` (no trailing ` · name` without `--name`), then four hint lines. Exit 0. The `--` separator is accepted and keeps a prompt that starts with a dash from being read as a flag. `--session-id` is ignored with `--bg`. |
| `claude agents --json [--all]` | JSON array, about 160 ms, never starts a daemon. Without `--json` it opens a TUI: never call it. |
| `claude stop <id>` | Prints `stopped <id>` plus a hint. The session lists as `state:"stopped"` with no pid under `--all`, and the worktree is kept. |
| `claude rm <id>` | Prints `removed <id>` and the worktree path. Removes the worktree and its `worktree-<name>` branch. |
| `claude auth status --json` | `loggedIn`, `authMethod`, `apiProvider`, `configDirectory`, `projectsDirectory`, and also email and org fields, which the wrapper does not read. Signed out it still prints the JSON but exits 1. |
| `claude --version` / `--help` | `2.1.286 (Claude Code)`; help lists `--bg` when supported. |

All of them run with stdin from `/dev/null`, because the CLI otherwise reads stdin as a prompt.

## What the real run showed (scratch config, signed out)

- A fresh `CLAUDE_CONFIG_DIR` is not logged in and refuses an untrusted folder: exit 1, stderr `Workspace not trusted. Run `claude` in <path> once and accept the trust prompt, then retry.` Trust is written to the scratch `<config>/.claude.json` as `projects.<path>.hasTrustDialogAccepted`, which the tests do and the app never will.
- A signed-out session is listed as `state:"blocked"`, `status:"idle"` with a pid, and its `state.json` has `needs:"login required — run /login"` and `tempo:"blocked"`. `output` and `children` are `null`, so a null where a list or object is expected must be tolerated.
- `state.json` also holds `intent`, `providerEnv`, `cwd`, `linkScanPath` and other internals. The wrapper reads only the whitelisted fields. `updatedAt` is an ISO string in 2.1.286; old fixtures use a number, so timestamps are kept as text.
- `timeline.jsonl` lines are `{at, state, detail, text}`.
- **The public `cwd` is not the worktree at first.** Right after launch the session is listed with `cwd` equal to the clone root; it changes to `<clone>/.claude/worktrees/<name>` once the worktree exists (observed after 0.8 s to about 6 s). Matching a run by `cwd == expected_worktree` therefore fails for the first seconds, and a launch that is still waiting must not be reported as "not found" until the worktree window has passed. Matching needs the real path: `/var/...` is reported as `/private/var/...`, so compare canonicalised paths.
- **`claude rm` straight after `claude stop` is refused** for a few seconds (exit 1, explanation on stdout, stderr empty): "A Claude Code lock on the worktree names a process that is still running". It succeeds after about 4 s. The wrapper puts the stdout text into the error when stderr is empty. Anything that removes a run needs to retry.
- The scratch daemon was started by the first `claude --bg` (`Starting background service…`), was reparented to launchd, and exited by itself within 25 s of the last session being removed.

## Spike results (PR 1 brief)

| Spike | Result |
|---|---|
| (a) launch, list by worktree path, stop, rm | Passes in a scratch config (`real_launch_is_listed_by_worktree_then_stops_and_removes`), with the two timing findings above. |
| (b) permission prompt shape, `--permission-mode manual` | Not run. It needs a signed-in config, and the rules for this PR allow only a fresh scratch config. Shape in the fixtures comes from the plan's earlier capture: `state:"working"`, `status:"waiting"`, `waitingFor:"permission prompt"`, `needs:"approve Bash: <command>"`. To run by hand: sign in to a scratch config with `claude setup-token` or `/login`, then launch with `--permission-mode manual` and a prompt to `touch` a file. |
| (c) worktree base | Passes (`real_worktree_starts_at_the_clones_current_head_not_main`): with the clone on branch `feature` two commits ahead of `main`, the worktree's HEAD equals `feature`'s HEAD, not `main`'s. |
| (d) environment | Passes (`real_daemon_gets_the_captured_environment_and_nothing_added_after_the_capture`), run as `env -i HOME=$HOME PATH=/usr/bin:/bin`. The capture from `/bin/zsh -ilc` returned the full interactive PATH, including entries that only `.zshrc` adds (Herd, LM Studio, nvm), against `/usr/bin:/bin` for the test process. The scratch daemon's environment (read with `ps eww`) had exactly the captured PATH, and a variable set in the process after the capture did not reach it. Not done: a comparison with a daemon started from Terminal, which is the same shell and the same rc files by construction. Note that the capture inherits the app's own environment as the shell's base, so anything exported in the environment Gossamr was started from is in the capture. |
| (e) stop then `--bg --resume <sessionId> "say OK"` (U2) | Not run, for the same reason as (b): it needs a signed-in session to show whether the message is delivered. The fake CLI implements the behaviour the plan describes (a running session gets a copy; a stopped one keeps its id and takes the message as its name), and the wrapper tests cover that. U2 stays open. |

## Running the real tests

```
GOSSAMR_SCRATCH=<folder> cargo test real_ -- --ignored --test-threads=1
env -i HOME=$HOME PATH=/usr/bin:/bin GOSSAMR_SCRATCH=<folder> <test binary> real_daemon --ignored --nocapture
```

Each test creates its own config directory and repository under `GOSSAMR_SCRATCH` (default: the system temp folder), trusts the repository in that scratch config only, and on exit stops and removes what it started, waits for the scratch daemon to exit, and deletes the folder. They never read or write the real `~/.claude`.

## Fixtures

`src-tauri/test-fixtures/agents/` holds hand-sanitised files that follow the field structure above, with neutral names and paths: `agents-2.1.286.json` (working, blocked with a question, permission-waiting, done, stopped, an old blocked session, two interactive), `agents-unknown.json` (unknown state, unknown fields, mistyped fields, non-objects), `state-question.json`, `state-permission.json`, `state-done.json`, `state-old-2.1.236.json`, `timeline.jsonl`. They were written from the shapes recorded in the plan and checked against the scratch run's output, not copied from the person's own sessions, which were not read. `intent` and `providerEnv` appear in them with marker text so tests prove they are never read.

## Fake `claude`

`src-tauri/test-support/fake-claude.sh` is driven by `FAKE_CLAUDE_SCENARIO` (a `key=value` file; its keys are listed at the top of the script). It keeps sessions and `jobs/<id>/` files next to the scenario, records every call's cwd and arguments in `calls.log` and the names of its environment variables in `env.last`.
