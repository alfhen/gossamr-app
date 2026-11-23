# Proposal: Gossamr on its own agent harness

Written 22 Nov 2026 against `main` at 47038d53. It follows [the simplification proposal](simplification-proposal.md) and [the connections proposal](connections-proposal.md), and it reverses some of their decisions on the owner's instruction. The build order is in [plan-harness.md](plan-harness.md). Three adversarial reviews of a first draft shaped this version; section 10 says what they changed.

## 1. Summary

Today the Mac app does everything in one process. To run an agent it starts `claude --bg` or `codex exec`, then works out what the agent is doing from outside: it polls a listing every 4 to 30 seconds and reads the CLI's own files. Each provider has its own code path, and two exist.

This proposal adds one small program, the **harness**, and moves the running of agents into it. The harness starts a provider's own CLI on one of your logins, in a git worktree, as its own child process, and turns what the agent does into one stream of events. It knows nothing about Jira, drafts or Pip. It has its own API and command line, so it can be used without Gossamr. The Mac app starts it as a sidecar, or connects over SSH to one running on your server.

The app keeps what makes it Gossamr: the Jira and GitHub cache, drafts, workstreams, Pip and the window. It becomes a client of the harness.

On top of that, Pip can run a pipeline. You write the goals and gates of a repo; Pip takes a plan through agent-pr-pipeline's steps (checks written first, build, verify from a clean clone, adversarial review, fix, pull request, review bots), and Gossamr's own code lands what is cleared.

What changes for you:

- Agents run on Claude, Codex and Gemini logins. Which login a piece of work uses is a setting.
- You see an agent's output as it happens and answer its permission requests in the app. Today both need Terminal.
- Agents keep running when the app quits, and on a server when the laptop is closed.
- Agents and pipelines write to GitHub without a draft. Jira writes still need one. Pip still writes nothing itself.
- One way to run an agent replaces two. The app stops inferring state.

It is not smaller. About 5,000 lines leave the app (section 6) and about 8,000 arrive, most of them in a harness that works alone. It is simpler in a narrower sense: one path for every provider, and a boundary between running agents and deciding what they should do.

## 2. What the review found

Twelve readers went through the code (about 97,000 lines of Rust and 77,000 of TypeScript, tests included), the docs, T3 Code, intent, agent-pr-pipeline and the current provider documentation.

| Finding | Where | What it means |
| --- | --- | --- |
| Nothing streams | `lib.rs:149-164` polls every 4 s or 30 s; `runs/tracker.rs` diffs a listing | Output is late, and a permission prompt cannot be answered from the app. |
| Most of `runs/` infers state from outside | `state.rs`, `final_answer.rs`, `transcript.rs`, `continuation.rs`, miss and idle counters, stop-then-resume to answer | It exists because `claude --bg` hands the session to Claude's own daemon. A harness that owns the process needs none of it. |
| The Codex backend is a second supervisor | `runs/codex/`, 1,150 lines and 1,321 of tests, eight kinds of marker file | It is a harness already, written for one CLI. |
| `RunBackend` carries Claude's shape | `ShortId`, `AgentEntry`, `TimelineLine`, `Folders`, trust and Terminal words in the trait (`runs/backend.rs`) | A third backend would be a third special case. |
| `Driver` is a closed pair | `connections.rs:45`, `src/lib/models.ts:32`, about ten UI files | Adding Gemini the present way touches Rust, TypeScript and config. |
| The run code is already free of Tauri | No file under `runs/` imports it; it takes plain closures | It can move into another process. |
| The hardened parts exist and are tested | git with repo-configured programs off (`runs/repo.rs`), per-run tokens stored as hashes (`agent/mcp.rs`), process identity by pid and start time, redaction | They move; they are not rewritten. |
| Agents already write to GitHub unasked | `domain/run.rs:333` is an instruction, not a control | Rule 1 was only partly true for GitHub. |
| Six Rust tests read the real machine | `runs::binary`, `inbox::models`, `inbox::provider_probes` fail with `codex` on the PATH | Fixed first, so later checks can be trusted. |

Outside references:

