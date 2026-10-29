# Proposal: connections as providers

## 1. Summary

Settings › Connections becomes a list of connection **instances**, the way T3 Code lists its provider instances. You can have more than one of each kind: two Jira sites, or a work and a personal GitHub account. Each instance has an on/off switch, a name you choose and a status line that Gossamr keeps up to date.

How each kind signs in:

- **GitHub** signs in through `gh`. Gossamr reads `gh`'s token for the account it needs, keeps it in memory and never stores it.
- **Jira** keeps Gossamr's own Atlassian sign-in. The client secret lives in a small token broker at `auth.gossamr.app`, so nobody registers their own Atlassian app and no secret ships in the binary. Atlassian's `acli` is an optional "limited" sign-in (Section 4.2 explains why it can't be the main one).
- **Linear** will sign in through the community `linear` CLI when the Linear step resumes.

The data layer already keys everything by connection. The work is mostly in sign-in, in the single-site assumptions of `Core`, and in the Settings screen.

## 2. How T3 Code does it

Read from `pingdotgg/t3code` at commit 37fbefd1.

- **A thin record per instance.** `{driver, displayName, accentColor, enabled, environment[], config}`, keyed by a slug id. The first instance's id is the driver name (`codex`), and later ones get a slug of their label or `_2`. Each driver reads `config` with its own schema (`packages/contracts/src/providerInstance.ts`).
- **A config folder keeps logins apart.** A second Claude is the same binary run with `CLAUDE_CONFIG_DIR=~/.claude_personal`, and Codex uses `CODEX_HOME`. T3 never touches the login itself.
- **Status is one probe per instance.** It returns `{installed, version, status: ready|warning|error|disabled, auth: {status, email, label}, message, checkedAt}`. Probes run every 5 minutes and when you press refresh ("Checked 14m ago"). The screen just draws the last probe result.
- **Sign-in is handed off.** For Claude and Codex, T3 shows the command to run ("Run `claude auth login` and try again"). It runs its own sign-in only where it owns the OAuth app (ChatGPT for Codex).
- **Everything routes by instance id.** A model choice is `{instanceId, model}`, never a driver.
- **Scope.** Settings are per machine, and a project can override only `enabled`. Gossamr runs on one Mac and has no project layer, so neither carries over.

## 3. Gossamr today

| | Jira | GitHub |
|---|---|---|
| Sign-in | Atlassian OAuth (3LO) with a loopback on port 8723. You register your own OAuth app first (`components/Setup.tsx`). | A pasted token, a one-off copy of `gh auth token`, or a device flow when a client id is built in (`auth/github.rs`). |
| Secrets | The vault keys `session` and `oauth-app`, in one Keychain item (`secrets.rs`). | `github:<login>` and the `github-logins` index. A token copied from `gh` is stored, not read live. |
| How many | One. `Auth` holds a single session, and `Core::scope()`, `with_db_for` and `connections()` assume it. Signing in again replaces it. | Many. One session per login, and `CodeService.hosts` is keyed by connection id. The id comes from the login, so the same login on two hosts collides. |
| Settings | A card with Sync now and Sign out. No second site, no on/off, no name. `ReauthBanner` is Jira-only. | A card per account and a dashed "Connect GitHub" row. |

The data is already keyed by connection. `items` uses `(connection_id, external_id)`, drafts, runs and workstreams carry `connection_id`, and each account has its own SQLite file. PROJ-1 on two sites is already two items.

Agents never get Gossamr's tokens. They use your own `gh` and git, and `runs/fresh.rs` already falls back to `gh repo clone`.

## 4. What each CLI can do

### 4.1 GitHub: `gh`

Checked against `gh` 2.97.0.

- `gh auth status --json hosts` lists every account on every host. It always exits 0 in JSON mode, so read each account's state.
- `gh auth token -h HOST -u LOGIN` prints the token for one account without switching the active account.
- `GH_CONFIG_DIR` keeps a separate config folder, if someone wants one.
- The default scopes are `repo`, `read:org` and `gist`. Gossamr also asks for `notifications`, which the person adds with `gh auth refresh -h github.com -s notifications`.

Verdict: Gossamr reads the token from `gh`. Every feature keeps working, because Gossamr still calls GitHub's API itself.

### 4.2 Jira: `acli`

Checked against `acli` 1.3.39 without signing in (29 October 2026).

- **No token to borrow.** There is no `auth token` command and no general API command. The token sits in the Keychain via go-keyring, in a format Gossamr shouldn't depend on.
- **Status is text.** `acli jira auth status` has no `--json`. Signed out, it prints `✗ Error: unauthorized: use 'acli jira auth login' to authenticate` and exits 1.
- **Config folder.** `ACLI_CONFIG_DIR` and `HOME` move the config folder; `XDG_CONFIG_HOME` doesn't. Within one folder, sites are profiles picked with `auth switch`, which changes global state. Whether the Keychain entry is separate per folder is unproven until someone signs in twice.
- **Telemetry.** On by default. The binary bundles Segment analytics and Sentry and stores an `anonymous_id`. No opt-out was found.

Running `acli` for every read and write covers the basics. `workitem search` and `view` take `--json`, `--fields` and `--paginate`, `comment create` accepts ADF from a file, and `transition` and `edit` take `--yes`. It doesn't cover the rest of what `tracker/jira/client.rs` uses:

| Gossamr uses | REST call today | `acli` |
|---|---|---|
| Ticket history, for Activity and change events | `issue/{key}?expand=changelog`, `issue/{key}/changelog` | No |
| Status drafts: allowed moves and their required fields | `issue/{key}/transitions?expand=transitions.fields` | No. Moves by status name only and can't list transitions |
| @mention suggestions | `user/viewissue/search` | No |
| Attachment previews | attachment download | No. List and delete only |
| Project statuses, sub-task types | `project/{p}/statuses`, `issue/createmeta` | No |
| Search, view, comments, projects | `search/jql`, `issue`, `comment`, `project/search` | Yes, with `--json` |
| Comment, edit, assign | `POST comment`, `PUT issue` | Mostly. No arbitrary custom fields |

Verdict: `acli` would replace a working client with a weaker one. It stays an optional "limited" sign-in, which turns off history, @mentions, attachments and status drafts for that connection.

### 4.3 Linear: `linear`

From the docs only; the CLI isn't installed and there's no workspace to test with.

- There is no official CLI. The de facto one is `schpet/linear-cli` (`brew install schpet/tap/linear`).
- It keeps API keys in the Keychain. `linear auth token --workspace SLUG` prints the key for one workspace, and `linear auth list` shows the workspaces.
- The key goes in `Authorization` with no `Bearer` prefix.

Verdict: Gossamr reads the key from `linear`, once the Linear step resumes.

## 5. Decisions

1. **GitHub signs in through `gh` only.** The pasted-token and device-flow paths go. A GitHub App was considered and set aside: work orgs often need an admin to approve it, and the notifications API probably doesn't accept its tokens. It needs no broker if it comes back (device-flow tokens refresh without a secret, and `auth/github.rs` already does that).
2. **Jira keeps Gossamr's Atlassian sign-in,** through the token broker at `auth.gossamr.app` (Section 8). Bring-your-own-app stays as a fallback in Advanced. This replaces decision 7 of the simplification proposal.
3. **`acli` is an optional limited mode,** built only if someone asks for it.
4. **The broker is public,** in this repo under `broker/`, and deployed from CI.

## 6. The model

### 6.1 Instances sit on top of connections

There are two ids, each with one job.

- The **instance id** is a slug you can see (`github`, `github_personal`, `jira_side`). It names a row in Settings.
- The **connection id** stays what it is today (`jira:<cloudId>:<accountId>`, `github:<login>`). It comes from the account and keys every cached row and DB file.

A probe finds which account an instance signs in as, and that gives the instance's connection. Pointing an instance at a different account binds it to a different connection, and the old cache is cleaned up. The `jira:` id format doesn't change, so nothing stored has to move. GitHub Enterprise connection ids gain the host (`github:<host>:<login>`); github.com keeps today's form.

Instances live in `config.json`, which never holds a secret:

```json
"connections": [
  { "id": "jira", "kind": "jira", "displayName": "Acme Jira", "enabled": true, "accent": "#4a5be0",
    "config": { "method": "atlassian", "site": "acme.atlassian.net" }, "boundTo": "jira:5f1c…:712020:ab-cd" },
  { "id": "github", "kind": "github", "displayName": "GitHub", "enabled": true,
    "config": { "cli": "gh", "host": "github.com", "login": "alfhen-acme" }, "boundTo": "github:alfhen-acme" },
  { "id": "sample", "kind": "mock", "displayName": "Sample data", "enabled": false }
]
```

### 6.2 Probes and snapshots

Each kind has a probe that returns a snapshot: installed, version, state, account, scopes, message, the fix to run, and when it was checked.

- GitHub: `gh auth status --json hosts`, plus a scope check.
- Jira (Atlassian sign-in): the stored session and a call to `/myself`.
- Linear: `linear auth list`.

Probes run at launch, every 5 minutes, when the window gets focus, when you press refresh, and after a sync gets a 401. A snapshot is announced on the existing `changed` event under a new `Connections` topic, so no fifth event is added.

### 6.3 Credentials

A `CredentialSource` replaces the stored-session lookup in `GithubAuth.fresh`. For GitHub it runs `gh auth token -h HOST -u LOGIN`, keeps the result in memory, and on a 401 drops it, reads it once more, then marks the instance *Not signed in*. For Jira it wraps today's OAuth session, one per instance, refreshed through the broker and kept in the Keychain.

The adapters (`WorkTracker`, `CodeHost`) keep their shape. Gossamr runs each CLI with an argument list and no shell, and sets only the instance's config-folder variable if it has one. It never runs `login`, `logout` or `auth switch` for you.

### 6.4 Turning a connection off

Off means Gossamr stops syncing it, its items leave the Inbox, Board and List, and Pip's tools can't see it. Drafts that target it wait, with "GitHub is off. This draft waits until you turn it on." Its cache is kept. This replaces Sign out, which also cleared Pip's conversations.

Remove deletes what Gossamr cached for the instance and nothing else. You stay signed in to the CLI.

### 6.5 Every draft names its account

With two GitHub accounts, approving a draft has to make clear which one posts. Drafts already carry a `connection_id`. The draft card adds "Posts as alfhen-acme via GitHub", with the instance's accent colour. If two instances can see a repo, the one that watches it is the default, and you can pick the other before you approve.

### 6.6 Left out on purpose

- **Per-instance environment variables.** In T3 they hold API keys, which in Gossamr would put secrets on disk. Only the CLI path and config folder are offered.
- **Project and machine scope.** Each instance's Watching list (projects, repositories, teams) does the job of T3's per-project overrides.
- **An embedded sign-in terminal.** Copy and Open Terminal cover it.

## 7. The Settings screen

Settings gets a short side list (General, Connections, Watching, Agents). Connections is two panes:

- **The list.** Each row has the kind badge, name, CLI version, status line and on/off switch. "+ Add connection" sits at the bottom, and "Checked 3m ago" with a refresh button at the top.
- **The detail pane.** Status (with the fix, if any), Display name, Account (Change account, Remove), Sync, Watching, Advanced (CLI path, config folder, host or site, and Jira's sign-in method) and a line saying who drafts post as.

| State | List line | Detail | Fix |
|---|---|---|---|
| Ready | Authenticated · alf@acme.com | Signed in as alf@acme.com on acme.atlassian.net | none |
| Needs attention | Needs attention · missing scope | Missing the notifications scope, so review requests won't show. | `gh auth refresh -h github.com -s notifications` |
| Not signed in | Not signed in | gh has no login for alfhen on github.com. | `gh auth login -h github.com` |
| Not found | Not found · linear CLI | linear isn't installed. | `brew install schpet/tap/linear` |
| Checking | Checking… | Checking with gh… | none |
| Off | Off | Off. Gossamr doesn't sync it, Pip can't see it and drafts for it wait. What's cached is kept. | none |

Each fix has Copy, Open Terminal and "I've run it, check again". `ReauthBanner` becomes one banner for any instance that drops to *Not signed in* while it's on.

**Add connection** has three steps: Kind, Account and Name.

- For GitHub, Account lists the accounts `gh` knows, marks the ones already connected, and offers "Another account" with the login command.
- For Jira, Account asks how to sign in: Sign in with Atlassian (recommended) or acli (limited).
- Name sets the label, the id slug and an optional accent colour.

**First run** replaces `Setup.tsx`'s register-an-app steps. It shows what Gossamr found: `gh` and who it's signed in as, Sign in with Atlassian, and whether `linear` is installed.

## 8. The token broker

Atlassian's 3LO needs a client secret to exchange a code for tokens and to refresh them, and it doesn't offer PKCE. A secret shipped in the app can be extracted. A broker keeps it on Cloudflare.

- **Where.** A Cloudflare Worker on `auth.gossamr.app`, a Custom Domain on the `gossamr.app` zone.
- **What it does.** One route, `POST /oauth/token`. It accepts `authorization_code` only with the `http://localhost:8723/callback` redirect, and `refresh_token`. It adds the client id and secret, forwards to `auth.atlassian.com/oauth/token` and returns the reply. It stores nothing, doesn't log request bodies, and has a per-IP rate-limit binding.
- **`GET /version`** returns the commit it was built from, so anyone can compare it with the repo.
- **Secrets.** The Atlassian secret is set once with `wrangler secret put` and never enters the repo or GitHub. CI holds only a Cloudflare API token limited to editing Workers on that account, and deploys on pushes to `main` that touch `broker/`.
- **In Gossamr.** `auth/atlassian.rs` already posts to a configurable `{auth}/oauth/token`. `AuthMethod::Broker { base_url }` already exists but can't be used. Making it usable points the token call at the broker and leaves out `client_secret`.
- **Changing the secret** happens only on Cloudflare. No installed copy changes.
- **Cost.** The Workers Free plan allows 100,000 requests a day. At roughly one refresh an hour while the app is open, that covers a few thousand daily users.

## 9. The six rules

| Rule | Effect |
|---|---|
| 1. Nothing writes without you | Unchanged. Drafts also name the account they post as. |
| 2. Secrets in the Keychain | Stronger for GitHub and Linear: Gossamr stops storing their tokens. Jira sessions stay in the vault, one per instance. `config.json` holds ids, names and paths only. The rule's wording needs updating. |
| 3. Pip stays locked down | Unchanged. Probes and token reads run in Rust, not through Pip. |
| 4. Agents use your own setup | Unchanged. No token or config folder is passed to agents. Gossamr and its agents now share your `gh` login. |
| 5. Ticket text is data | Unaffected. CLI output is parsed as JSON. |
| 6. No shortcuts while typing | The list's arrow keys follow it. |

## 10. Order of work

Each step is its own pull request from `main`.

| Step | What | Depends on |
|---|---|---|
| 1 | **Instances in `config.json`.** The `connections` list, and a one-time migration that builds instances from what's stored: `session` becomes `jira`, each `github:<login>` becomes `github`, `github_2` and so on, and sample data becomes `sample`. `connections_list` returns instances, and `ConnectionInfo` gains `instanceId`, `displayName`, `enabled` and `accent`. No change in behaviour. Mock updated. | none |
| 2 | **Probes and snapshots.** A probe per kind, the refresh schedule, and `Topic::Connections` in `wire.rs` and `events.ts`. The mock scripts each state for e2e. | 1 |
| 3 | **The Connections screen.** The list and detail panes, Add connection and First run. Replaces `ConnectGithub.tsx` and the Jira-only `ReauthBanner`. A new e2e feature suite. | 2 |
| 4 | **GitHub from `gh`.** `CredentialSource` for `gh`. Drop the pasted-token and device-flow paths, and the `github:<login>` vault entries once `gh` is known to have that login; if it doesn't, the instance shows *Not signed in* with the command. | 2 |
| 5 | **On, off and draft targeting.** Off skips sync, hides from views and Pip's tools, and holds drafts. Draft cards show who they post as. Sign out no longer clears Pip's conversations. | 3 |
| 6 | **The broker.** `broker/` with the Worker, its tests, the `/version` route and the deploy workflow. Register the Gossamr Atlassian app and make `AuthMethod::Broker` usable. | none |
| 7 | **Many Jira sites.** `Auth` per instance, with a vault key per instance in place of `session`. `Core::scope()` and `with_db_for` become per connection, with several DBs open. `connections()` returns N rows, and `SiteChanged` applies per instance. The site picker comes from `accessible_sites`. The loopback port is fixed at 8723, so only one sign-in runs at a time. | 1, 6 |
| 8 | **Linear.** A `linear` credential source and a GraphQL `WorkTracker`. This is step 9 of the simplification proposal, on hold until there's a workspace. | 7 |
| 9 | **Tidy-up.** Remove the unused `AuthMethod` variants, update rule 2 in `AGENTS.md`, and the README's Jira section. | 4, 7 |
| later | **Optional: `acli` limited mode.** An `AcliTracker` that runs `acli` with `ACLI_CONFIG_DIR` per instance. History, @mentions, attachments and status drafts are off for those connections. Only if someone asks. | 7 |

## 11. Risks and open questions

- **The broker is a dependency.** Access tokens last about an hour. If `auth.gossamr.app` is down for longer than that, people see the "Jira signed out" banner, and signing in again needs the broker too. Tokens pass through the Worker without being stored, and a privacy page on `gossamr.app` should say so.
- **Atlassian's rules for a shared app.** An app used by other people's sites is set to "Sharing" in the developer console, with a personal-data declaration. Gossamr caches names and account ids on the person's Mac. Check whether Atlassian expects its Personal Data Reporting API before step 7.
- **Moving off stored GitHub tokens.** Someone with a pasted token and no `gh` loses access on upgrade. The *Not found* state shows `brew install gh`. A one-release grace period that keeps the stored token read-only is an option.
- **Cost of reading tokens.** `gh auth token` takes about 50 to 100 ms. Caching in memory keeps it to one call per instance per launch, plus one after each 401.
- **Org SSO.** A token that isn't authorised for an SSO org fails only on that org's repos. The probe can't tell in advance, so the sync error keeps today's "authorise the organisation" copy.
- **One repo seen by two accounts.** The instance that watches it owns it, then list order. `codeConnectionFor` in Rust and the mock need checking.
- **The community Linear CLI** is someone else's tool. If it changes, Linear can fall back to a personal API key in the Keychain, the one kind where Gossamr would store a secret.
