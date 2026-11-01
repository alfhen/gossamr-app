# Proposal: connections as providers

## 1. Summary

Settings › Connections lists connection **instances**, the way T3 Code lists its provider instances. There are three kinds:

| Kind | What an instance is | Signs in with | Several? |
|---|---|---|---|
| GitHub | One `gh` login on github.com | `gh` (built) | Yes (built) |
| Jira | One Atlassian account on one site | A scoped API token in the Keychain (built) | Yes: several accounts on one site, and several sites (this proposal) |
| Provider | One login of a coding CLI: Claude or Codex | The CLI's own login, kept in the instance's config folder | Yes (this proposal) |

Each instance has a name, an on/off switch and a status line from a probe. One **+ Add** in Connections adds any of them.

Pip and agents run on a provider instance and a model, chosen as `{instanceId, model}`. Settings holds the defaults, Pip's drawer and each workstream can change them, and a run records what it ran on. Gossamr never moves work to another login by itself.

Several Jira accounts work at once. Tickets from all of them appear in the Inbox and the board, each draft posts as the account it was made for, and Pip and agents read and draft through the connection of the ticket they work on.

Claude runs Pip and agents. Codex gets its probe, folder and sign-in early, and its runner is scheduled work (steps c0 to c6). Codex shows in **+ Add** once Gossamr can run agents on it. Section 8 says why and what that takes.

## 2. What is built

The first version of this proposal is built. Its text is in git at `c3df66c`, with the research on `gh` and scoped Atlassian tokens.

| Piece | Where | PR |
|---|---|---|
| Instances in `config.json`, parsed on their own and failing closed | `connections.rs`, `config.rs` | #222 |
| Drafts, runs, workstreams and Pip's conversations in `app.sqlite` | `db/schema.rs` (`APP_STEPS`), `inbox.rs` (`with_app_db`) | #221, #237, #252 |
| A probe per instance and the `Connections` topic | `probe.rs`, `inbox/probes.rs`, `wire.rs` | #238 |
| Jira by scoped API token | `auth/`, `workspace/ConnectJira.tsx` | #239 |
| The Connections list, detail pane, rename, remove, Open Terminal on a fix | `workspace/Connections.tsx`, `connectionsLogic.ts` | #240, #241, #242 |
| On and off, drafts held while off and rechecked after | `inbox/instances.rs` | #243, #248, #249, #250 |
| GitHub from `gh` on every request | `codehost/`, `auth/github.rs` | #245, #246 |
| Who drafts post as, and who agents push as | `connectionsLogic.ts` (`actingAs`) | #248, #254 |

Linear (step 9 of the first version) is still on hold until there is a workspace. Nothing here changes it.

## 3. How T3 Code does it

Read from `pingdotgg/t3code` at `3fd2b85`.

- **The record.** `providerInstances` maps an instance id to `{driver, displayName, accentColor, environment[], enabled, config}`. Each driver reads `config` with its own schema. Ids are slugs (`^[a-zA-Z][a-zA-Z0-9_-]*$`, up to 64 characters). The default instance's id is the driver name (`codex`, `claudeAgent`), so old data that names only a driver still routes.
- **Two logins, two folders.** A second Claude is the same binary run with `CLAUDE_CONFIG_DIR` set (`Drivers/ClaudeHome.ts`). T3 sets that and not `HOME`, because changing `HOME` hides the macOS Keychain login. An empty folder leaves the environment as it is. Codex does the same with `CODEX_HOME`.
- **Probes.** Claude: `claude --version`, then the account from the CLI. Codex: `account/read` over `codex app-server`. The result is `{enabled, installed, version, status: ready|warning|error, auth: {status, email, label}, message, checkedAt}`. A probe that times out is a warning, never "not signed in". A disabled instance spawns nothing.
- **Sign-in is handed off.** For Claude and Codex, T3 shows the command (`claude auth login`, `codex login`) and waits for the next probe. It runs its own sign-in only where it owns the OAuth app.
- **Models.** Claude's list is a bundled manifest (`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`), not the CLI. Codex's comes from the CLI (`model/list`). Each instance can add custom models.
- **Routing.** A choice is `ModelSelection = {instanceId, model, options?}`. A thread stores the current choice, and each run stores what it used. A thread can move only between instances with the same config folder, because a session lives in its folder.
- **Off.** An off instance spawns nothing, leaves the pickers and never has its secrets read. A turn that targets it is refused with "The target provider instance is unavailable." T3 falls back to another instance only for background text such as titles.
- **Drivers.** Codex, Claude, Cursor, Grok, OpenCode, Antigravity, fx, Pi, Muse and any ACP agent.

What Gossamr does differently:

- No binary path, launch arguments or environment variables per instance (Section 13).
- No wizard. Each kind's form fits on one sheet, and Gossamr makes the id itself.
- No probe timer. A probe per instance every few minutes would start a `claude` process per login all day.
- GitHub and Jira sit in the same list. T3 keeps source control in a separate panel.

## 4. Decisions

1. **Three kinds, one list.** Providers show in the same Connections list as GitHub and Jira, with the same rename, on/off, remove and Open Terminal. In `config.json` they sit under their own `providers` key (5.1), so older builds keep working.
2. **Two drivers: Claude and Codex.** Claude runs Pip and agents. Codex's probe, folder and sign-in come early. Its runner is scheduled (c0 to c6), and it shows in **+ Add** once it can run agents. Other T3 drivers wait (Section 6.1). *For the owner to confirm:* the other choice is to show Codex in **+ Add** at once, marked "Can't run anything yet".
3. **A config folder is the one new per-instance setting.** It keeps two logins apart. It is a path, not a secret, so it lives in `config.json`. Binary path, launch arguments and environment variables stay out.
4. **The existing setup is the default instance.** Every install gets a `claude` instance with no folder. It runs what runs today, so nobody has to add anything.
5. **One environment per instance.** The probe, Pip, agents and every Terminal script of one instance pick the same login (6.3). An instance with its own folder ignores credentials the shell exports.
6. **A choice is `{instanceId, model}`,** with an optional effort. Narrowest wins: run, then workstream, then the Settings default. Rust checks the model and effort against fixed lists.
7. **No automatic switching between logins.** A different login is a different account, plan and data. A choice that can't run fails or waits, and says why.
8. **Several Jira accounts.** Any number of accounts and sites. Work takes its connection from the thing it is about (the draft, the run, the ticket, the workstream), never from "the signed-in one". Where nothing says, the **primary** connection is used: the first Jira instance in the list that is on.
9. **Each step leaves `main` working.** `Core::scope()` stays, as the primary, until its last caller moves. A feature the backend doesn't honour yet stays out of the UI. Provider rows stay hidden until runs honour their instance (r14), and the second Jira account stays hidden until every path takes its connection from the work (j26).

## 5. The instance record

### 5.1 `config.json`

```json
"version": 1,
"connections": [
  { "id": "jira", "kind": "jira", "displayName": "Acme Jira", "enabled": true,
    "config": { "site": "acme.atlassian.net", "email": "alf@acme.com" }, "boundTo": "jira:5f1c…:712020:ab-cd" },
  { "id": "jira_2", "kind": "jira", "displayName": "Acme Jira (alf@contractor.com)", "enabled": true,
    "config": { "site": "acme.atlassian.net", "email": "alf@contractor.com" }, "boundTo": "jira:5f1c…:712020:ef-01" },
  { "id": "github", "kind": "github", "displayName": "GitHub", "enabled": true,
    "config": { "host": "github.com", "login": "alfhen", "userId": 1234567 }, "boundTo": "github:alfhen" }
],
"providers": [
  { "id": "claude", "driver": "claude", "displayName": "Claude", "enabled": true, "config": {} },
  { "id": "claude_2", "driver": "claude", "displayName": "Claude personal", "enabled": true,
    "config": { "configDir": "~/.claude-personal", "customModels": ["claude-opus-5-5[1m]"] } },
  { "id": "codex", "driver": "codex", "displayName": "Codex", "enabled": true,
    "config": { "configDir": "~/.codex-work" } }
],
"models": {
  "pip": { "instanceId": "claude", "model": "sonnet", "effort": "medium" },
  "agents": { "instanceId": "claude", "model": "default" }
}
```