- **T3 Code**: a Node server as sidecar. The desktop app starts it with a bootstrap token; each provider sits behind an adapter with capability flags; a driver (an integration) is kept apart from an instance (one login). Its Claude adapter is 15,146 lines and its contract about 250 methods. We take the shape.
- **intent**: a Rust daemon that reaches every provider through the Agent Client Protocol (ACP), with providers as data, a per-agent MCP bridge whose secret travels in the environment, and a mock provider for tests. About 1.6 million lines. We take those four ideas.
- **agent-pr-pipeline**: one workflow script, `run-wave.js`, 21 role files and about 40 shell scripts. It runs inside Claude Code and is tied to it by the Workflow tool's `agent()` options, the `CLAUDECODE` variable in `merge-pr.sh`, model names in role files and a "main session" that runs shell scripts.
- **Why not use T3 Code or intent as the harness.** Both pass permission and sandbox settings to the provider and default to full access, which rule 4 forbids. T3's contract is TypeScript only. Each is hundreds of thousands of lines we would depend on for a few thousand lines of need.
- **Providers today.** Gemini CLI no longer serves Google subscriptions: a real turn on 22 Nov 2026 returned "This client is no longer supported for Gemini Code Assist for individuals". Google's subscription path is the Antigravity CLI (`agy`), which speaks ACP natively. Claude has a two-way stream of its own (`claude -p` with stream-json in and out), which is how Pip runs today. Codex has `codex exec --json` (what Gossamr uses) and `codex app-server` (two-way, marked experimental). ACP adapters for Claude and Codex exist as npm packages.

## 3. The target

```
 Gossamr.app (Tauri, as today)
   window, Jira and GitHub cache, drafts, workstreams, Pip, pipelines
        |  harness API: Unix socket, token kept in the Keychain
        v
 harness  (sidecar on this Mac, or on your server over SSH)
   providers and logins, sessions, clones and worktrees, events, tools endpoint
        |  stdio                      ^  HTTP on loopback, token per session
        v                             |
   claude / codex / agy  -------------+   result, ask, and the client's own tools
```

### 3.1 The harness

One Rust program in a crate of its own, with no dependency on the app.

**A session is the unit.** A client opens a session with: a provider and login, a place to work (a repo, a base and a branch name, from which the harness makes a clone and a worktree; or an empty folder), a first prompt, a guard text, a model, a list of tools the client offers, and optionally a JSON schema for the result. The harness answers with an id. From then on the client can send a message, cancel, answer a permission request, close, and clean up.

**Everything a session does is an event** with a sequence number, written to the harness's own store after redaction: started, text, tool call, permission request, question, tool call for the client, usage, turn ended, failed. A client reads events from a sequence number onward, so it catches up after a reconnect or a restart. There is no polling and no reading of a CLI's files.

**What rests in the store.** Redaction masks token shapes, not private text. So a locked session (Pip) stores no text or tool payload at all: its events go to the connected client only, and the app keeps Pip's turns as it does today. Other sessions keep their payload until the run is cleaned up, or 30 days. Clean-up and the 30-day sweep promise that the payload leaves the database file, where it is overwritten; they do not reach free disk blocks, the journal file SQLite has already unlinked, or backups made before. Anything that runs as you on that machine can read the store file; section 8 says what that means.

**The harness owns what it starts.**

- It makes the clone and the worktree with the hardened git code Gossamr has today, for every provider.
- The agent is its child. A message to an agent is one call for every provider and state.
- If the harness restarts, it first stops any agent process a dead harness left behind, found by pid and start time. It then resumes each session by the provider's own session id and sends one "carry on" prompt, at most three in a row, never after Stop, never after a turn that a deny ended, and never while a permission request or a question is open. A session can be opened as "ends when its client leaves"; such a session is never resumed.
- It limits how many sessions are in a turn at once, for every way a session starts: a client, the command line, a resume, a workflow. The app's queue decides the order; the harness holds the limit.
- It adds what rule 4 allows: its tools endpoint, a guard, and a model and an effort when one was chosen, and nothing else. No sandbox or restricting flag.

