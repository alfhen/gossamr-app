# Claude CLI findings for background agent runs

Verified against Claude Code 2.1.286 on macOS. The wrapper is `src-tauri/src/runs/`; it is the only code that runs `claude` for agent runs. Pip's headless run in `claude/mod.rs` is separate and untouched.

The kind-specific briefs, structured reports, heading parsing and automatic drafts described in historical checks below are no longer runtime behaviour after simplification step 6. Agents now report `{status, note}` in prose; Pip drafts from those reports. The CLI observations about trust, background sessions, MCP, stopping and resuming still apply.

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

## Folder trust (Gossamr never writes it)

- Claude asks once per folder because a cloned repository's own hooks, MCP servers and settings run with the agent. Gossamr does not write `projects.<path>.hasTrustDialogAccepted` into `.claude.json`, or bypass the prompt in any other way; the person answers it in Terminal.
- A refused launch is recognised from `Workspace not trusted` on stderr (exit 1) and stored as the run's `failure` `untrustedFolder` with the folder. Retry looks for a session first and launches the same approved run again, so the approved prompt and digest are unchanged.
- Before approving, the checks read `.claude.json` read-only (`<config dir>/.claude.json`, or `.claude.json` beside a default `~/.claude`) and look for `hasTrustDialogAccepted: true` on the clone or a folder above it. A missing, unreadable or differently shaped file says nothing. A folder it doesn't list gets an amber row, never a red one, because the file's shape is Claude's to change: Start stays available, and the refused launch is the authority.
- Trust this folder opens Terminal in the clone running plain `claude`, from a script named by a digest of the folder, only for a folder under `~/Code`, `~/Developer`, `~/src` or `~/Gossamr/agents`. Not yet checked against a real signed-in Claude: the shape of `~/.claude.json` as read by the checks, and that trust given to a clone covers worktree sessions started by Gossamr (the scratch test above covers the latter).
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
| (e) stop then `--bg --resume <sessionId> "say OK"` (U2) | Passes with a settle time: see "Resume after stop" below. |

## Launcher check (PR 4)

`real_approved_run_launches_into_its_worktree_is_adopted_by_retry_then_stops_and_removes` runs `RunService` against the real CLI in a scratch config. The scratch config is signed out, which the service refuses before launching, so the test reports it as signed in to exercise the launch itself. It passes: the run gets a short id, the session is listed at its worktree path, `retry_launch` on a run whose answer was "lost" adopts that session without a second `--bg`, and `stop` then `rm` removes it (`rm` was refused for about 4 s after `stop`, as above). Not covered: a signed-in session doing model work.

## Tracker check (PR 5)

`real_signed_out_session_is_tracked_as_a_system_block_then_stops_and_a_foreign_session_is_left_alone` polls a real signed-out session in a scratch config: the run goes `Working`, then `SystemBlocked` with `needs` `login required \u2014 run /login` (public JSON and `state.json` agree), the session id is filled in from the listing, `jobs/<id>` is measured (about 2 KB), `Stop` marks it `Stopped`, and a second session that was not in the run index stays untouched. The timeline of a signed-out session had no lines. Not checked against a signed-in session: a permission prompt (`NeedsPermission`) and `Done` come from the fixtures only.

`real_fresh_clone_is_refused_until_trusted_then_its_worktree_session_starts` (U5, needs the network) clones `octocat/Hello-World` into a scratch `~/Gossamr/agents/<owner>/<repo>`: `--bg` there is refused with `Workspace not trusted`; after the scratch config trusts that one folder, the launch succeeds and its session is listed in `.claude/worktrees/<name>` and runs (state `working`, no trust complaint), so trusting the clone covers its worktrees and one trust step per repository is enough. Observed once on 2.1.286.

Attach in Terminal: `open -a Terminal <file>.command` was run once from the build sandbox. Terminal started but the script's marker file did not appear within 15 s, which may be a first-run prompt for a file created by a sandboxed process (it carries `com.apple.provenance`). The file Gossamr writes has to be tried by hand from the app (U11); the fallback is `osascript` with the same validated inputs.

## Kinds check (PR 11a)

Not run, because both need a signed-in session spending the person's own Claude account, and the real tests only use a scratch config that is signed out:

- **U12** (do hooks in a checked-out pull request's `.claude/settings.json` fire inside the worktree): to run by hand, make a scratch repository whose `.claude/settings.json` has a `PreToolUse` hook that touches a marker file, launch `claude --bg --worktree` with a prompt that makes one tool call, and look for the marker. Until it is run, assume they fire. Review is same-repository only either way (`CodeChange::is_same_repo`, checked at draft, approve and launch).
- **U9** (does `--restricted` make an Investigate run useful, and does it work with `--bg`): not offered anywhere yet.

## Resume after stop (PR 12c, Claude Code 2.1.287)

`real_stop_then_resume_continues_same_session` (ignored; the person's real config, `~/Code`, one prompt that uses no tools) launches a session that asks "Shall I continue?", waits for `blocked`, runs `claude stop`, waits for `stopped`, then `claude --bg --resume <sessionId> -- "<answer>"` with no other flag. When it continues the session, the listing keeps the same `id`, `sessionId` and `name` (no copy), `timeline.jsonl` gets the answer, the session ends `done` and `output.result` holds the reply. stdout is the launch shape, `backgrounded \u00b7 <id>[ \u00b7 <name>]`: with the same id when the session was continued, and a new id with no name when a copy was started.

- Resumed immediately after `stopped` is listed, the first runs started a copy (2 of 3). With 3 s between `stopped` and the resume it continued the session in 5 of 5 runs, and with 6 s in 4 of 4. Gossamr waits 5 s and still checks that the id that comes back is the run's: a different id means a copy, which is stopped and reported.
- `--` before the message is accepted, as with launch.
- Not tested: a session stopped in the middle of a tool call, a resumed `needsPermission` session, and whether the guard text still applies after a conversation has been compacted.

## Answering a permission prompt (Claude Code 2.1.296, read from --help only; Gossamr's classifier and buttons removed in step 5)

Read from `claude --help` and `claude agents --help`, `claude attach --help`, `claude logs --help`, `claude respawn --help` and `claude stop --help` of the installed 2.1.296; no session was started and nothing went over the network. There is no supported way to answer a pending permission prompt of a background session from outside it:

- `claude agents` only lists (`--json`) or opens its own interactive screen; it has no respond or approve subcommand.
- `claude attach <id>` is interactive: it is where a person answers the prompt, in Terminal.
- `claude logs` only reads, `claude respawn` restarts a session, `claude stop` stops one.
- `--permission-prompt-tool` and `--permission-prompts host|none` apply only with `--print`, which `--bg` rejects.
- An allow rule on resume isn't usable: any flag on `--bg --resume` makes `claude` start a copy, and a copy is a new job without the run's saved flags (see "Resume after stop" and the agent tools section). `--allowedTools "Bash(<exact command>)"` on resume was therefore not used, and `ClaudeCli::resume` still passes no flag.

What Gossamr did until step 5 of the simplification proposal, which removed `runs/permission.rs`, the Deny and Allow-once buttons and the read-only kinds (an agent now launches with the person's own permission mode and settings, and a prompt is answered in Terminal):

- **Deny** is delivered for real, by the same mechanism as an answer: the session is stopped (which drops the pending prompt, so the request never runs) and woken in place with `--bg --resume <session id> -- <reminder + message>`. The message is fixed text that quotes nothing of the request, since the agent knows what it asked: the person did not allow it, don't run it or anything that does the same, carry on without it and say so in the answer if the work can't be finished. The exact command is recorded only in the run's log and the workstream audit. A wake that starts a copy is handled as for an answer (stopped, and removed for a read-only run). If the wake fails, the run is left stopped with the denial kept to send again. Deny is offered for every prompt, read-only runs included.
- **Allow once** can't be delivered by Gossamr, so it is "Allow once in Terminal": Gossamr checks the policy below, records the person's choice with the exact command (the run's log and the workstream audit, actor person, action `permission_allowed_in_terminal`), and opens Terminal on `claude attach <id>`. The page copies the exact command, and the person picks Claude Code's own one-time "Yes" for exactly that request. Gossamr never stops or resumes the session for it and writes no allow rule anywhere. The choice is forgotten once the run moves past that prompt or asks something else.

The policy (`offer`, shared fixtures in `src/lib/permission.fixtures.json`):

- Allow is offered only for the exact tool and command the agent asked for, never a pattern, and only when the request reached Gossamr whole: not for one masked by redaction, cut at the 500 characters the tracker keeps, holding a NUL, or not in the `approve <Tool>: <command>` form.
- A read-only run (its kind, or the restriction it was launched with) never gets Allow, whatever the command: it launches in `dontAsk`, which refuses anything not on its exact allow list, and its deny list beats that. The page says "This run is read-only: Claude Code refuses this." and offers only Deny and Stop.
- A Build gets Allow except for what Gossamr itself forbids it, checked on each command of a Bash line (split on `&&`, `||`, `;`, `|`, `&` and newlines; any `$(`, backtick, `<(` or `>(` is refused outright): a push of anything but `git push [-u|--set-upstream] origin worktree-<name>` or `origin HEAD:worktree-<name>` word for word, and any push at all when the Build wasn't approved to push (a bare `git push` and `origin HEAD` are refused too, as they push wherever the checked-out branch is or tracks); `gh pr create` without `--draft` or without push approved; `gh pr merge`, `ready`, `review` and `close`; and Gossamr's own `mcp__gossamr` tools.
- Beyond those rules, a Build's Bash command is offered Allow only when it is plain (`plain` in `runs/permission.rs`): every command in it starts with one of a short list of programs that run nothing else (`ls`, `cat`, `grep`, `rg`, `find`, `cp`, `mv`, `mkdir`, `git status`/`diff`/`log`/`add`/`commit`/`fetch` and the like, `gh` reads and draft pull requests), with no variable, glob, brace, redirect, subshell, escape, comment or `NAME=value` outside quotes, no variable or escape inside double quotes, none of the options that make a plain program run another (`find -exec`, `rg --pre`, `git fetch --upload-pack`, `ext::` and the like), and paths for `cd`, `cp`, `mv`, `rm`, `mkdir` and `touch` that stay inside the checkout. A file tool (Edit, Write, MultiEdit, NotebookEdit) is offered Allow only for a path inside the checkout: relative, or under the run's worktree, with no `..` and no home directory. Any other tool, such as a web fetch, is "unchecked" too. Anything else, a script, an interpreter or a package manager included, is "unchecked" and answered in Terminal. A list of what to refuse can always be talked around (a glob for `.git`, an interpreter the list doesn't name); a list of what to allow can't.
- Allow and Deny are the person's alone. Pip has no tool for them (`run_tools_are_read_only`), and the supervisor's auto-start never answers a prompt (`autostart_and_pip_never_answer_a_permission_prompt`). Answering changes nothing that was approved: the digest and spec stay as they were.

To check by hand, with a signed-in session (not done yet):

1. Whether a session stopped while it waits on a permission prompt and resumed in place treats the prompt as interrupted (the request isn't run) and reads the denial as the next turn. Expected from the stop-and-resume runs above, which never covered a `needsPermission` session.
2. Whether a later CLI offers a way to answer a background session's prompt from outside it (a respond subcommand of `claude agents`, or `--permission-prompt-tool` without `--print`). If one appears, Allow once can be delivered in place and the Terminal step dropped.

## A finished run's final answer (Claude Code 2.1.287)

Seen on one real Triage run (CA-271) in the person's own config, reading structure and lengths only:

- `jobs/<id>/state.json` `output` has the single key `result`: Claude's own one-line summary of the run (126 characters), not the agent's last message. Everything built on it (`For Jira:`, `New ticket:`, `Subtasks:`) therefore never saw the agent's sections.
- `timeline.jsonl` had two lines. The `done` line's `text` was the full final message (3977 characters, byte-for-byte equal to the transcript's last assistant text); the `working` line had only a `detail`. Whether the done text is capped for much longer answers is not known.
- The transcript is `<projectsDirectory>/<folder>/<sessionId>.jsonl`. `<folder>` is the session's worktree path (`worktreePath` in `state.json`, not `cwd`, which was the clone root) with every character outside `[A-Za-z0-9]` replaced by `-`, so `/.claude/` becomes `--claude-`. `sessionId` is the listing's `sessionId`. For a very long path Claude may shorten the folder name, so a missing computed path is followed by a look for `<sessionId>.jsonl` in each folder of `projects`.
- One JSON object per line. Types seen: `user`, `assistant`, `attachment`, `system`, `last-prompt`, `file-history-snapshot` and several bookkeeping types. An assistant API message is written as one line per content block (`thinking`, `text`, `tool_use`), all with the same `message.id`; the final answer is the `text` block(s) of the last assistant message, followed only by `system` lines. Tool results are `user` lines. Subagent lines carry `isSidechain: true`.
- Gossamr reads the last 2 MB of that one file, takes the text of the last assistant message and drops everything else; it never lists transcripts, and a symlinked transcript is not followed. If the transcript cannot be read it falls back to the timeline's `done` text (only when it differs from the summary), and failing both keeps the summary and says so (`Run.result_complete = false`).
- No real-CLI test: a transcript with model output needs a signed-in session, and the real tests only use a signed-out scratch config. The path computation, the tail read and the message selection are covered with fixtures and by `fake-claude.sh` (`transcript=` in the scenario file writes a transcript the way Claude does).

Timeline events: `claude` writes millisecond times (`2026-10-02T12:22:45.174Z`) and Gossamr stores whole seconds, so a line was never recognised as stored and was appended again on every poll (the run sheet showed one command eight times). Times are now cut to whole seconds before comparing.

## A session left open at its prompt (Claude Code 2.1.287)

When someone attaches (`claude attach <id>`, which "Open in Terminal" runs), Claude keeps the session's process alive at the prompt after the turn ends. The session then never reports `done`. Observed on a real Build run (CA-271) and on other sessions in the person's config, reading only keys and values of `state`, `status`, `waitingFor`, `kind`, pid presence, `state.json`'s non-private keys and the shape of `timeline.jsonl` lines (never message text, `intent` or `providerEnv`).

Every `(state, status)` pair in `claude agents --json --all` at the time:

| state | status | pid | What it was |
|---|---|---|---|
| `working` | `busy` | yes | A turn is running, attached or not. `state.json` `tempo:"active"`. |
| `working` | `idle` | yes | **Attached, and the turn has ended**: the session sits at its prompt. `tempo:"idle"`. Seen on the CA-271 Build run (the bug) and on another session of the person's. |
| `blocked` | none | no | Asked a question or needs login (`needs`). Unattached, nothing running. |
| `done` | none | no | Finished and unattached (the process exited). The common case. |
| `done` | `idle` | yes | Claude's own `done` followed by an attach: the process is alive again. |
| none | `busy` | yes | An interactive session (`kind:"interactive"`, no `id`): not a background run. |
| `working` | `waiting` | yes | Permission prompt, with `waitingFor:"permission prompt"` (from the earlier capture; not seen live). |

What marks a finished turn in the job files, for a `working`/`idle` session:

- `state.json` stays `state:"working"` and has `tempo:"idle"`; `output` is `null` (only a real `done` fills `output.result`) and `lastTerminalAt` is `null`.
- `timeline.jsonl` never gets a `done` line. The turn's answer is written as an ordinary `state:"working"` line that has `text` (2718 characters for the CA-271 run: its final message) after lines that only have a `detail` (commands, the person's own messages). A question is the same shape but with `state:"blocked"`. A follow-up typed by the person is a new line with a `detail` and no `text`, so a newest line without `text` means a turn is running.
- `state.json` `inFlight` counts background work: `{tasks, queued, kinds, drainableMonitors}`. A session that ended its turn while `tasks` was 2 (teammates) was `working`/`idle` too, and wakes by itself when they finish, so that is not finished.

The rule Gossamr uses (`runs/state.rs`): `state:"working"` with a pid and `status:"idle"` is **Done** when the newest timeline line has text and is not a question, `inFlight` is 0, and the same was seen on two polls in a row (a poll apart: 4 s while anything runs). The listing alone is not enough: a freshly launched session and the moment between tool calls can also look idle, and the timeline line is what tells "answered" from "not started". `status` busy, a permission prompt, `blocked`, or a newer line without text all keep or put the run back in its live state. The answer is read the same way as for any done run (transcript tail, then the newest timeline line with text).

A finished run is watched for 6 hours after it ended (one listing per poll, no job files unless the session is alive). It goes back to Working, or to the needs-you states, only when its session is listed with a pid, `working` or `blocked`, and not idle. Going back sets `continuedAt`: from then on the time and token limits no longer apply to it and finishing again makes no second notice (a draft is made only if none exists, so none is duplicated). A finished run whose session is still alive and idle is removed by Clean up with `claude stop` first, then `claude rm`; Stop all only touches runs that are not finished.

Not verified: the attached `working`/`busy` to `idle` flicker between tool calls (if it exists the two-poll rule and the timeline condition cover it); a permission prompt on an attached session after a follow-up; what the listing shows for a session whose terminal was closed without stopping it.

## Plan mode, and read-only runs enforced by the permission mode (Claude Code 2.1.288, 2.1.296; enforcement removed in step 5)

Read from `claude --help` (and, for 2.1.296, the binary) only; nothing was launched, because a run needs a signed-in session spending the person's own account.

- `--permission-mode <mode>` is listed with the choices `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk` and `plan`. The help says nothing about `--bg` and `--permission-mode` together; the 2.1.296 binary's own `--bg` checks accept them (below).
- **Plan runs do not use plan mode.** Plan mode only makes writes ask, and a plan-mode session ends by asking to leave plan mode, which lists as a permission prompt (`needsPermission`), never as `done`: an auto-started chain would never see the run finish.
- **History: read-only kinds were enforced from Phase 6 until step 5 (Claude Code 2.1.296, read from `--help`, `claude agents --help` and the binary, and checked against the real CLI).** Investigate, Triage, Plan, Review and Verify are launched with `--permission-mode dontAsk`, `--setting-sources ''`, `--strict-mcp-config`, one `--allowedTools` list and one `--disallowedTools` list (`RunSpec::read_only` in `domain/run.rs`, passed by `SystemCli::launch`). `--bg` rejects only `--print`, a file-form `--agents`, an unaccepted `bypassPermissions` and an un-opted `auto`, so these flags combine with it, and all of them are in the binary's list of saved respawn flags. `dontAsk` denies whatever is not pre-approved instead of stalling under Needs you, which covers redirects and any command Claude Code can't prove only reads; its vetted read-only commands (`git log/diff/show/status`, `gh pr view/diff/checks`, and so on, each with a checked flag set) still run. Pre-approved would include every allow rule in the person's settings and in the repository's `.claude/settings.json`, and a prefix deny list can't cover those (`Bash(git *)` allows `git -C . commit`, `Bash(python3 *)` allows `python3 -c`), so a read-only run reads no user, project or local settings file (`--setting-sources` with no source; managed settings still apply) and loads only the MCP servers Gossamr passes. Checked with `claude -p` and the same flags: with a user `settings.json` allowing `Bash(python3 *)` and `Bash(git *)`, `python3 -c` writing a file and `git -C . commit` ran without `--setting-sources ''` and were refused with it; `git fetch origin pull/7/head`, `git checkout --detach <sha>` and `npm test` ran, and `npm test -- --version` was refused. The deny list (Edit, Write, MultiEdit, NotebookEdit, and Bash prefixes for git history, remote and config writes, file changes, package installs, GitHub writes, `curl` and `wget`) stays as a second line and beats managed allow rules too. It has no `mcp__gossamr` rule, because a deny rule would beat the allow rule for the run's own four tools on that server. Every allow rule is exact and named in the prompt (`git fetch origin <base>`, `git checkout --detach origin/<base>`, for a Review, and a Verify after a passing one, `git fetch origin pull/<n>/head` and `git checkout --detach <sha or FETCH_HEAD>`, and for Review and Verify the test commands `cargo test`, `pnpm test`, `npm test`, `yarn test`, `pytest` and `go test ./...` with no argument), because a prefix rule has no flag analysis (`git log --output=<file>` writes, `go test -exec` and `cargo test --config` run anything, `pytest --basetemp` deletes). A Verify started after a passing Review that pinned a commit tests that commit of the pull request (`git checkout --detach <sha>`); a Review without a pinned commit starts no Verify, and every other Verify tests the code on its base branch. The rules and the sentence added to the guard are part of the digest, so a changed rule is a changed prompt. A background job keeps these flags and a `--bg --resume <id>` that continues it in place reapplies them, so `resume` sends no flags; a resume that starts a copy runs without them, so Gossamr stops and removes the copy of a read-only run. A `claude` whose help lacks any of these flags fails a read-only launch with its own message (and a red setup check); it never launches one without the restriction. Build, and the fix rounds sent to it, keep the person's own permission mode and settings as before. `--restricted` was not used: it would drop the settings files too, but removes Bash and the other code-running tools unless `--tools` names each back. What reading no settings costs: the person's own `env`, `apiKeyHelper` and model settings don't reach a read-only run. Still to run by hand: the ignored `--bg` real-runtime tests (`real_read_only_*`); in a sandbox whose provider is managed by the host, background sessions never start model work.

## Historical: a Plan run leaves a description update (removed in step 6)

When a Plan run finishes with its full answer and `draft_on_finish` is on, `RunService::draft_for` also stores one `Intent::Rewrite` draft (origin: the run, created by the person's own side, never Autopilot) next to the status comment. It is assembled by `inbox/plan_description.rs`, with no model:

- The description is the cached document as it is, plus a final `Gossamr Plan` heading (level 2), a line naming the run and its end date, and the answer without its closing `For Jira:` note (`plan_without_note`: scrubbed, secrets masked, tags stripped). The plan's own headings are moved below the section heading so they can't end it. A ticket that already has a section with that heading (any level, any case) has it replaced where it stands, and what follows it is kept.
- The plan is cut at a paragraph or sentence, with a note naming the run, to the smaller of 12,000 characters and what is left of Jira's 30,000 for the whole description. With less than 1,000 characters of room no draft is made and the sheet says the plan can go as a comment instead.
- The draft's `from` is the description it was written against, so `guard_rewrite` refuses an approval after the ticket changed. A draft is skipped without notice when the description already holds the same text or when this run already has a draft for the same plan (any state); a waiting draft for an older plan, this run's or another run's, is retired when a newer one replaces it, unless the person edited it: an edited draft stays, no second one is made beside it, and the sheet's own button says so until it is approved or skipped.
- No draft, and a reason on the sheet, when the tracker can't edit text, the ticket isn't cached, or its description is stored only as a plain string. 'Draft the plan as a comment' stays.
- Agents are shown the ticket through `ticket_snapshot`. The `Gossamr Plan` section is taken out of the description's 3,500-character budget and given its own (8,000, so the block holds at most 18,000 instead of 10,000 when the section is there; a ticket without it is unchanged). A Build that carries the plan as its own approved part is shown a one-line pointer instead of the same text twice; Review and Verify see the section.

The Plan instruction now also asks for plain Markdown (a short heading per part, numbered steps, bullet lists, no tables, HTML or images), which is what the description converter keeps. Unverified: how a real Jira renders the converted section, and what a real plan run's answer looks like in practice.

## Build opens a draft pull request, and a Review can follow it (to hand-verify)

Nothing here was run against a real `claude`; the scripted CLI only proves the prompt that is sent. A person with a signed-in session should check, in a scratch repository with a GitHub remote:

- That a `--bg` Build agent told to push and run `gh pr create --draft` really creates a draft pull request, and puts its link in the `For Jira:` note. Whether the agent obeys is a request, not a lock, and depends on the person's permission mode: in a mode that asks, a push or `gh` call stops the run under Needs you. (A Build is the one kind with no launch restriction; the read-only kinds are enforced, see above.)
- That `gh` is authenticated inside the agent's worktree: the agent gets the shell environment Gossamr captured, so `GH_TOKEN`/`GITHUB_TOKEN` or the keychain-backed `gh auth` login must reach it, and `gh pr create` must find the remote from a worktree under `.claude/worktrees`.
- That repository hooks (`pre-push`, commit hooks) behave in a worktree and in the checkout a Review does (`git fetch origin pull/<n>/head`), and do not run code from the pull request with more reach than the person intended. A Review only reads, but a hook runs on whatever it checks out.
- That a Review of a draft pull request works (`gh pr view` and `gh pr diff` on a draft), and that the pinned commit is still the pull request's head when the Review starts.

## The agent tools (one MCP server)

Every run's session is given Gossamr's one MCP server (`agent/mcp.rs`) with four tools of its own, served on a loopback port by `agent/agent_tools.rs`. Pip's tools are on the same server; neither kind of token opens the other's tools.

| Tool | What it does |
|---|---|
| `report` | Records the run's result as data (`run_reports`, apart from the run's blob). The same validated fields as before, under the new name. The first report stands until a call says `revise: true`. |
| `ask(question)` | Waits for the answer in the same call. While it waits, the run reads as asking that question, and the supervisor wakes Pip as for any question. An answer through `runs_answer` or an approved answer draft is the call's result at once, with no stop or resume. After `ASK_WAIT` (9 minutes) the call returns "no answer yet; end your turn now with the question", and the answer comes when the session is resumed. Pending asks live in memory: if the app quits, the call fails in the agent. One ask per run. |
| `read_workstream()` | The run's ticket block, Pip's notes for the workstream, and the reports (or one-line summaries) of the other runs in it, newest last, fenced as data and bounded in size. A run in no workstream gets its ticket block and is told so. |
| `read_ticket(key)` | Cached text of the run's own ticket or a ticket linked to it, fenced as data. Any other key is refused. |

How it is offered: `claude --bg ... --mcp-config <file> --allowedTools mcp__gossamr__report mcp__gossamr__ask mcp__gossamr__read_workstream mcp__gossamr__read_ticket --append-system-prompt <guard + AGENT_GUARD> -- <prompt>`, on every launch. Since step 5 every agent launches this way and none passes `--strict-mcp-config`, so the person's own MCP servers stay. (Until then a read-only kind added its own exact allow list to the same flag and passed `--strict-mcp-config`.) The file (`<app data>/agents/<run id>.json`, folder 0700, file 0600) holds the server address, the run's token in an `Authorization` header and `"timeout": 600000`, above `ASK_WAIT`, because a session cuts an HTTP MCP call at 60 s otherwise. The token is on no command line and in no environment variable (the daemon that runs `--bg` sessions is shared, so a per-launch variable could not reach it). Resume is still `--bg --resume <id> -- <message>` with no flag, because any flag starts a copy.

What is decided in code, not by the CLI:

- **Port.** The server binds the port it used last time (`<app data>/agents/port`) and falls back to a fresh one, logged, when that is taken. Every request is authenticated on its own and no session state is kept, so a restart on the same port is invisible to a running session. Accepted risk: a process of another user that binds that port while Gossamr is down, or after it has moved to a new port, receives the bearer tokens of running sessions and can answer their `ask` calls. Loopback ports are not per user, and the tokens are not a boundary (proposal section 10).
- **Tokens.** An agent token is `gsr_` and 48 hex characters; only its SHA-256 is stored, with the run it was minted for and the tool version. `runs::redact` masks the shape, and a launch failure's text is redacted before it is stored. Hashes are never deleted while the run exists, so a launch whose answer was lost and is later adopted by Retry can still report. Every launch of a run adds its own token, and all of them are valid for that run only. Pip's token is random, per turn and in memory, and works only on `/mcp/{request_id}`.
- **Revocation by state.** A call is taken only while the run is launching, working, waiting for an answer, a permission or a sign-in, or unknown. For `report` this is checked in the same write transaction that stores the report. Done, failed, stopped and queued runs refuse. The config file is removed with the worktree, and a sweep removes the file of a failed run, a missing run, or a finished run six hours after it ended. Cleaning a run up drops its tokens.
- **Caps.** `report`: twelve calls and five refusals per run. The other tools: 200 calls per run, counted in memory while Gossamr runs and dropped when the run is cleaned up. Four quick requests in flight, with pending asks counted apart; 128 KiB per body; loopback Host and Origin only; 401 only for a missing or malformed bearer (anything else is a tool error, so a client does not start OAuth).
- **Staleness.** A report made before the person answered or carried on is marked stale and the written answer is read instead; the woken session can report again without `revise`.

To check by hand, with a signed-in Claude: `cargo test real_agent_tools -- --ignored --nocapture`. It starts the merged server, a real `--bg` session in `~/Code` that reports, reads its workstream and asks one question (answered by the test), and one resume, and stops and removes what it started. It prints whether the token is in the job's files and whether a flagless resume kept the tools (the spike results below say it does).

## The agent MCP channel, checked for real (Claude Code 2.1.310)

These are the results of the step 0 spikes for `docs/simplification-proposal.md`. Each ran a real `--bg` session with the person's own signed-in config, in a worktree of a trusted clone, using `--model haiku`. The MCP server was a stub HTTP server on a fixed loopback port that logged every request. All the sessions, worktrees and branches were removed afterwards.

**An MCP tool needs an allow rule, except in `auto`.**

| Mode | Without `--allowedTools` | With `--allowedTools mcp__gossamr__report` |
|---|---|---|
| `manual` | `blocked`, `waitingFor: "permission prompt"` | The tool was called and the session ended `done` |
| `acceptEdits` | `blocked`, `waitingFor: "permission prompt"` | not run; `manual` is the stricter mode |
| the person's default (`auto`) | The tool was called and the session ended `done` | not run |

- So every launch passes `--allowedTools` for Gossamr's own tools, and `--allowedTools` does reach a dispatched `--bg` session.
- The agent loaded the deferred tool schema through ToolSearch first. That needed no permission in any mode.

**A flagless resume keeps the session's saved options, but only after a stop.**

- A finished session is still alive and idle until it is stopped.
- Resuming it while it is still alive started a copy. The CLI printed "session … is already running in the background, so this started a copy". The copy had none of the saved options, so it could not call the tool.
- After `claude stop` and a 6 s wait, `--bg --resume <session id> -- <message>` printed "woke session … with its saved options (--name, --mcp-config, --permission-mode, --allowedTools, --model)". The tool call then arrived with no prompt.

**Restarting the server on the same port is invisible to a running session.**

- While the server was down, a call failed in the session with `ECONNREFUSED: Unable to connect.` The agent reported it and carried on.
- The server was restarted on the same port while the agent waited on a second server. The agent's next call reached the new process with no new `initialize`.
- The stub keeps no `Mcp-Session-Id`, so a server that authenticates each request by its bearer token alone is safe to restart.
- A resumed session sends `initialize` again on its first call.

**An HTTP MCP call is cut at 60 s unless the server entry sets `timeout`.**

- A tool that answered after 75 s failed in the session with "The operation timed out." The server saw the client go away when it finally answered.
- With `"timeout": 150000` in that server's entry in the `--mcp-config` file, the same 75 s call returned its result.
- This matches the documented per-request timer for HTTP servers: the greatest of 60 s, the server's tool timeout and `MCP_TIMEOUT`.
- So a tool that waits for an answer has to stay under the `timeout` its config file sets.

**Stop, wait 5 s, resume continued the same session every time.**

- The session was stopped in the middle of an MCP tool call, then resumed 5 s later with no flag.
- In 6 of 6 cycles, plus the resume above, the CLI printed "woke session" with the same id.
- A copy appeared only when the session was resumed while it was still running.

**After a resume, an agent may not load a deferred tool unless it is told to.**

- In the merged-server real test (`real_agent_tools_are_called_…`), the resumed turn's prompt ended "If you have no such tool, say NO TOOL". The agent answered NO TOOL without searching for the tool.
- With "loading it with ToolSearch first if it is not loaded", the same resume called `report`.
- So the reminder sent ahead of every resume names Gossamr's four tools and says to load them with ToolSearch.

## Cleanup check (PR 12a)

`real_rm_straight_after_stop_is_retried_until_it_succeeds_and_unpushed_work_is_refused` (scratch config, signed out) stops two sessions and removes them straight away. The clean one was removed on the first try (0 waits, 0.7 s): the lock refusal described above did not appear for a signed-out session that never did model work, so the retry loop is covered by the scripted CLI and was not seen firing for real in this run. The session with a commit that was never pushed was refused with stdout text ending in a suggestion to run `claude rm <id> --discard-unpushed`, and its worktree and branch were left in place. Gossamr returns that text unchanged and never passes the flag. Not checked: the lock refusal for a session that was doing model work when stopped.

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

## Session names

Gossamr titles every session it starts `Gossamr: <ticket key> <kind>` (for example `Gossamr: CE-773 investigate`) so it is recognisable in `claude agents`, `claude attach` and the desktop sessions. `--name` carries the title; `--worktree`, the folder and the `worktree-<slug>` branch keep the plain slug, and the run spec and its digest are untouched (the prefix is added where the launch request is built). Verified on 2.1.286 by `real_prefixed_session_name_is_listed_unchanged_and_the_worktree_keeps_the_slug` (ignored, scratch config): a colon and a space in `--name` arrive as one argument, the `backgrounded \u00b7 <id> \u00b7 <name>` line prints the name whole, `claude agents --json` returns it unchanged, and the worktree and branch use the slug. Nothing reads a session's name to find a run: runs are matched by worktree path or short id, `--resume` keeps the saved name, and the `name` fields of the listing and of the launch output are not used outside tests. Sessions started before this keep their old titles.