- `connections` keeps version 1 and its shape. Providers are a separate list, `providers`, parsed on its own and failing closed the same way: a list that can't be read sets `providers_error`, the rows show it, and no provider spawns anything.
- A provider has `driver` (`claude` or `codex`) and no `boundTo`. Its login lives in its folder, and the probe reports who it is.
- Ids follow today's rule (`next_id`) over both lists and `retired_ids`: the first of a driver is its name, later ones get `_2`, `_3`, and a removed id is never given out again.
- `configDir` is stored as typed (`~` kept), and expanded when used. No `configDir` means the CLI's own default.
- `customModels` is a short list of extra model ids (6.5).
- `models` holds the Settings defaults (Section 7).

### 5.2 Adding the default instance

`AppConfig::load` adds the default `claude` instance when the `providers` key is absent and `claude` is not in `retired_ids`. It reads no secret and waits for nothing, so it can't leave the file half moved. An empty `providers` list means the person removed them all, and stays empty. The next save writes the key.

Older builds don't know `providers` or `models`. They ignore both and drop them when they save, and everything else, including the on/off switches, keeps working. A later upgrade adds the default Claude again; instances the person added are lost. That is the whole cost of a downgrade.

`connections.rs` gets `ProviderInstance { id, driver, display_name, enabled, config }` and `Driver { Claude, Codex }`. The tracker's `ConnectionKind` stays `Jira | Github`, because it means "a connection with a cache".

### 5.3 `ConnectionInfo` and the front end

`kind` grows from `"jira" | "github" | "mock"` to include `"provider"`, with `driver` and `configDir` beside it. `src/types.ts`, `src/backend/types.ts`, `jira.ts` and the mock change together.

Code that treats "not GitHub" as Jira must test for Jira instead, or a provider row counts as a ticket connection:

- `domains.ts` `domainOfKind` gives providers a third domain, `model`. `workConnections`, `isWorkConnection` and `domainOfConnection` (17 call sites) then leave them out.
- `Connections.tsx:123` and `:251` (Change account opens ConnectJira).
- `connectionsLogic.ts` `isSignedOut` and `SignInBanner.tsx`, which treat any non-GitHub row as Jira. A signed-out provider never raises the Jira banner.

In Rust, `jira_connect` refuses an instance id that is not a Jira instance, and every `provider_*` command refuses an id that is not a provider.

## 6. AI providers

### 6.1 Drivers

| Driver | Binary | Folder variable | Runs Pip | Runs agents | Sign-in command |
|---|---|---|---|---|---|
| `claude` | `claude` | `CLAUDE_CONFIG_DIR` | Yes | Yes | `claude auth login` |
| `codex` | `codex` | `CODEX_HOME` | After c2, if c0 says yes | After c6 | `codex login` |

Each driver says what it can run (`runs_pip`, `runs_agents`). Pickers list only instances whose driver can run that use, and **+ Add** lists only drivers that can run something. When Codex's runner lands, its flags flip and nothing else in the model changes.

Both binaries are found on the PATH of the captured shell environment (`runs/env.rs`), after the fixed install paths `find_claude` checks today. A login shell (`zsh -lc`) misses tools that `.zshrc` sets up, such as an npm `codex` under nvm, and that `codex` is a node launcher that also needs the shell's PATH to run.

Other T3 drivers, for later:

| Driver | Fit | Why |
|---|---|---|
| OpenCode | Plausible | Runs as a local HTTP server with sessions and MCP. Needs an HTTP client, not a spawned process per turn. |
| Grok, fx, other ACP agents | Plausible, as one driver | All speak ACP over stdio. One ACP client covers them, but ACP is a session protocol, a bigger build than spawning a CLI. |
| Cursor | Poor | A Node SDK, not a CLI Gossamr can spawn from Rust. |
| Antigravity | Poor | No CLI. In-app Google sign-in. |
| Pi, Muse | Unknown | No documented headless MCP mode found. |

A driver that keeps its login in the Keychain under a fixed name can't keep two logins apart with a folder. Test that before adding one.

### 6.2 Config folders

A provider instance's folder holds its login, settings, sessions and history. Two instances with different folders are two separate logins.

| Folder field | Claude | Codex |
|---|---|---|
| Empty | `CLAUDE_CONFIG_DIR` comes from the person's shell, as for agents today. Unset, the CLI uses `~/.claude` and `~/.claude.json`. | `CODEX_HOME` comes from the shell. Unset, the CLI uses `~/.codex`. |
| Set | `CLAUDE_CONFIG_DIR=<folder>` on every `claude` the instance runs. | `CODEX_HOME=<folder>` on every `codex` the instance runs. |

Rules Rust checks when a folder is added, and again each time `config.json` is loaded:

- `~` expands to the home folder. The result must be absolute, inside the home folder, and not the home folder itself.
- The deepest part of the path that exists is resolved with `canonicalize`, and the rest is added back, so `..` and symlinked parents can't hide where it points. An existing folder must not itself be a symlink.
- Paths are compared without regard to case, because APFS ignores case by default, and by device and inode when the folder exists.
- It must not be inside Gossamr's data folder.
- It may not contain a quote or a control character (newline and NUL included). This is `control.rs` `quotable`.
- No two instances of one driver may share a folder. "Another Claude already uses this folder."
- Only one instance of a driver may have no folder. "Your usual setup is already added as <driver name>."
- Claude: `~/.claude`, and the folder the default instance resolves to (6.3), are refused, with "That's your usual setup. Choose My usual setup instead." Setting `CLAUDE_CONFIG_DIR=~/.claude` is not the same as leaving it unset: the CLI then reads `.claude.json` from inside the folder and looks for a different Keychain login.
- Codex: the folder the default instance resolves to (the shell's `CODEX_HOME`, else `~/.codex`) is refused with "That's your usual setup. Choose My usual setup instead." Any other folder, `~/.codex` included when the shell sets a different `CODEX_HOME`, is stored as typed.

A folder that fails a rule at load puts its instance in `error` ("This folder can't be used: …"). An instance in `error` spawns nothing: no probe, no Pip, no run, no Terminal script.

Gossamr creates a missing folder with mode 0700 when it is added, because `codex` refuses a `CODEX_HOME` that doesn't exist. It writes nothing inside it. It never reads, copies or logs the CLI's login files there.

### 6.3 One environment per instance

`ProviderEnv::resolve(instance)` decides the **login variables** of an instance, the ones that pick which account a CLI runs as:

| Driver | Login variables |
|---|---|
| Claude | `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` |
| Codex | `CODEX_HOME`, `CODEX_API_KEY`, `OPENAI_API_KEY` |

- **No folder (the default).** The login variables are the ones the captured shell environment has. The capture is wired into `Core` in step p2, not later.
- **A folder.** The folder variable is set and every other login variable is removed, so a key the shell exports can't override the folder's login. The detail pane says so when the shell has one: "Your shell sets ANTHROPIC_API_KEY. Claude personal doesn't use it."

Every process of an instance gets the same login variables:

| Process | Base environment | Then |
|---|---|---|
| Probe | The captured shell environment | Login variables replaced by the instance's |
| Agents (`SystemCli`) | The captured shell environment | Same |
| Pip | The app's own environment, as today | Same |
| Terminal scripts (sign-in, attach, trust, permission) | The person's shell, which Terminal starts | `export` of the folder variable and `unset` of the others, for an instance with a folder |

Pip keeps the app's environment for everything else, so its lockdown doesn't change.

When the capture fails, the default instance's login can't be known. Its probe says "Couldn't read your shell setup" with Check again, and Pip and runs on it are refused with that reason. They never fall back to the app's environment, which might be another login. An instance with a folder doesn't need the capture to choose its login.

The Claude probe also reads `authMethod` and `apiProvider` from `claude auth status --json`. When the login comes from an API key or a third-party provider, the status line says so: "Authenticated · API key from your shell".

### 6.4 Sign-in

Sign-in is handed to the CLI, as in T3. The detail pane shows the sign-in command with Copy, Open Terminal and "I've run it, check again".

The probe's `fix` for a provider is display text only. Open Terminal on a provider never passes it to `write_fix_file`, whose allowlist stays as it is for the `gh` and Jira fixes. It calls a separate writer, `write_provider_signin(dir, driver, binary, folder)`, which builds the script from the instance record at that moment:

```sh
#!/bin/zsh
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
export CLAUDE_CONFIG_DIR='/Users/alf/.claude-personal'
exec '/opt/homebrew/bin/claude' auth login
```

Both paths go through `quotable`, the folder is checked again by the rules in 6.2, and the subcommand comes from a fixed table per driver. Without a folder the script is only the `exec` line, and Terminal's own environment picks the login. The probe and runs use the shell environment Gossamr captured at launch, so after the shell changes, sign-in can land in a different login than the probe reads until Gossamr is relaunched. The script never writes captured API keys or other secrets. The attach, trust and permission scripts (`runs/control.rs`) use the same `unset` and `export` lines.

Gossamr stores no Claude or Codex token. The status after a sign-in comes only from the next probe. Remove leaves the login and the folder alone; the remove confirmation says so. There is no Sign out button: the detail pane shows the sign-out command for the person to run.

A fresh Claude folder has trusted no repository. An agent's first run in a clone under a new folder stops with the trust question, as it does today for a new clone (`NeedsTrust`).

### 6.5 Probes

A provider probe returns the existing `probe::Snapshot` (`installed, version, state, account, message, detail, fix`), run with the instance's environment (6.3).

| Step | Claude | Codex | Timeout |
|---|---|---|---|
| Off, or folder fails 6.2 | Spawn nothing. State `off` or `error`. | Same | none |
| Folder | — | The folder must exist. Otherwise `error`: "The folder ~/.codex-work is gone." | none |
| Binary | `claude` not found: `notFound`, "`claude` isn't installed." | Same for `codex` | none |
| Version | `claude --version` | `codex --version` | 20 s |
| Account | `claude auth status --json`: `loggedIn`, `email`, plan, `authMethod`, `apiProvider`, `configDirectory` | `codex login status`, which prints on stderr (below) | 25 s |
| Result | `ready` "Authenticated · alf@acme.com", or `notSignedIn` with the sign-in command | `ready` "Authenticated · ChatGPT" or "Authenticated · API key", or `notSignedIn` | |

Codex's `login status` prints no email or plan. Its result:

| Exit | stderr starts with | State |
|---|---|---|
| 0 | `Logged in using ChatGPT` | `ready`, "ChatGPT" |
| 0 | `API key configured` | `ready`, "API key" |
| 1 | `Not logged in` | `notSignedIn` |
| anything else | | `error`, "Couldn't check" |

Only the matched prefix is kept. Codex's raw stderr can hold part of an API key, so it is never stored in the snapshot or logged. `notSignedIn` must be exact, because `codex login` first clears the login in that folder.

A timeout or a failure to run is `error` ("Couldn't check"), never `notSignedIn`. Fixtures cover each output. CI has no `codex`, so the Codex probe is tested only through fixtures, including an npm `codex` that is a node launcher.

**When.** Probes run at launch, on refresh, after Open Terminal on a fix, and when a turn or run fails as not signed in. On window focus a provider is probed again only when its last answer was not `ready` or is more than five minutes old. Refresh always probes. There is no timer. A run's preflight asks `claude auth status` with the run's instance.

**Not in the way.** Provider probes run at the same time as each other, each under its own lock, and outside the lock the Jira and GitHub probes hold (`probes.last`). A slow `claude` can't hold up the other rows or `probe_instance_now`.

### 6.6 Model lists

| Driver | Models | Where from |
|---|---|---|
| Claude | Default, Fable, Opus, Sonnet, Haiku, then the instance's `customModels` | Built in. Opus, Sonnet and Haiku pass the CLI's aliases (`opus`, `sonnet`, `haiku`), which follow the newest of each. Fable passes `claude-fable-5-1`, the id in T3's manifest. "Default" passes no `--model`, so the folder's own setting applies. |
| Codex | A built-in list, then `codex debug models` per instance, then `customModels` | Added with the Codex runner (c1). `debug` output isn't a stable contract, so parse it with care and fall back to the built-in list. |

**Add model…** in the picker and in a provider's detail adds an id to `customModels`, so a model released under a new name can be used without a new Gossamr. An id is letters, digits, `.`, `_`, `-`, `[` and `]`, starts with a letter or digit, and is at most 100 characters.

Pip's picker leaves out "Default". Pip reads no settings files (`--setting-sources ""`), so "Default" there would mean the CLI's own default, which may be slower and costlier.

Effort stays fixed in the UI for now: Pip uses `medium`, and agents pass none. `ModelChoice` has the field so a later picker needs no new shape.

## 7. Choosing an instance and a model

### 7.1 The shape

```rust
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub instance_id: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}
```

The same type is in `src/types.ts`. A missing choice resolves to the Settings default.

A choice comes from the page, so Rust checks it before it reaches argv. The resolver accepts a model only if it is in `provider_models(instance)`, never "Default" for Pip, and an effort only from a fixed list in Rust. A test in the lockdown flag suite sends a hostile model string.

Resolving a choice gives `Ready { instance, model }` or `Unavailable(reason)`. The reasons and their words:

| Reason | Pip says | A run says |
|---|---|---|
| Off | "Pip runs on Claude personal, which is off. Turn it on in Settings or pick another." | "Waits for Claude personal, which is off." |
| Not signed in | "Claude personal isn't signed in. Sign in, then ask again." plus the fix | "Waits until Claude personal is signed in." |
| Not found | "`claude` isn't installed." | Same |
| No shell setup | "Gossamr couldn't read your shell setup, so it can't tell which Claude login to use. Check again in Settings." | Same |
| Removed | "Pick which Claude Pip runs on." | "Claude personal was removed. Pick another." |
| Can't run this | "Pip can't run on Codex yet." | "Agents can't run on Codex yet." |
| Bad model | "Pick a model for Pip." | "Pick a model for this run." |

There is no fallback to another instance.

### 7.2 Pip

- **Choice.** The conversation's choice, else the Settings default "Pip uses". `AskRequest` gains `model: Option<ModelChoice>`. Each Pip turn stores the choice it ran with, and the conversation's `load()` returns the last one, so the picker survives a restart. A wake turn (the run supervisor) uses the last stored choice of the workstream conversation, else the default.
- **Launch.** `ClaudeCodeProvider` takes the instance's binary, login variables (6.3), model and effort from the request in place of the `MODEL` and `EFFORT` constants (`claude/mod.rs:26-27`). Every lockdown flag stays. The tests that check each flag run for an instance with a folder too.
- **Sessions.** A Claude session resumes only in the folder that wrote it. Pip's session ids are stored with their instance id: the `pip_sessions` list, the `claude:<key>` meta rows and `Workstream.pip_session`. A turn on another instance starts a new session. That is safe: `AgentRequest.session` is "never needed for correctness", because the prompt is complete.
- **Switching.** The model can change at any message. Switching instance starts Pip fresh, and the picker says so: "Switching to Claude personal starts Pip fresh in this conversation. Your messages and drafts stay."
- **Off or signed out.** The turn fails at once with the words in 7.1. It never runs on another login.

### 7.3 Agent runs

- **Choice.** A run gets its choice when it is queued: the workstream's "New agents use", else the Settings default "New agents use". It is stored on the run (`Run.runs_on`, a new `runs` column in `APP_STEPS`), not on `RunSpec`, because it changes who runs the brief and not what the brief says, so the digest stays as it is.
- **Change.** A queued run's choice can be changed until it launches (`runs_set_model`). The change is a compare-and-set (`WHERE state = 'queued'`) under the `launching` lock the launcher holds, and the launcher reads `runs_on` again under that lock. At launch it is frozen. After the run the sheet says "Ran on Claude personal · Opus".
- **Launch.** The launch passes `--model` unless the model is "Default". `--bg` with `--model` is checked (`docs/agents-cli-findings.md`, the step 0 spikes ran with `--model haiku`). `--effort` with `--bg` is not checked, so agents pass none.
- **Toolchain per instance.** `ToolchainSource` gains `for_instance(id)`. Its `SystemCli` applies the captured shell environment with the instance's login variables (6.3). An unknown or removed id is an error; it never falls back to `get()`. `get()` stays as the default instance, so the tests built on `FixedToolchain` keep working. The git and `gh` environment (`Git::new(tc.env)`) stays the captured one, without the folder.
- **One daemon per folder.** Claude keeps `daemon.lock`, `jobs/`, `projects/` and `sessions/` in each folder, so each instance has its own background daemon and its own `claude agents` list. The rule in `runs/env.rs` still holds per folder: every `claude` for one instance gets exactly the same environment. Step o10 checks this with two signed-in folders before any run launches on a second instance.
- **Tracking.** Everything that asks the daemon goes per instance in one step (r13), before any run can launch on a second instance: the tracker's poll, `recover()`, `finder.rs` `unready` (which tells Pip whether agents can start), `sweep_agent_files`, `control.rs` `disk`, answer, resume, stop, remove, clean-up, final answer and continuation. The `RunService` caches of `configDirectory` and `projectsDirectory` become maps by instance. The tracker calls `claude agents --json --all` once per instance that has live runs. A short id is unique only within one daemon, so `RunIndex` and `belongs_to` key runs by `(instance, short id)`.
- **Until then.** From r12 until r13 lands, the resolver gives `Unavailable(CantRun)` to agents on any instance but the default, so no run can launch where the tracker can't see it.
- **Terminal.** The attach, trust and permission-mode scripts export the run's folder and use its binary (6.4).
- **Limits.** The concurrency cap (`maxRuns`) stays one number across all instances.
- **Failures.** `NotSignedIn`, `ClaudeMissing` and `NeedsTrust` name the instance. The help text in `failureHelp.ts` and `RunSheet.tsx` uses the instance name.

### 7.4 Off, signed out, removed

| | Pip | Queued runs | Running runs |
|---|---|---|---|
| Off | Refused, with the words in 7.1 | Wait, and say so | Keep going. Gossamr keeps tracking them. Stop and remove work. A message or answer to one waits until the instance is on. |
| Not signed in | Refused, with the fix | Wait | Whatever the CLI does. Their failure names the instance. |
| Removed | Choices that named it are cleared; Pip asks which to use | Wait, with "Claude personal was removed. Pick another." and Change | Remove is refused while it has live runs: "Stop its 2 running agents first." |

A finished run whose instance was removed is cleaned up with git alone (the worktree and branch), and its sheet says the session was left in that login's folder.

The remove confirmation for a provider says: "Remove Claude personal? Gossamr stops offering it. Runs and Pip conversations that used it keep their history, and your login and folder stay as they are. Settings and workstreams set to it need a new choice."

## 8. The Codex runner

### 8.1 What it needs

Codex can do most of what Pip and agents need, but not the way Claude does it, and the parts that matter most are unchecked. `codex` isn't installed on the build Mac, and the checks need a real Codex login.

| Need | Claude today | Codex | Checked? |
|---|---|---|---|
| Headless turn with JSON events | `claude -p --output-format stream-json` | `codex exec --json` (`thread.started`, `item.*`, `turn.completed`) | From source |
| Pip lockdown: MCP tools only | `--tools ""`, `--setting-sources ""`, `--strict-mcp-config` | `--sandbox read-only` still lets the model run shell commands that read. `-c features.shell_tool=false` may remove the shell. `--ignore-user-config` keeps the person's own MCP servers, hooks and plugins out. | No |
| MCP tool calls without a human | `--allowedTools mcp__gossamr` | `codex exec` cancels any MCP call that needs approval. The server entry needs `default_tools_approval_mode="approve"`. | No |
| System prompt | `--append-system-prompt` | No flag. In the prompt, or a config key not yet found. | No |
| MCP token kept out of argv | `${GOSSAMR_MCP_TOKEN}` in the header | `bearer_token_env_var = "GOSSAMR_MCP_TOKEN"` | From source |
| Background agent | `claude --bg --worktree`, a daemon, `claude agents`, `stop`, `rm`, job folders | None. `exec` handles one turn and exits. Gossamr would make the worktree, spawn the process, keep its state and stop it. | n/a |
| Survives Gossamr quitting | The daemon owns the run; `recover()` adopts it again after a restart | A process Gossamr spawns. It needs its own session (`setsid`), its events written to a file in the run folder, and its pid recorded so a restart can find it. | No |
| Attach while running | `claude attach` to the daemon's session | No attach. `codex resume` while `exec` runs would be a second writer on one thread, so the `exec` must stop first. | n/a |
| Resume | `--bg --resume <id>` | `codex exec resume <thread id>`, a new process per turn | From source |
| Message a running agent | stop, then resume with the answer | SIGINT, then `exec resume` with the message | No |
| Commit and push from the worktree | The person's own setup | `workspace-write` keeps `.git` read-only and the network off. Agents that push need `danger-full-access` in their own worktree, or Gossamr commits for them. | No |
| Cost | `total_cost_usd` | Tokens only | From source |

Pip on Codex is allowed only if its lockdown matches Claude's (rule 3). If it can't, Codex runs agents only.

### 8.2 The steps

They are in the build plan (Section 14) as c0 to c6.

| Step | What | Size |
|---|---|---|
| c0 | **Smoke test with a real Codex login**, by the owner. Run each "No" in 8.1 and write what happened in `docs/agents-cli-findings.md`. Decide Pip on Codex yes or no, and the agents' sandbox. | Doc only |
| c1 | **Codex models and capability flags.** The built-in list and `codex debug models` per instance, cached. | ~250 |
| c2 | **Codex Pip runner**, only if c0 says yes. A `codex` module beside `claude/` that builds the argv, maps `exec --json` events to `AgentEvent`, and has a test for each lockdown flag. | ~500 |
| c3 | **A run backend trait** above `ClaudeCli`: launch, observe, stop, resume, final answer, attach and sign-in commands. Claude implements it with what exists. | ~400 |
| c4 | **Codex launch and supervision.** Gossamr makes the worktree and branch and starts `codex exec --json -C <worktree>` in its own session, with stdout to `events.jsonl` in the run folder, which the tracker reads. It records `{instance, thread id, pid}`, maps events to `RunState`, and after a restart finds the run again by pid and file. | ~600 |
| c5 | **Codex answer, resume, stop and clean-up.** SIGINT then `exec resume`, SIGKILL after a wait, worktree removal with git. | ~500 |
| c6 | **Codex final answer, Terminal and UI.** Final answer from `-o <file>`. Attach stops the `exec` first and then opens `codex resume` in Terminal. Failure text. The `runs_agents` flag turned on, which also shows Codex in **+ Add**. | ~400 |

## 9. Several Jira accounts

The data is already per connection: cache files, cache tables, the app tables' `connection_id`, the `Registry`, sync schedules, probes, watch settings and draft dedupe. The single account sits in `Auth` and in code that asks `Core::scope()` "who is signed in" instead of reading the connection off the thing it works on.

### 9.1 Sign-in and the vault

- `Auth.session` becomes a map from connection id to credentials, in the order added.
- The vault key `jira-token` becomes `jira-token:<connection id>`. The vault is one Keychain document read once, so the accounts are listed by the key prefix, and there is no separate index that could disagree with it.
- The old key is moved when the vault reads as `Ready`, the old key still exists, and the connection it is bound to has no `jira-token:` key yet. A `jira-token:` key for another connection does not block the move, and an existing key for the bound connection is never overwritten. The move is one vault write (`secrets::apply(&[ops])`) that adds the new key and deletes the old one. A crash or failed write leaves the old layout whole, and the move runs again.
- `restore()` registers the sessions that a Jira instance in `config.json` is bound to. Before the first adoption (connections version 0) it registers the one it finds, as today. When the list is live, a token that no instance is bound to is left in the vault and shown as an unattached account to add or remove. A token is deleted only by Remove or by replacing that account, because Atlassian shows a token once and `config.json` can be hand-edited or restored from an older copy.
- `tracker/jira/client.rs` asks for the credentials of its own `SiteScope`, and refuses a scope that is no longer registered. Today it compares with "the" session.
- **Add and replace.** Until j18, `Auth::connect` keeps today's meaning, "replace the one session", so Change account still works. j15 adds `Auth::add` beside it. From j18, `jira_connect(input, instanceId?)` decides: without an instance id it adds; with one it replaces that instance's account. A replace with a different account disconnects the old one completely: deletes its token, unregisters it, removes its cache handle and settles its Pip turns.
- Two instances can't bind the same account: "You already have this account. Use Make a new token on its row."
- A second account on a site is named "Acme Jira (alf@contractor.com)". Two accounts on one site share a cloud id, so `workspace` alone doesn't tell them apart.
- `Credentials` never derives `Debug`.

### 9.2 Scope per connection

- `Core::scope()` stays, and returns the primary. Each step moves some callers to the connection of what they work on. There are 46 `Core::scope()` call sites.
- `with_db_for(scope)` checks that the connection is registered before it looks for an open database. Removing a connection unregisters it, so work that fetched data before a removal still can't write into a reopened file.
- `Open.cache` holds one open cache today and reopens on every switch. It becomes a map, with each database open for the life of the app. `forget_jira` removes the connection's entry from the map, under the database lock, before it deletes the files. Adding the same account again then opens a new file.
- Sync state (`last_error`, `reauth_needed`, `syncing`) moves per connection, the way `code.errors` and `code.syncing` already are for GitHub.
- The sync loop, radar and probes go over every Jira connection that is on.
- `with_proposals` homes every draft and run read to the signed-in connection today, so a second connection's drafts and runs would be invisible. It becomes unhomed and filtered to **registered** connections, with `Db::visible` kept for GitHub drafts. Off is not a filter there: the tracker, Stop and Answer must still see a live run on a connection that was turned off. The on/off hide stays where it is today, in the views and in Pip's and agents' reads (`refuse_hidden`).
- Removing a Jira connection is refused while it has live runs: "Stop its 2 running agents first."
- About 37 Tauri commands depend on the one session: sign-in (3), cache reads (13), watch (6), drafts (6), workstreams (8) and `ask_claude`, plus every `runs_*` command through `with_proposals`. Reads that take no connection fan out; reads that take an `ItemRef` use its connection; `set_unread` and `mentionable` gain a connection.

### 9.3 Inbox, board and feed across sites

- `cache_search`, `cache_containers`, `cache_feed`, `cache_feed_unread`, `cache_me`, `cache_people` and `watch_get` ask every Jira connection that is on, and merge. The feed merges by `(at, id)`, which needs no new cursor.
- The front end already keys items by `connectionId:externalId`, so merging is a concat.
- With two or more Jira connections on, each card, row, peek and draft shows a small chip with the connection name, and the filter bar gets an Account filter. With one, nothing changes.
- A new account starts with nothing watched. The Add flow opens Watching for it.
- `Root.tsx` picks the desktop backend when any Jira connection that is on exists, not from the one Jira sign-in. Its account key stays the same when an account is added, so tabs and saved views survive.
- Adding an account refreshes in place. Removing one goes back to Setup only when it was the last Jira.

### 9.4 Drafts post as their account

- A draft's connection is fixed when it is made (`db/proposals.rs` `connection_of`).
- Approve, edit, skip and recheck use that connection's tracker and cache. Today `approve_proposal` posts through the signed-in tracker, which would post a draft made on site B to site A. This must land before the UI can add a second account.
- `draft_as_user` accepts any connection that is on.
- `post_review_draft` stops needing a Jira scope to post a GitHub review.
- Events after a draft change name the draft's connection.

### 9.5 Workstreams, runs and agents

- A workstream on a ticket takes the ticket's connection. A workstream with no ticket takes the primary, and shows it.
- `workstreams_list` returns every connection's workstreams. Id-based commands find the owner by id.
- The run supervisor sweeps every connection, and stops dropping runs whose connection isn't the signed-in one (`agent/supervisor.rs`).
- The run service, messages, notices and the workstream audit use the run's or the workstream's connection.
- Agents never write to Jira. `read_ticket` reads the run's own cache (today it reads the signed-in one), and `read_workstream` stops refusing a second connection's workstream.
- The agent's brief names the site beside the key (`domain/run.rs` `render_prompt`), and asks for the full key in the PR title.

### 9.6 Pip

- A Pip turn works in one connection: the workstream's, else the open ticket's, else the one the person picked in the drawer, else the primary. With two or more Jira connections on, the drawer of a conversation with no ticket shows that connection and lets the person change it.
- Rust checks the connection a turn names: it must be registered and on, and pass `refuse_hidden`. A stale or off id from the page is refused.
- Every Pip tool acts in the turn's connection only. Pip has no argument to search or draft on another connection, so text from one organisation can't be quoted into a draft on another in one turn. To work on another site, the person opens a ticket there or picks that connection in the drawer.
- The system prompt names the turn's site when more than one is on.
- What Pip has been handed and has read is keyed by `(connection, key)`. `claude:<key>` meta and the drawer's conversation id get the connection in front.

### 9.7 Key collisions

Two sites can both have `TAF-12`. Everything in SQLite is already keyed by connection. The collisions are elsewhere:

| Where | Fix |
|---|---|
| PR and branch links (`codehost/links.rs` `KnownKeys`, one connection per prefix) | A prefix maps to every connection with that project. A key links to the connections where it is cached and watched. When there are several, each link is marked `ambiguous` and the UI says "may be TAF-12 on Acme or on Beta". |
| Pip's memory (`claude:<key>`, `handed`, `read`, the conversation id) | Keyed by connection (9.6). |
| `set_unread(id)`: comment ids are per site | Takes the connection (`FeedEntry` has it). |
| Look-ups by bare key in the front end: `jump.ts` (24 references across `Palette`, `WorkstreamSheet`, `RunSheet`, `runsStore`, `DraftPeek`, `WatchNotices`, `Workspace`), `useNeeds.ts`, `openPull`, `commands`, `PeekSheet`, `screenContext.ts` | Look up by `ItemRef`. A typed key that two sites have opens a chooser. |
| `cardId(key)` gives duplicate DOM ids | Use `itemKey(ref)`. |
| `keyToRef` splits on the first colon, so `jira:cloud:acct:KEY` reads as connection `jira` | Split on the last colon. |
| Rail project groups by `c.key` | Label with the site when keys repeat. |

Pinning a repository to a Jira connection to break ties is left until someone needs it.

## 10. The Settings screen

### 10.1 "+ Add"

A button "+ Add" sits in the Connections header, beside refresh. It is primary (indigo) when no real connection exists yet, and secondary after. It opens a menu with group headings:

| Group | Entry | Line under it | Shown from |
|---|---|---|---|
| Code | GitHub account | Pull requests, branches and checks. | p5 |
| Tickets | Jira account | Tickets from one Jira site. | p5, and when a Jira exists only from j26 |
| Models | Claude | A login that Pip and agents can run on. | r14 |
| Models | Codex | A login that agents can run on. | c6 |

Each entry opens its sheet in `ConnectFrame`. The palette gets the same entries as "Add GitHub account", "Add Jira account", "Add Claude" and "Add Codex", shown by the same rules. The footer "Connect GitHub" button and `github:connect` go.

"Models" is the group name so the UI never says "AI" (style guide).

Until r14 a constant `providersShown` in `connectionsLogic.ts` keeps provider rows and the Claude entry out of the desktop UI. The mock shows them with `?providers=1`, so the provider sheets and their e2e specs are built and tested before then.

### 10.2 The list

The list groups rows under Code, Tickets and Models. Sample data stays under Tickets. Arrow keys still walk the whole list. Badges: `CL` and `CX` for providers, and the first two letters of the site for Jira in place of `JI` for all. The side-by-side layout of T3 is not copied; Settings is 720 px wide.

Under Models, below the provider rows, are "Pip uses" and "New agents use", each with a model picker (10.5).

### 10.3 The sheets

**Add GitHub account.** Today's sheet, titled "Add GitHub account".

**Add Jira account.** Today's form, titled "Add Jira account", with a Name field at the end ("Shown in lists and on drafts. You can change it later."). When the site and email match a connection already there: "You already have this account. Use Make a new token on its row."

**Add Claude.**
- "Each Claude has its own config folder, so its login, settings and history stay apart."
- Name, placeholder "Claude work".
- Config folder: "Its own folder", with a path prefilled from the name (`~/.claude-work`). "Gossamr creates it if it doesn't exist." "My usual setup" is offered only when no Claude instance uses it, for example after the default was removed.
- Button "Add Claude".
- The sheet then shows the sign-in step: "Sign in as this Claude. Run this in Terminal, then check again." with the command, Copy, Open Terminal, "I've run it, check again" and Done.
- "Gossamr runs each agent on the login you pick. It never switches between logins by itself."

**Add Codex.** The same with "Codex home" (default `~/.codex-<name>`) and "Add Codex". Its sign-in command is `codex login`.

The row appears at once as "Not signed in" and turns to "Authenticated · alf@acme.com" (Claude) or "Authenticated · ChatGPT" (Codex) after the probe.

### 10.4 A provider's detail

In order: Status (with the fix), Name (Rename), Account (Claude: email and plan; Codex: ChatGPT or API key; then Remove), Config folder (the path, and a quiet "Reveal in Finder"), Models (the list, and Add model…), and a line on use:

- Claude: "Pip and new agents run on Claude personal when you pick it. Agents already running keep going if you turn it off."
- Codex: "New agents run on Codex when you pick it."

When the shell exports a login variable that the instance ignores, a line says so (6.3). Sync and Watching are hidden. The off line is "Off. Pip and new agents can't use it." The signed-out banner covers a provider only when a Settings default or a queued run uses it, and it uses the provider's own words, never Jira's.

### 10.5 Model pickers

One `ModelPicker` in `src/components/`: a popover list grouped by instance name, with an instance that can't run greyed and its reason, then "Add model…" for the selected instance, and a last entry "Add or manage…" that opens Settings › Connections. No search; there are few models.

| Where | What it sets | Step |
|---|---|---|
| Pip's drawer header, in place of "powered by Claude" (`PipPane.tsx:208`): "Claude work · Sonnet ▾" | This conversation's next turns | r9 |
| Settings › Connections, under Models: "Pip uses" and "New agents use" | The defaults | r14 |
| Workstream sheet: "New agents use" | Agents queued in that workstream | r14 |
| Run sheet and run card: "Runs on Claude work · Opus" with Change while queued | That run | r14 |

Settings › Safety's second promise becomes "Agents run with the Claude Code settings in their login's config folder, so they can push branches and use your own tools." (`Settings.tsx:11`).

## 11. Security

- **Gossamr's secrets stay in the Keychain.** The only new ones are Jira tokens, one per connection, under `jira-token:<connection id>`. They are never logged, and `Credentials` has no `Debug`.
- **Provider logins stay with the CLI.** Claude keeps its login in the Keychain under a name tied to its folder; Codex keeps `auth.json` in its folder. Gossamr never reads, copies, stores or logs them. It doesn't read `providerEnv` or `intent` from a Claude job's `state.json` (as today). Codex's `login status` stderr is never stored or logged (6.5).
- **A config folder path is not a secret, but it reaches a script.** It sits in `config.json`, which anything running as the person can edit, so Rust checks it when it is added and each time the file is loaded (6.2). Terminal scripts for providers are built from the instance record with `quotable` paths and a fixed subcommand, never from probe text; `write_fix_file`'s allowlist doesn't change. A folder can hold hooks, plugins and settings that agents apply; that is the person's own setup, as `~/.claude` is today. It decides which login runs, not which program runs.
- **One login per instance.** The probe, Pip, agents and Terminal scripts of an instance get the same login variables (6.3), so the status line shows the login that really runs. A folder instance drops the shell's API keys.
- **Still no binary path, launch arguments or environment variables per instance.** A binary path in a plain file would decide what Gossamr runs. Environment variables are where T3 keeps API keys, which here would put secrets on disk.
- **Pip stays locked down on every instance.** The folder changes which login Pip runs as, and nothing else. `--setting-sources ""` still keeps the folder's settings, hooks and plugins out. The flag tests run with a folder set and with a hostile model string. Model and effort are checked against fixed lists in Rust.
- **Tokens never cross connections.** A Jira request uses the credentials of its own scope. A draft posts only through its own connection. A Pip turn reads and drafts in one connection, which Rust checks.
- **No automatic switching.** Running a job on another login would move billing and data without the person. Nothing falls back, including when the shell environment can't be read.
- **The agent MCP file** (mode 0600, token per run) is unchanged.

## 12. The six rules

| Rule | Effect |
|---|---|
| 1. Nothing writes without you | Unchanged. Each draft posts as its own Jira account. |
| 2. Secrets in the Keychain | One Jira token per connection, in the Keychain. Gossamr stores no Claude or Codex login; they stay in each CLI's own store. The wording adds that. |
| 3. Pip stays locked down | Unchanged on every Claude instance. Pip runs on Codex only if its lockdown matches (c0, c2). |
| 4. Agents use your own setup | Now "the setup in the config folder of the login they run on". Step d28 changes the text. |
| 5. Ticket text is data | Unchanged. The site name in the brief is Gossamr's, not the ticket's. |
| 6. No shortcuts while typing | The "+ Add" menu and pickers follow it. |

## 13. Left out on purpose

- **Binary path, launch arguments and environment variables per instance.** Section 11.
- **An embedded sign-in terminal.** Copy and Open Terminal cover it.
- **Accent colours.** Names and the "Posts as" and "Runs on" lines carry it.
- **Project and machine scope.** Watching does the job of T3's project overrides, and the workstream does the job of a project default model.
- **A probe timer.** Section 6.5.
- **Effort in the UI.** The shape allows it later.
- **T3's warning about several accounts.** Gossamr doesn't switch logins, which is what the warning is about.
- **Moving a conversation or run between folders.** A session lives in its folder.
- **Pip across sites in one turn.** Section 9.6.
- **A repository pinned to a Jira connection.** Until a collision needs it.

## 14. Build plan

Each step is one pull request from `main`, under about 600 changed lines of non-test code, and leaves the app working. UI marks a step a person will see. Sizes are non-test lines. Steps marked **owner** are checks the owner runs with real logins; builders never run them, and steps that depend on one wait for its result in `docs/agents-cli-findings.md`.

| Id | Step | UI | Depends on | Size |
|---|---|---|---|---|
| p1 | Provider instances in `config.json` | | none | ~400 |
| p2 | One environment per provider instance | | p1 | ~350 |
| p3 | Provider probes | | p2 | ~450 |
| p4 | Add a provider instance, folder rules, sign-in script | | p3 | ~450 |
| p5 | "+ Add" menu and grouped list | UI | p1 | ~350 |
| p6 | Add Claude and Codex sheets, provider detail | UI | p4, p5 | ~450 |
| r7 | `ModelChoice`, model lists and Settings defaults | | p1 | ~400 |
| r8 | Pip runs on a chosen instance and model | | r7, p2 | ~500 |
| r9 | Model picker in Pip's drawer | UI | r8 | ~400 |
| o10 | Two signed-in Claude folders at once | owner | none | doc |
| r11 | A toolchain per instance | | p2 | ~450 |
| r12 | Runs record and launch with an instance and model | | r7, r11 | ~500 |
| r13 | Runs tracked per instance | | r12, o10 | ~550 |
| r14 | Run and Settings pickers, provider rows shown | UI | r9, r13, p6 | ~550 |
| j15 | Multi-Jira groundwork | | none | ~100 |
| j16 | `Auth` holds several Jira sessions | | none | ~450 |
| j17 | `Core` per Jira connection | | j15, j16 | ~550 |
| j18 | Reads fan out; `jira_connect` adds or replaces | | j17 | ~550 |
| j19 | Drafts and runs follow their connection | | j17 | ~450 |
| j20 | Workstreams and the run supervisor per connection | | j19 | ~400 |
| j21 | Run service and agent tools per connection | | j19 | ~300 |
| j22 | Pip works in one Jira connection per turn | | r8, j18, j20 | ~450 |
| j23 | PR links and key collisions | | j18 | ~350 |
| j24 | A mock with several Jira accounts | | j18 | ~500 |
| j25 | Look-ups by `ItemRef` and a key chooser | UI | j24 | ~500 |
| j26 | Add Jira accounts | UI | p5, j19, j20, j21, j22, j23, j25 | ~450 |
| j27 | Site chips, Account filter, Rail labels, multi-site e2e | UI | j26 | ~450 |
| d28 | Rules, README and findings | | r14, j27 | docs |
| c0 | Codex smoke test | owner | none | doc |
| c1 | Codex models and capability flags | | r7, c0 | ~250 |
| c2 | Codex Pip runner, only if c0 says yes | | c1, r8 | ~500 |
| c3 | A run backend trait | | r13 | ~400 |
| c4 | Codex launch and supervision | | c1, c3 | ~600 |
| c5 | Codex answer, resume, stop and clean-up | | c4 | ~500 |
| c6 | Codex final answer, Terminal and UI | UI | c5, r14 | ~400 |

Three tracks can start at once: providers (p1 onwards), multi-Jira (j15, j16) and the owner checks (o10, c0). After p1, routing (r7) and the "+ Add" menu (p5) can start. Within the tracks, p5 and p2, r9 and r11, j18 and j19, and j20, j21, j23 and j24 can be built in parallel. The Codex steps follow the rest; c2 is skipped if c0 says Pip can't be locked down on Codex.

### Step details

**p1. Provider instances in `config.json`.** `ProviderInstance` and `Driver { Claude, Codex }` in `connections.rs`, in a `providers` list beside `connections`, parsed on its own and failing closed (`providers_error`). `connections` stays version 1. `AppConfig::load` adds the default `claude` instance when the key is absent and `claude` is not retired (5.2); no vault, no adopt. `next_id` counts ids in both lists. `connections_list` returns provider rows after the others (`kind: "provider"`, `driver`, `configDir`, no probe yet). Rename, on/off and remove work for them in Rust (remove deletes nothing on disk). `provider_*` commands refuse other ids, and `jira_connect` refuses a non-Jira id. Mirror in `src/types.ts`, `backend/types.ts`, `jira.ts` and the mock (one default Claude row). Front end: `domains.ts` gives providers the domain `model`, and every "not GitHub" test (5.3) tests for Jira. `providersShown = false` in `connectionsLogic.ts` hides provider rows unless the mock has `?providers=1`. Tests: the key absent, empty, broken and from an older build; `claude` retired; ids across both lists; a round trip; `workConnections` and `isSignedOut` leave providers out.

**p2. One environment per provider instance.** `ProviderEnv::resolve(instance)` with the login variables in 6.3. Wire the shell capture (`runs/env.rs`, `toolchain.rs`) into `Core` so probes can use it. Find `claude` and a new `codex` on the captured PATH after the fixed install paths (`runs/binary.rs`). Folder checks from 6.2 that need no change on disk, run when `config.json` is loaded; a failing folder is `error`. The capture failing makes the default instance `Unavailable(NoShellSetup)`. No visible change. Tests: no folder takes the shell's `CLAUDE_CONFIG_DIR` and keys; a folder sets its variable and drops the others; capture failure; a node-launcher `codex` fixture.

**p3. Provider probes.** The Claude probe (`--version`, then `auth status --json` with `authMethod` and `apiProvider`) and the Codex probe (folder exists, `--version`, then `login status` by exit code and prefix, 6.5), both run with `ProviderEnv`. Timeouts 20 s and 25 s; a timeout is `error`. Codex's stderr is never stored or logged. Providers probe at the same time as each other, each under its own lock, outside `probes.last`. On focus, a provider is probed again only when not `ready` or older than five minutes; Refresh always probes. Off and `error` spawn nothing. The mock scripts each state. Fixture tests for every output, including Codex's three stderr prefixes and an unknown one.

**p4. Add a provider instance, folder rules, sign-in script.** `provider_add(driver, displayName, configDir?)`: the full rules in 6.2 (canonicalize the deepest existing part, compare without case and by inode, the default's resolved folder, one no-folder instance per driver, the data folder), create the folder with mode 0700, add the instance, probe it. `write_provider_signin(dir, driver, binary, folder)` in `runs/control.rs` (6.4), and `connection_open_terminal` uses it for a provider, rebuilt from the instance. `write_fix_file` is not changed. Mirror in the three front-end places. Tests for each folder rule (`~/.claude`, `~/.CLAUDE`, a symlinked parent, a symlink, a quote, a duplicate in other case, a second no-folder instance, the shell's `CLAUDE_CONFIG_DIR`, the data folder), a folder edited by hand into `config.json` with a quote, and the script text with and without a folder.

**p5. "+ Add" menu and grouped list.** The "+ Add" button and menu in the Connections header (`Popover.ts`, as in `WorkstreamControls.tsx`), with the rules in 10.1: GitHub and Jira entries open today's sheets; the Jira entry shows only when there is no Jira connection; the Models entries follow `providersShown` and each driver's capability flags. The list grouped under Code, Tickets, Models. Palette commands `connection:add-github` and `connection:add-jira` in place of `github:connect`. Remove the footer button. Update `commands.test.ts`, `Connections.test.tsx`, `devUi.test.tsx` and the e2e specs `connections`, `first-run` and `jira-token`.

**p6. Add Claude and Codex sheets, provider detail.** The sheets in 10.3 with their sign-in step, through `provider_add` and `connection_open_terminal`. The detail in 10.4 with the remove and off copy from 7.4 and 10.4 and the ignored-variable line, without the Models section, which r14 adds. The mock adds instances and moves them from "Not signed in" to "Authenticated" on "check again". A new e2e spec `providers.spec.ts` on `?providers=1`. Still hidden on the desktop.

**r7. `ModelChoice`, model lists and Settings defaults.** `ModelChoice` in Rust and TS. Driver capabilities (`runs_pip`, `runs_agents`). The Claude list from 6.6 with Fable, and `customModels` per instance with its id rule. Commands `provider_models(instanceId)` and `provider_add_model(instanceId, model)`. The defaults in `config.json` `models`, read and written by one command `model_defaults(set)` in the style of `agent_settings`, with Pip `{claude, sonnet, medium}` and agents `{claude, default}`. The resolver: `Ready` or `Unavailable(reason)` with the reasons in 7.1, a model only from the instance's list, never "Default" for Pip, an effort only from a fixed list. Removing an instance clears defaults that named it. Mock. No visible change. Tests for each reason and a hostile model string.

**r8. Pip runs on a chosen instance and model.** `AskRequest.model`; the request carries the binary, the login variables from `ProviderEnv`, the model and the effort to `ClaudeCodeProvider`, in place of the constants; the rest of Pip's environment stays the app's. Each Pip turn stores its `ModelChoice` (in the turn meta), and `load()` returns the conversation's last one; a wake reads it, else the default. Session ids stored with their instance (`pip_sessions`, `claude:<key>`, a `pip_instance` column beside `workstreams.pip_session` in `APP_STEPS`); resume only on the same instance. Refuse at once when the choice is unavailable, with the words in 7.1. The lockdown tests run for an instance with a folder and with a hostile model. Mirror the request field. Notes: step j22 changes the same `claude:<key>` rows, which is why it waits for this one.

**r9. Model picker in Pip's drawer.** `ModelPicker` in `src/components/`, with Add model…. Pip's drawer header shows the choice in place of "powered by Claude"; `claudeStore.ts` seeds it from what `load()` returns and sends it with each ask; the switching line from 7.2. The mock records the choice and answers with it. Unit tests for the picker; an e2e case in the Pip spec.

**o10. Two signed-in Claude folders at once (owner).** The owner signs in two config folders by hand and, in each, launches a `--bg` agent, lists it with `claude agents --json --all`, stops it and resumes it, with both daemons running. They record in `docs/agents-cli-findings.md` whether the daemons, Keychain logins and job lists stay apart. If they don't, r13 changes shape before it is built.

**r11. A toolchain per instance.** `ToolchainSource::for_instance(id)`, an error for an unknown or removed id; `SystemCli` applies the captured environment with the instance's login variables; git keeps the captured environment. `config_dir` and `projects_dir` become maps by instance. The `.command` scripts in `runs/control.rs` take the instance's `unset` and `export` lines (6.4) and binary. `NotSignedIn`, `ClaudeMissing` and `NeedsTrust` carry the instance name. `get()` stays as the default instance. Restate the comment in `runs/env.rs` for one daemon per folder.

**r12. Runs record and launch with an instance and model.** `Run.runs_on` (an `APP_STEPS` column), set when a run is queued from the workstream's choice, else the Settings default. A `workstreams.agents_model` column and `workstreams_set_model`. `runs_set_model(id, choice)` as a compare-and-set under the `launching` lock, and the launcher reads `runs_on` again under it. Launch through `for_instance` with `--model` unless "Default". Preflight per instance. Until r13, any instance but the default is `Unavailable(CantRun)` for agents. An unavailable choice makes a queued run wait, with its reason in the run's status; it starts once the reason clears, and a removed instance waits for a new choice (7.4). Remove is refused while an instance has live runs; a finished run on a removed instance is cleaned up with git alone. Mirror the commands and fields. Notes: touches `runs/service.rs` with j21; whichever lands second merges `main` first.

**r13. Runs tracked per instance.** `RunIndex` and `belongs_to` keyed by `(instance, short id)`. The tracker polls `claude agents` per instance with live runs. `recover()`, `finder.rs` `unready`, `sweep_agent_files`, `control.rs` `disk`, answer, resume, stop, remove, clean-up, final answer and continuation use the run's instance. Messages and answers to a run on an off instance wait. Lift r12's limit to the default instance. Tests with two `FakeCli` instances that reuse a short id, and a restart while a run on `claude_2` is Launching. Notes: touches `runs/tracker.rs` with j21.

**r14. Run and Settings pickers, provider rows shown.** "Runs on … · …" with Change on a queued run's card and sheet, and "Ran on …" after. "New agents use" on the workstream sheet. "Pip uses" and "New agents use" under Models in Connections. The help in `failureHelp.ts`, `RunSheet.tsx`, `AgentParts.tsx` and `RunCleanup.tsx` names the instance. Safety's second promise as in 10.5. The Models section of a provider's detail, with Add model…. Set `providersShown` to true, which shows the provider rows, their switch and Remove, and the Claude entry in **+ Add** and the palette. The signed-out banner for providers (10.4). Mock and e2e for a queued run's change and for the provider rows.

**j15. Multi-Jira groundwork.** Delete the unused `sign_out` command and `auth.signOut`. `keyToRef` splits on the last colon. `cardId` uses `itemKey(ref)`. `off_name` reads `config.json` once per request. No visible change.

**j16. `Auth` holds several Jira sessions.** The session map; `jira-token:<id>` keys listed by prefix, no index; the move from `jira-token` when the old key exists and its bound connection has no `jira-token:` key yet (a key for another connection does not block it, and an existing key is never overwritten), in one write through a new `secrets::apply(&[ops])` (9.1). `credentials_for(scope)` in `Jira::send`. `connect` still replaces the one session; a new `Auth::add`; `disconnect(id)`; `whoami` and `expires_on` per connection. `status()` returns the primary. Tests with two accounts on one site and one on another; the move with a vault that isn't ready, with a failed write, and run twice; the move with a key for another connection already present; connecting a second account through today's `connect_jira` still leaves exactly one session.

**j17. `Core` per Jira connection.** `Core::primary()`. `scope()` and `identity()` return it. `with_db_for` checks registration first and accepts any registered connection that is on. `Open.cache` becomes a map; `forget_jira` removes its entry under the database lock before deleting the files. Per-connection sync state, sync loop and radar. `restore()` registers the sessions bound to an instance and leaves unbound tokens in the vault, shown as unattached accounts. `bind` matches Jira on `bound_to`, names a repeat "site (email)", and refuses a second instance for one account. `adopt` takes a list. Removal and the Jira probe per connection. A two-connection test fixture (`fixture_with_two_jira`) that later steps use. Tests: remove an account and add it again, and the old cache is gone. The UI still has one Jira, so nothing visible changes.

**j18. Reads fan out; `jira_connect` adds or replaces.** The reads in 9.3 merge across connections; `ItemRef` reads use their connection; `watch_*` accept any connection that is on. `set_unread(connectionId, id)` and `mentionable(item, query)`. `snapshot` becomes a tick. `connections()` returns one row per Jira. `jira_connect(input, instanceId?)`: without an id it calls `Auth::add`; with one it replaces that instance's account, and a different account disconnects the old one fully (9.1); an account bound to another instance is refused. The page passes the current instance id until j26. Mirror every signature in `types.ts`, `jira.ts` and the mock. Tests: change account, relaunch, and only the new account is restored and the old token is gone.

**j19. Drafts and runs follow their connection.** `with_proposals` unhomed and filtered to registered connections (9.2). `draft_as_user` for any connection that is on. Approve, edit, skip and recheck use the draft's connection, tracker and account. `post_review_draft` without a Jira scope. Events name the draft's connection. `connection_remove` refuses a Jira connection with live runs. Update the `Db::for_connection` sentence in AGENTS.md. Tests: a draft made on site B posts to site B; turn off the connection that owns a live run, then stop the run.

**j20. Workstreams and the run supervisor per connection.** `workstreams_*` from the item, or the primary for one with no ticket; `list` across connections; id-based look-ups by owner. The supervisor sweeps every connection and keeps runs of all of them. `record_run_action_by` uses the run's connection. A wake uses the workstream's connection.

**j21. Run service and agent tools per connection.** `runs/service.rs` `workstream_runs`, `runs/message.rs` `workstream_hold`, `runs/tracker.rs` `announce_notices` and the announced-needs meta use the run's connection. `read_workstream` and `read_ticket` use the run's connection and cache. `render_prompt` names the site and asks for the full key in PR titles. Notes: shares files with r12 and r13.

**j22. Pip works in one Jira connection per turn.** The order in 9.6, with the drawer's connection for a conversation with no ticket. Rust checks the turn's connection (registered, on, `refuse_hidden`). `PipRun.handed` and `read` keyed by `(connection, key)`. Bare keys in the prompt resolve against the turn's connection. No tool takes another connection. The site in the system prompt when more than one is on. `claude:<key>` and the drawer's conversation id get the connection in front. Tests: an off connection id from the page is refused; a tool can't reach another connection.

**j23. PR links and key collisions.** `KnownKeys` maps a prefix to every connection; `discover` resolves by cached and watched items; `DevLink.ambiguous`, mirrored in `types.ts` and the mock. `known_keys` from every Jira connection that is on.

**j24. A mock with several Jira accounts.** A second `MockConnector`, opt-in with `?jira=2`, that shares a project key and a ticket key with the first. `jiraConnect` adds a connector. Per-connector sync errors. `mockPip` resolves keys against the turn's connection. Existing tests keep the one-connector default.

**j25. Look-ups by `ItemRef` and a key chooser.** The bare-key look-ups in 9.7 (`jump.ts` and its callers, `useNeeds.ts`, `openPull`, `commands`, `PeekSheet`, `screenContext.ts`) take an `ItemRef`. A typed key that two sites have opens a chooser. Unit tests on `?jira=2` data for each look-up.

**j26. Add Jira accounts.** `Root.tsx` picks the desktop backend when any Jira connection that is on exists, and keeps its account key when an account is added. `ConnectJira` adds without signing out, with the Name field and the duplicate check from 10.3. Removing a Jira goes to Setup only when it was the last. Replace `workConnections(...)[0]` in `Workspace.tsx`, `Rail.tsx` and `jump.ts` with the primary. The "+ Add" Jira entry always shows. The new account opens Watching. Update the `jira-token`, `connections` and `first-run` specs.

**j27. Site chips, Account filter, Rail labels, multi-site e2e.** The site chip on cards, rows, peeks and drafts, and the Account filter (9.3). Rail project groups labelled with the site when keys repeat. The ambiguous PR link text. The drawer's connection control for Pip (9.6). A new e2e feature suite `multi-jira.spec.ts` on `?jira=2`.

**d28. Rules, README and findings.** AGENTS.md rules 2 and 4 (Section 12) and its layout table. The README's Connections section: adding a Claude and a second Jira. `docs/agents-cli-findings.md`: one daemon per config folder, with o10's result. Mark this plan's steps done here.

**c0 to c6.** As in 8.2. c0 and o10 are the only steps waiting on the owner. c6 adds Codex to the README.

## 15. Risks and open questions

- **Codex waits for its runner.** Codex shows in **+ Add** only from c6, and c0 needs the owner's Codex login. Decision 2 says what to confirm.
- **Two daemons at once.** Claude keeps a daemon per folder, and Gossamr's real tests already run one in a scratch folder beside the person's own. Two signed-in folders side by side haven't been watched. o10 checks it before r13, the one step built on it.
- **The shell environment can't be read.** Pip and runs on the default instance are then refused until it can (6.3). Agents already need it today; Pip did not.
- **`--effort` with `--bg`** is unchecked, so agents don't pass it.
- **A new folder trusts no repository.** Each clone asks once per folder, through the existing trust flow.
- **Downgrades.** An older build ignores `providers` and `models` and drops them when it saves. Its connection switches keep working. Added provider instances are lost; the default comes back on upgrade.
- **The built-in model ids age.** Fable's full id will go stale; `customModels` covers a new one until the list is updated.
- **The primary Jira connection** is the first in the list that is on. There is no way to reorder yet; adding one is a small step if the order matters.
- **Pip across sites.** A turn works in one connection. If people expect Pip to compare two sites in one turn, that is a new design with its own guard against moving text between organisations.
- **Two sites with the same project key** link PRs to both, marked as unsure, until a repository can be pinned to one.
- **Usage limits.** A login that runs out of usage fails its turn. Gossamr says which login, and doesn't move the work.
- **Linear** stays on hold. When it comes it is a fourth kind beside Jira, with the same per-connection scope.