**Tools.** Each session gets one MCP endpoint on loopback with a token of its own and a per-session name drawn at random (at least 64 bits, letters and digits only). The token never goes on argv or into the agent's environment: Claude gets the endpoint by a control request on stdin, Codex in `http_headers` on stdin, Gemini in the `session/new` headers on stdin. The one copy at rest is agy's: it writes the header, token included, into its own conversation database. The endpoint offers `result` (the agent ends its work by calling it; with a schema the data must fit), `ask`, and the tools the client declared. Calls to the session's own endpoint are allowed by the harness without asking the person, on every provider, and only for the exact full tool names built from the per-session name; nothing else is allowed that way (section 4, rule 4). A resumed session gets a fresh token, and the old one is refused.

- `ask` belongs to the harness. The question is stored, survives a restart, and is answered through the API. Each provider row carries the setting that makes that provider's tool call outwait the question, with a test that it does. Where a provider's limit on a tool call is below the wait (Gemini cuts at 180 s), `ask` returns before the limit, measured from the call's start with a margin, with "question pending, end your turn", and the answer is sent as the next prompt. An answer whose call is no longer held (cut by the provider's limit, or lost when the harness or the agent restarted) is sent as the next prompt on every provider, after the running turn ends, resuming the session first with a fresh token. `result` is refused while a question is open. Stop, Take over in Terminal and a turn that a deny ended close open questions, and the run says so.
- A call to a client tool becomes an event and the client posts the answer. With no client connected the call fails at once with "the client is away". This is how Gossamr's `read_ticket` and `read_workstream`, and all of Pip's tools, reach a session without the harness knowing what they are.

**Providers are a compiled-in table.** A row names the program, the variable that selects a login folder, the sign-in check, how models are listed, and the driver. A row is code, reviewed like code; it is not editable data.

| | Claude | Codex | Gemini |
| --- | --- | --- | --- |
| Program | your `claude` | your `codex` | your `agy` |
| Driver (decided in H0) | native: `claude -p` with stream-json both ways | `codex app-server`, one process per session; no `exec` fallback | ACP: `agy acp` |
| Login folder | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` | None: one login until `--gemini-dir` is shown signed in |
| Locked profile for Pip | Yes: today's flags, moved with their tests | No (H0, check 11) | No (H0, check 11) |

**One driver interface.** Open, prompt, cancel, answer, close, and a stream of events. What a provider cannot do is a capability flag. Two or three drivers sit behind it. ACP is used where the provider speaks it natively and nothing is lost. A mock provider replays recorded sessions for tests.

**Its own front doors.**

- A command line that can do everything the API can: `harness serve`, `harness run --provider codex "prompt"`, `harness sessions`, `harness events`, `harness send`, `harness answer`, `harness providers`, `harness token`.
- An API on a Unix socket in a folder only you can open. No TCP port for clients, so a web page or another user cannot reach it.
- A client token. The app makes it and hands it over when it first starts the harness; the harness keeps a hash. Later tokens need a valid one (`harness token new`). The app keeps its token in the Keychain and proves it by answering a challenge, so the token never crosses the socket and a program posing as the harness learns nothing. An agent's own token opens only its session's tools.

### 3.2 The app as a client

- **Start or adopt.** The app starts the bundled harness detached, so it outlives the window, or adopts the one already serving its socket. It keeps working with an older harness as long as the protocol number matches, and Settings offers "Restart the harness to update". Only a protocol mismatch forces it: sessions are stopped, the bundled harness starts, and they are resumed. A newer harness than the app says "update Gossamr". Settings also gets "Stop all agents and the harness".
- **Runs.** A run is a row in the app that points at a harness session. One consumer turns session events into run state, the timeline, notices and Pip's wakes. The tracker loop, the listing diff and both backends go.
- **Permission requests** show in Needs you with Allow and Deny, once. On a provider path where the client cannot answer one, the run stops with the reason and offers "Take over in Terminal". You may turn on, per repo, "allow file edits inside the run's worktree without asking". That covers an edit whose real path is in the worktree and outside `.git`, and nothing else: never a command, never "always", never Pip. The setting lives in the app, where no agent can change it.
- **Failures** arrive as a kind with steps to fix, from the harness. The page stops carrying per-provider help.
- **Providers in the UI** come from the harness: label, signed in or not, the sign-in command, models, whether it can run Pip.

### 3.3 Pip

Pip stays an assistant with no file, shell or web tools that acts only through Gossamr's tools, and it still writes nothing itself (rule 3).

- A Pip turn becomes a harness session opened with the **locked profile**, and as "ends when its client leaves": if the app quits, the turn ends, as it does today. For Claude that is today's flag list, moved into the harness with the tests that check each flag. The proof a provider must pass is stricter than today: the session's advertised tool list equals Gossamr's tools and nothing else, for each CLI version tested.
- Pip's tools are client tools of that session. The app's own MCP server, its port file and its token table go.
- Pip is woken by session events instead of a sweep. The once-per-agent-and-state rule and the wake limits stay.
- Pip gets no tool that answers for you, approves, or merges. Pip proposes a wave; you start it from Needs you.

### 3.4 Pipelines

A pipeline lets Pip build a release without you reading every step. It arrives in two stages.

**Stage 1: the pipeline as it is, on Claude.** Rule 4 already gives an agent your own plugins. Once you start a wave, one Claude agent in the repo's clone runs agent-pr-pipeline's wave workflow on the plan entries you chose: everything up to open pull requests, and none of its landing steps. The agent escalates through `ask`, which lands in Needs you with the options and its recommendation, and it ends with a `result`: each pull request, its head commit and what was verified. In stage 1 you merge; one agent's word is not enough for Gossamr to merge by itself. If the harness restarts, a wave is shown as interrupted and "Resume wave" uses the pipeline's own resume; the harness sends it no "carry on". H0 checks that the Workflow tool works in such a session; if it does not, stage 1 is dropped and stage 2 carries the feature.

**Stage 2: roles on any provider.** The harness gains a workflow host: it runs a workflow script and supplies `agent()`, `parallel()` and `log()` itself. An `agent()` call opens a harness session with the role's prompt, a worktree when asked, a schema enforced through `result`, and a login chosen per role in Settings, so review can run on a different provider from build. A journal of calls makes a restart replay what finished. agent-pr-pipeline needs small changes for this (plan step P1). Stage 2 is the largest and least certain part of this proposal and is built last.

**What you write.** Per repo, on its default branch: the goals document (`docs/goals.md`) and the gates (`.github/pipeline.json`, the paths only you may merge). The plan document is written by an agent Pip starts and comes to you as a pull request.

**Landing is Gossamr's code, never an agent's.** Every agent holds `gh` as you, so a rule inside a script an agent runs is a request, not a control. The app merges a pull request itself, after it has checked in code:

1. the head commit is the one that was verified,
2. the changed paths pass the gates read from the default branch,
3. CI is green,
4. a review bot you named for that repo submitted an approving review of that commit from its own account (a reply or a resolved thread does not count, since agents act as you),
5. the merge-safety verdict is "safe", from a session that did not build or review the change.

Anything Gossamr cannot read counts as failed: checks it may not see, no checks at all, more changed files than it could list.

Per repo you choose "I merge" (the default) or, from stage 2 on, "merge when all five hold". Until you have landed one wave in a repo yourself, every wave there waits for you. No agent is told to merge. A repo whose review bot never approves (this one, as `.coderabbit.yaml` is set today) stays on "I merge".

**What this cannot stop.** With one GitHub account, an agent that is talked into it can still call `gh` and merge or push to the default branch. Two things close that, and both are yours to set up: branch protection on the default branch that applies to administrators, and a separate GitHub account for agents. The proposal says so in Settings.

### 3.5 Your own server

- `harness serve` on the server, signed in there once per provider (`claude setup-token`, `codex login --device-auth`, `agy acp --login`). The app shows the command; it cannot open a Terminal on another machine.
- The app reaches it by forwarding the harness's Unix socket over SSH. No listening port, no TLS and no pairing code to write or get wrong. `harness token new` on the server prints a client token once; the app stores it in the Keychain.
- One harness at a time: this Mac or the server. Pip's turns run where the agents run.
- With the laptop closed, sessions and stage 2 waves go on. A question to you waits. A call to one of the app's tools fails with "the client is away". Pip and its wakes resume when the app reconnects and reads the events it missed. No notice reaches you while no app is open.
- What an agent was given (the ticket text in its brief) and what it wrote rest in the harness's store on the server until clean-up. Pip's text does not.
- The harness holds no Jira or GitHub secret. Git and `gh` on the server use that machine's own credentials, as agents use your shell's today.
- Linux is built and tested in CI. A real server with real logins is not checked by this build.

## 4. Rules, before and after

These are yours to change. They go to `main` as a pull request of their own (plan step G0), because `docs/goals.md` says so.

| Rule | Today | Proposed |
| --- | --- | --- |
| 1 | Nothing writes to Jira or GitHub without the person. | Nothing writes to Jira without a draft you approve. Agents and pipelines write to GitHub by themselves: branches, pull requests, comments, thread replies, issues. Only Gossamr's own code merges, after checking the head commit, the gates, CI, a review bot's own approval and the merge-safety verdict, or when you click. No agent is told to merge. Pip writes nothing and has no tool that answers for you or merges; what Pip wants posted is still a draft. |
| 2 | Secrets live in the macOS Keychain. | Unchanged. The harness's client token joins them, and the harness stores only its hash. The harness holds no Jira or GitHub secret. A session's tools token travels on stdin only (Claude: a control request; Codex: `http_headers`; Gemini: `session/new` headers), never on argv or in the agent's environment. The one exception at rest: agy writes the header, token included, into its own conversation database. As with today's 0600 file, the token reaches only that session's tools and stops working when the session ends or is resumed. |
| 3 | Pip stays locked down. | Pip runs only on a provider and CLI version whose session lists Gossamr's tools and no others, with no settings sources. The provider table is compiled in. |
| 4 | Agents use the person's own setup; no restricting flags. | Unchanged, for every provider: Gossamr adds its tools, a guard, and a model and an effort when one was chosen, and nothing else. Added: Gossamr allows a permission request by itself only for a file edit inside the run's worktree, once, and only where you turned that on. It never allows a command, never picks "always", never answers for Pip. The harness also allows, by itself, a call to the session's own tools endpoint, on every provider. The endpoint has a per-session name drawn at random from a secure source, at least 64 bits, in letters and digits only, and only the exact full tool names built from it are allowed, never a prefix, on Pip's locked session too (Claude `--allowedTools` with `mcp__<name>__<tool>`, Codex `default_tools_approval_mode` on that one server key, Gemini `allow_once` only when the request names exactly `mcp_<name>_<tool>`); today's app does the same with `--allowedTools`. Nothing else is ever allowed that way. The guard tells every agent never to turn off commit signing or hooks, and to report it instead. |
| 5, 6 | Ticket and PR text is data. Shortcuts never fire while you type. | Unchanged. Review-bot comments and repo files that address an agent are data too. |

In `docs/goals.md`:

- "No sandbox or agent harness of its own" becomes "No model, tools or sandbox of its own. The harness starts the provider's own program on your login and adds only its tools and a guard."
- "No hosted service, for now" becomes "No service hosted by us. You can run the harness on your own server."
- "macOS only, for now" becomes "The app is macOS only. The harness also runs on Linux."
- A goal is added: "You set goals and gates for a repo, and Pip builds inside them."
- Providers become "Claude Code, Codex and Gemini (through Antigravity)".

In `docs/product.md`, three sentences stop being true and are reworded: agents "report in prose" (a session may also return a `result` that fits a schema; Gossamr still reads no verdict out of prose), "Permission prompts belong in Terminal", and "never merge".

## 5. What H0 decides

H0 runs every provider for real before anything is built on it. It is a gate: each failure has a stated consequence, and three of them stop the build and come back to you.

| Check | If it fails |
| --- | --- |
| A two-way stream with a permission request answered by the client | On that provider a run that hits a permission request stops with the reason and offers "Take over in Terminal". |
| Resume a session by id after the client is killed | That provider's sessions are marked interrupted on a harness restart. |
| A tool call held open for 9 minutes | `ask` on that provider returns after the provider's limit and the agent ends its turn with the question, as Codex does today. |
| The person's own setup is honoured (settings, hooks, permission rules, instructions) | That path breaks rule 4. Use the provider's native path. If none passes: **stop**. |
| Which program an ACP adapter actually runs | If it is not the person's own unmodified CLI, the adapter is not used. |
| Commit and push from a worktree with no flag from us | The run reports it, as Codex does today under `workspace-write`. |
| Two logins side by side | That provider has one login. Settings says so. |
| Locked profile: advertised tools equal Gossamr's | That provider cannot run Pip. If Claude itself fails: **stop**. |
| The Workflow tool and the plugin work in a harness session | Stage 1 of pipelines is dropped. |
| A provider cannot be driven at all on the owner's login | **Stop** for that provider and report; the others go on. |

## 6. What goes, and what moves

Non-test lines, measured on `main`.

| Leaves the app | Lines | Why |
| --- | --- | --- |
| State inferred from listings: `state.rs`, `final_answer.rs`, `transcript.rs` | 425 | The harness reads the agent's own events. |
| Session adoption: `continuation.rs` and its picker | 210 | A resume no longer starts a copy. |
| `run-index.json`: `index.rs` | 125 | A query does it. |
| Trust writes: `trust.rs`, `service/trust.rs` | 366 | Only `--bg` needs them, if H0 confirms. |
| The Claude backend, the trait and the `--bg` argv: `backend/claude.rs`, `backend.rs`, `cli.rs` | 1,135 | Claude is a provider row. |
| The Codex supervisor: `runs/codex/` | 1,150 | Codex is a provider row. |
| Terminal script writers in `control.rs` | 135 | "Take over in Terminal" needs one command, not an attach. |
| Two answer paths and three message deliveries: `answer.rs`, `message.rs` | 300 | One "send message" call. |
| The polling tracker, replaced by an event consumer | 275 | Events arrive. |
| Launch-failure help and its state machine in the UI | 400 | The harness returns steps. |
| Closed `Driver` tables in Rust and TypeScript | 300 | Providers are read from the harness. |
| Tests of the above | about 4,000 | They test behaviour that is gone. |

Moves into the harness, not deleted (about 2,500 lines with their tests): `repo.rs`, `fresh.rs`, `env.rs`, `provider_env.rs`, `binary.rs`, `provider_folder.rs`, `provider_probe.rs`, `claude/mod.rs` and `stream.rs`, `ask.rs`, and the transport, token and origin checks of `agent/mcp.rs`.

New: the session store and API, the client, the command line, the drivers, the mock provider, the sidecar manager, live output and permission answers in the page, landing, and the workflow host. About 8,000 lines.

The TypeScript mock stays, and each step keeps it in step. Moving the page's tests onto the real harness was considered and cut: it would make UI work need a Rust build.

## 7. What we give up

- **Watching a session you opened in Terminal.** "Take over in Terminal" stops the harness's session and gives you the provider's resume command in the worktree. There is never a second writer.
- **Agents that survive everything.** They survive the app quitting and the app updating. They do not survive the harness stopping; it resumes them.
- **Old builds reading new settings.** A release from before this work locks the providers list when it sees Gemini in `config.json`. There is one user, so this is accepted and stated.
- **A notice with the laptop closed.**
- **Run-time dependencies.** Node, only if an ACP adapter is chosen for Claude or Codex in H0, vendored with a lockfile and integrity hashes and never fetched at run time. The workflow host of stage 2 needs Node.

## 8. Risks

| Risk | What we do |
| --- | --- |
| Provider terms. Anthropic: third-party developers may not "route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users", developers using the Agent SDK "should use API key authentication", plan limits "assume ordinary, individual usage"; and nothing prevents "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". Google: using third-party software "to access the Service" with Antigravity OAuth is a breach and "may be grounds for suspension or termination", while its docs tell editors to launch `agy acp`. | The harness starts only the vendor's own unmodified CLI on your own login and never reads, stores or forwards a provider token. For Claude that means the native `claude -p` path, which Gossamr uses today, and not the SDK-based adapter. H0 records which program every path runs. Whether your use is inside each provider's terms is your decision, most of all before anyone else uses this. |
| An agent is talked into merging or pushing to the default branch with your `gh`. | Section 3.4: Gossamr's own merges are checked in code, and Settings tells you to protect the branch and use a second account. The risk exists today. |
| Hostile text reaches Pip and Pip leaks private ticket text. | Pip keeps no write tool and its GitHub comments stay drafts. |
| Private ticket text reaches GitHub through an agent. Pip puts the ticket in an agent's brief, and the agent may now write to GitHub by itself, so hostile or merely careless text can end up in a pull request or a comment. | Not solved. The brief tells the agent to treat the ticket as data and not to copy it out, which is a request. Before this change the same agent could already push a branch. If a private tracker feeds a public repo, the person should know this; Settings says it where a repo is watched. |
| The harness's API is used by an agent. | Unix socket, client token in the Keychain and proven by challenge, hash only on disk, new tokens only with a valid one. An agent's own token reaches only its session's tools. |
| Agents and the harness run as the same user. | These controls stop accidents and an agent that was talked into something simple. They do not stop a program that sets out to read the harness's store or its memory. The real boundary is another user or another machine, which is what a server gives you. Said in Settings. |
| ACP and Codex's app-server are both moving. | The driver interface does not depend on either. Versions are pinned and features detected. |
| `agy` may allow one Google login and may not run without a terminal. | H0 checks both. |
| The pipeline's script changes weekly. | Pinned by commit in a path only you merge. |
| The size of the change. | Small steps, each merged only after its checks, a separate verification and a separate adversarial review. The app works after every step. |

## 9. Decisions made by the owner (22 Nov 2026)

1. Build straight after the plan, with no sign-off stop. H0's three "stop" rows are the exception this proposal adds.
2. Steps land on the integration branch `harness`; `main` changes when you merge.
3. Steps are verified with real runs on your Claude, Codex and Google logins.
4. Gemini is reached through the Antigravity CLI.
5. GitHub writes no longer need a draft.
6. Pip orchestrates development with the concepts of agent-pr-pipeline.

Decisions this proposal makes that you may want to reverse: Pip's own GitHub comments stay drafts; merging by itself is off by default per repo; quota trouble on one login never switches to another by itself (the connections proposal decided this) but offers the switch in Needs you.

## 10. What the reviews changed

- The first draft moved the whole backend into a daemon and made the harness a library inside it. That half met "independent agent harness" and put 82 commands on a new wire before delivering anything. Now the harness is the sidecar, and the app stays whole.
- A token in a file was readable by every agent. Now the hash is on disk and the token in the Keychain.
- Merge rules lived in a script that agents can skip. Now the app checks and merges.
- Pip had gained a "land" tool and a way to post. Both are gone.
- The Jira token would have rested on a Linux server. Now the harness holds no tracker secret.
- "Boundaries" were undefined. Now there is one setting, in the app, with a narrow meaning.
- Pairing, TLS, generated types, replay of the app's own events, and the move of the page's tests were cut.
- H0 was a check with no consequence. Now it is a gate.

A fourth review read the rewrite and changed it again:

- Stage 1 had an agent run the pipeline's landing steps. Now it runs the wave only, and you merge.
- `harness token new` would have given any agent a client token. Now it needs one.
- "A review bot approved" could not hold here, because this repo's bot never approves, and could be faked by a reply. Now it is an approving review from a bot you name, and a repo without one stays on "I merge".
- Code was to be copied into the harness and kept twice for three waves. Now it moves once and the app imports it.
- Pip's text would have rested in the harness's store. Now a locked session stores none.
- Pip could start a wave on a wake. Now Pip proposes and you start.

## 11. Open after this build

- Pip on a provider other than Claude, unless H0 proves a locked profile.
- Several harnesses at once, with logins per host.
- A real server trial.
- Linear.
