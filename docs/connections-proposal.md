# Proposal: connections as providers

## 1. Summary

Settings › Connections becomes a list of connection **instances**, the way T3 Code lists its provider instances. Each instance has an on/off switch, a name and a status line that Gossamr keeps up to date. The list is shaped for several of each kind. GitHub keeps the several accounts it supports today, and Jira stays at one site until someone needs a second (Section 6.9 says what that would take).

How each kind signs in:

- **GitHub** signs in through `gh`. Gossamr reads `gh`'s token for the account it needs each time it needs one, and never stores it.
- **Jira** signs in with a scoped Atlassian API token. A button opens Atlassian's token page with the app, scopes and expiry already filled in; you press Create and paste the token into Gossamr. There is no OAuth app, no loopback callback and no hosted service. Atlassian sign-in, bring-your-own-app and `acli` all go.
- **Linear** will read its key from the community `linear` CLI when the Linear step resumes.

Most of the work is in sign-in and the Settings screen. One piece of groundwork comes first: drafts, runs, workstreams and Pip's conversations live in the Jira database today, and they move to an app database before a connection can be turned off or removed (Section 6.5).

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
| How many | One. `Auth` holds a single session, and `Core::scope()`, `with_db_for` and `connections()` assume it. Signing in again replaces it. | Many. One session per login, and `CodeService.hosts` is keyed by connection id. Only github.com: the API base is fixed in three places. |
| Settings | A card with Sync now and Sign out. No second site, no on/off, no name. `ReauthBanner` is Jira-only. | A card per account and a dashed "Connect GitHub" row. |

Cached rows are keyed by connection: `items` uses `(connection_id, external_id)`, and each account has its own SQLite file. But the Jira file is also the home of everything that isn't GitHub cache:

- drafts (`proposals`), including GitHub review drafts, which are made and posted through the Jira scope (`inbox/code.rs`);
- runs and their events, reports and messages;
- workstreams, including ones with no ticket;
- Pip's turns, which have no `connection_id`, and Pip's session ids and agent tokens in `meta`.

So the Jira database is not just a cache, and Section 6.5 moves that state out.

Agents never get Gossamr's tokens. They use your own `gh` and git, and `runs/fresh.rs` already falls back to `gh repo clone`.

## 4. What each sign-in can do

### 4.1 GitHub: `gh`

Checked against `gh` 2.97.0, with release notes up to 2.103.0.

- `gh auth status --json hosts` lists every account on every host. It always exits 0 in JSON mode, so read each account's state.
- `gh auth token -h HOST -u LOGIN` prints the token for one account without switching the active account.
- Since 2.103.0 you can opt in to expiring tokens that `gh` refreshes itself. Its notes say not to cache the output of `gh auth token`, so Gossamr asks for the token each time it needs one.
- `GH_TOKEN` and `GITHUB_TOKEN` override the stored token and are never refreshed. Gossamr clears them when it runs `gh`.
- `gh auth refresh` acts on the active account only.
- `gh` keeps tokens in the Keychain, or in plaintext in `hosts.yml` when signed in with `--insecure-storage`. Homebrew's `gh` is ad-hoc signed, so after an upgrade macOS may ask again for Keychain access.
- The default scopes are `repo`, `read:org` and `gist`. Gossamr reads notifications with `repo`, which `can_read_notifications` already accepts, so no extra scope is needed.

Verdict: Gossamr reads the token from `gh`. Every feature keeps working, because Gossamr still calls GitHub's API itself.

### 4.2 Jira: scoped API tokens

Checked against Atlassian's docs and the token page itself on 29 October 2026.

- **You make the token.** No app can issue one. At `id.atlassian.com/manage-profile/security/api-tokens` you choose Create API token with scopes, then a name, an expiry of 1 to 365 days, the app and the scopes. The token is shown once, and its scopes can't be changed later.
- **The page can be filled in from the link.** It reads five parameters: `autofillToken`, `appId`, `expiryDays` (a number or `max`), `selectedScopes` (a JSON array of scope names, or `all`) and `cleanup_on_close`. With `appId=jira`, the page opens on its review step with everything set. Only Atlassian's Rovo guide documents this.
- **The name is generated.** With `appId` set, the page names the token `JIRA_<date>_<time>`. There is no parameter for it. You can press Back and rename it before creating.
- **Your organisation can limit tokens.** `max` means the most your organisation's authentication policy allows, which may be under 365 days. The page also has a state where policy blocks token creation entirely.
- **Requests go through the gateway.** Basic auth with `email:token` to `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/…`. Scoped tokens don't work on `yoursite.atlassian.net`. `tracker/jira/client.rs` already uses the gateway base.
- **The cloud id** comes from the site's `/_edge/tenant_info`, which needs no sign-in. Atlassian doesn't document it; the documented way needs admin access.
- **Scopes.** The page offers 392 Jira scopes, classic and granular. The three classic ones, `read:jira-work`, `write:jira-work` and `read:jira-user`, should cover the client. Step 0 confirms that.

Verdict: Jira signs in with a scoped API token. Gossamr keeps its own REST client and every feature.

### 4.3 Jira: what was set aside

**Atlassian sign-in (3LO).** It needs a client secret to exchange a code and to refresh, and it has no PKCE. A secret in the app can be extracted, so a shared Gossamr app would need a hosted broker that adds the secret. Anyone could then use the broker to redeem a code or refresh token as Gossamr, and the broker would see every token. A shared app also has to report through Atlassian's Personal Data Reporting API, because Gossamr caches names and account ids. Bring-your-own-app avoids the broker, but Atlassian's 3LO guidance says apps that ask customers to create their own 3LO apps don't comply.

**`acli` 1.3.39,** checked without signing in. It has no command that hands out a token and no general API command. `acli jira auth status` has no `--json`. It sends telemetry by default, with no opt-out found. Running `acli` for every call covers search, view, comments and projects, but not what `tracker/jira/client.rs` also uses:

| Gossamr uses | REST call today | `acli` |
|---|---|---|
| Ticket history, for Activity and change events | `issue/{key}?expand=changelog`, `issue/{key}/changelog` | No |
| Status drafts: allowed moves and their required fields | `issue/{key}/transitions?expand=transitions.fields` | No. Moves by status name only |
| @mention suggestions | `user/viewissue/search` | No |
| Attachments | download, upload and `attachment/meta` | No. List and delete only |
| Project statuses, sub-task types | `project/{p}/statuses`, `issue/createmeta` | No |
| Create issues and sub-tasks, link issues | `POST issue`, `POST issueLink` | Not checked |

### 4.4 Linear: `linear`

From the docs only; the CLI isn't installed and there's no workspace to test with.

- There is no official CLI. The de facto one is `schpet/linear-cli` (`brew install schpet/tap/linear`), at 3.1.0.
- It keeps API keys in the Keychain. `linear auth token --workspace SLUG` prints the key for one workspace. `linear auth list` prints a text table, not JSON.
- `LINEAR_API_KEY` or a `.linear.toml` in the working folder takes precedence over stored keys, so Gossamr clears the variable and runs it from a fixed folder.
- The key goes in `Authorization` with no `Bearer` prefix.

Verdict: Gossamr reads the key from `linear`, once the Linear step resumes.

## 5. Decisions

1. **One Jira site for now.** GitHub keeps its several accounts. `config.json` holds a list, so a second Jira instance needs no migration later. Nobody has asked for one yet, and it is the costliest part (Section 6.9).
2. **GitHub signs in through `gh` only.** The pasted-token and device-flow paths go. A GitHub App was considered and set aside: an organisation owner has to install it, and the notifications API accepts only classic personal access tokens.
3. **Jira signs in with a scoped API token only.** Atlassian sign-in, bring-your-own-app and `acli` go (Section 4.3). This replaces decision 7 of the simplification proposal.
4. **App state gets its own database** before a connection can be turned off or removed.

## 6. The model

### 6.1 Instances sit on top of connections

There are two ids, each with one job.

- The **instance id** is a slug you can see (`jira`, `github`, `github_2`). It names a row in Settings. Ids are never reused, so removing `github` and adding an account gives `github_3`.
- The **connection id** stays what it is today (`jira:<cloudId>:<accountId>`, `github:<login>`). It comes from the account and keys every cached row and DB file.

A probe finds which account an instance signs in as, and that gives the instance's connection. Binding follows these rules:

- A GitHub instance binds to the account's numeric user id. Logins can be renamed and differ in case (`gh` says `Alfhen`, Gossamr stores `alfhen`).
- The probe asks `gh` about the login in `config`, never the active account, so `gh auth switch` changes nothing.
- A failed probe (no network, a 5xx, `gh` not found) never counts as a different account.
- When the account really is different, Gossamr asks first ("Signed in as X, was Y") and deletes nothing.
- Two instances can't bind to the same connection. A collision shows an error instead.

GitHub Enterprise stays out of scope. If it comes, the host goes into the connection id, the DB file name and the vault key together.

Instances live in `config.json`, which never holds a secret:

```json
"connections": [
  { "id": "jira", "kind": "jira", "displayName": "Acme Jira", "enabled": true,
    "config": { "site": "acme.atlassian.net", "email": "alf@acme.com" }, "boundTo": "jira:5f1c…:712020:ab-cd" },
  { "id": "github", "kind": "github", "displayName": "GitHub", "enabled": true,
    "config": { "host": "github.com", "login": "alfhen-acme", "userId": 1234567 }, "boundTo": "github:alfhen-acme" }
]
```

`boundTo` is a hint. The vault and the databases say which connections exist.

### 6.2 Keeping `config.json` safe

Today `AppConfig::load` returns all defaults when the file doesn't parse, and saving drops keys the build doesn't know. That's fine for preferences, but not for the instance list.

- `connections` is parsed on its own. If it doesn't parse, Gossamr keeps the file, copies it to `config.json.bak` and shows an error. It doesn't start over.
- The file records a version. The migration runs once and only when the vault is `Ready`; a Keychain error that looks like "no accounts" must not migrate to an empty list.
- Nothing is deleted because `config.json` doesn't mention it.

### 6.3 Probes and snapshots

Each kind has a probe that returns a snapshot: installed, version, state, account, message, the fix to run, and when it was checked.

- GitHub: `gh auth status --json hosts`, for the login in `config`.
- Jira: `GET /myself` with the stored token.
- Linear: `linear auth list`.

Probes run at launch, when the window gets focus, when you press refresh, and after a 401. Each has a timeout, because `gh` can wait on a Keychain prompt. A new snapshot is announced on the existing `changed` event under a new `Connections` topic, and the page re-reads `connections_list`, so no fifth event is added.

### 6.4 Credentials

A `CredentialSource` replaces the stored-session lookup.

- **GitHub.** Runs `gh auth token -h HOST -u LOGIN` each time it needs a token. `gh` is found in `/opt/homebrew/bin`, then `/usr/local/bin`, then `PATH`; a Finder-launched app's `PATH` has neither. `GH_TOKEN`, `GITHUB_TOKEN` and `GH_HOST` are cleared. On a 401, Gossamr reads the token once more, then marks the instance *Not signed in*. `GithubHost` holds a token today and hosts are cached for good when it has no expiry, so the host has to ask the source per request.
- **Jira.** The email and token sit in the vault under the connection's key, in place of `session` and `oauth-app`. There is nothing to refresh. A 401 marks the instance *Not signed in*.

The adapters (`WorkTracker`, `CodeHost`) keep their shape. Gossamr runs each CLI with an argument list and no shell. It never runs `login`, `logout` or `auth switch` for you.

### 6.5 App state moves out of the Jira database

Drafts, runs and their events, reports and messages, workstreams, Pip's turns and the `meta` rows for Pip's sessions and agent tokens move to `app.sqlite`. Each connection's file then holds only cache. Until this lands:

- turning Jira off would break `Core::scope()`, and with it drafts (GitHub's too), workstreams, Pip and agents;
- removing Jira would delete all of that.

### 6.6 Turning a connection off

Off means Gossamr stops syncing it, its items leave the Inbox, Board and List, and Pip's tools can't see it. Drafts that target it wait, with "GitHub is off. This draft waits until you turn it on." Its cache is kept. This replaces Sign out, which also cleared Pip's conversations.

- Off waits while a draft is being posted. Today, reopening a database resets drafts that were mid-post to Pending, which could post them twice.
- Databases stay open for the life of the app, and that recovery runs once per database per launch.
- After you turn a connection back on, its waiting drafts can be approved only after the first sync has checked them again, and each one shows how old it is.
- Pip's existing conversations still contain what it read before. Off hides the connection from Pip's tools, not from its history.

Remove deletes what Gossamr cached for the instance and the token Gossamr stored. Drafts that target it are closed with a reason. Your `gh` login is untouched.

### 6.7 Every draft names its account

The draft card adds "Posts as alfhen-acme via GitHub". A draft's account is fixed when it is made, as it is today. If two GitHub instances can see a repo, the one that watches it makes the draft, then the lower connection id, as `code_connection_for` does today. Turning an instance off or rebinding it never moves a draft to another account; changing the account means a new draft.

Agents clone and push with `gh`'s active account, because `runs/fresh.rs` doesn't pass `-u`. The detail pane says so, and which account that is.

### 6.8 Left out on purpose

- **A second Jira site.** See 6.9.
- **Per-instance environment variables, CLI path and config folder.** In T3 they hold API keys, which in Gossamr would put secrets on disk, and a CLI path in a plain file decides what Gossamr runs.
- **Accent colours.** The "Posts as" line already names the account.
- **Project and machine scope.** Each instance's Watching list (projects, repositories, teams) does the job of T3's per-project overrides.
- **An embedded sign-in terminal.** Copy and Open Terminal cover it.

### 6.9 What a second Jira site would take

- `Core::scope()` and `with_db_for` per connection: 48 `scope()` call sites, the run supervisor, agent tools and 15 Tauri commands.
- A front end that doesn't pick its backend from the one Jira sign-in (`Root.tsx`), and a mock with more than one tracker.
- A rule for PR titles that name a key two sites share.

## 7. The Settings screen

Connections lists one row per instance: the kind badge, name, status line and on/off switch, with "Checked 3m ago" and a refresh button at the top. Selecting a row opens its detail: Status (with the fix, if any), Display name, Account (Change account, Remove), Sync, Watching, the site or host, and a line saying who drafts post as. For GitHub it also says which account agents push as.

| State | List line | Detail | Fix |
|---|---|---|---|
| Ready | Authenticated · alf@acme.com | Signed in as alf@acme.com on acme.atlassian.net | none |
| Expires soon | Token expires in 9 days | Your Jira token expires on 7 Nov. Make a new one and paste it here. | Create token |
| Not signed in | Not signed in | gh has no login for alfhen on github.com. | `gh auth login -h github.com` |
| Not found | Not found · gh | gh isn't installed. | `brew install gh`, or the installer from cli.github.com |
| Off | Off | Off. Gossamr doesn't sync it, Pip can't see it and drafts for it wait. What's cached is kept. | none |

While a probe runs, the status line shows a spinner. Each fix has Copy, Open Terminal and "I've run it, check again". `ReauthBanner` becomes one banner for any instance that drops to *Not signed in* while it's on.

**Connect Jira** is one sheet:

1. Your site (`acme.atlassian.net`). Gossamr looks up its cloud id.
2. **Create token**, which opens the filled-in token page. The sheet says to press Create there and copy the token. If the page doesn't fill in, the sheet lists the scopes to tick, with Copy.
3. Your email, the token and its expiry date, which defaults to a year from today. Atlassian doesn't report it.
4. Gossamr calls `/myself`, shows who you are, and saves.

**Connect GitHub** lists the accounts `gh` knows and offers "Another account" with the login command.

**First run** replaces `Setup.tsx`'s register-an-app steps. It shows `gh` and who it's signed in as, and Connect Jira.

## 8. Jira sign-in with a scoped API token

The **Create token** button opens:

```
https://id.atlassian.com/manage-profile/security/api-tokens?autofillToken&expiryDays=max&appId=jira&selectedScopes=["read:jira-work","write:jira-work","read:jira-user"]
```

with the brackets and quotes URL-encoded. Atlassian opens on Review your API token with the name, the expiry, Jira and the three scopes filled in.

- **Scopes.** Pick them once, because a token's scopes can't change. If Gossamr later needs another, everyone makes a new token. Step 0 runs every call in `tracker/jira/client.rs` with these three: the changelog, transitions with fields, user search, attachment download and upload, create issue and issue links.
- **The connection id** stays `jira:<cloudId>:<accountId>`, with the account id from `/myself`. If it matches what Atlassian sign-in gave, today's cache carries over.
- **Expiry.** Gossamr stores the date you give it and warns 14 days before. A 401 before then means the token was revoked.
- **The fallback.** The autofill parameters are undocumented. If they stop working, the button opens the plain token page and the sheet lists the scopes to tick.
- **Upgrading.** The Atlassian session is dropped and you paste a token once.

What goes: `auth/callback.rs`, the code exchange and refresh in `auth/atlassian.rs`, the refresh lock, the `session` and `oauth-app` vault keys, and the `OAuthCode`, `DeviceFlow`, `GhCli` and `Broker` variants of `AuthMethod`. `ApiToken { fields }` already exists and becomes the one Jira method.

## 9. The six rules

| Rule | Effect |
|---|---|
| 1. Nothing writes without you | Unchanged. Drafts also name the account they post as. |
| 2. Secrets in the Keychain | Gossamr stops storing GitHub and Linear tokens, and stores one Jira token per connection. But GitHub's token is now as safe as `gh` keeps it: in the Keychain, or in plaintext in `hosts.yml` if you chose that. Gossamr also gets whatever scopes `gh` holds, which may be more than it needs. The rule's wording needs updating to say so. |
| 3. Pip stays locked down | Unchanged. Probes and token reads run in Rust, not through Pip. |
| 4. Agents use your own setup | Unchanged for agents. Gossamr and its agents now share your `gh` login, so GitHub's audit log can't tell writes you approved from an agent's own. |
| 5. Ticket text is data | Unaffected. `gh` output is parsed as JSON. `linear auth list` is a text table, so Linear reads it with care. |
| 6. No shortcuts while typing | The list's arrow keys follow it. |

## 10. Order of work

Each step is its own pull request from `main`.

| Step | What | Depends on |
|---|---|---|
| 0 | **Spike: a scoped token on a real site.** Run every call in `tracker/jira/client.rs` with the three scopes. Check the `tenant_info` lookup, that `/myself` gives today's account id, and the filled-in link. This is also the real-Jira trial. | none |
| 1 | **Instances in `config.json`.** The `connections` list, parsed on its own and failing closed, with a version. A one-time migration, only when the vault is `Ready`: `session` becomes `jira`, and each `github:<login>` becomes `github`, `github_2` and so on, in the order of the `github-logins` index. `connections_list` returns instances, and `ConnectionInfo` gains `instanceId`, `displayName` and `enabled`. No change in behaviour. Mock updated. | none |
| 2 | **Probes and snapshots.** A probe per kind with timeouts, the refresh triggers, and `Topic::Connections` in `wire.rs` and `events.ts`. The mock scripts each state for e2e. | 1 |
| 3 | **Jira by API token.** `AuthMethod::ApiToken`, the Connect Jira sheet in place of `Setup.tsx`'s steps, the vault key per connection, and the expiry warning. Delete Atlassian sign-in (Section 8). | 0, 1 |
| 4 | **The Connections screen.** The list, the detail pane and First run. Replaces `ConnectGithub.tsx` and the Jira-only `ReauthBanner`. A new e2e feature suite. | 2, 3 |
| 5 | **GitHub from `gh`.** `CredentialSource` for `gh`, with `GithubHost` asking it per request. Drop the pasted-token and device-flow paths, and the `github:<login>` vault entries once `gh` is known to have that login; if it doesn't, the instance shows *Not signed in* with the command. | 4 |
| 6 | **The app database.** Move drafts, runs, workstreams, Pip's turns and their `meta` rows to `app.sqlite`, with a migration that copies first and deletes later. | none |
| 7 | **On, off and draft safety.** Off skips sync, hides from views and Pip's tools, holds drafts and waits for a post in progress. Recovery once per database per launch. Draft cards show who they post as. Sign out no longer clears Pip's conversations. | 4, 6 |
| 8 | **Tidy-up.** Update rules 2 and 4 in `AGENTS.md`, and the README's Jira section. | 5, 7 |
| 9 | **Linear.** A `linear` credential source and a GraphQL `WorkTracker`. This is step 9 of the simplification proposal, on hold until there's a workspace. | 7 |
| later | **A second Jira site,** if someone asks (Section 6.9). | 7 |

## 11. Risks and open questions

- **The autofill parameters are undocumented.** If Atlassian changes them, the button opens the plain page and you tick the scopes yourself.
- **Your organisation may block or shorten tokens.** If policy blocks token creation, Gossamr can't connect to that site. Atlassian sign-in could come back as a second method then, with the broker and the obligations in Section 4.3.
- **A new token every year at most.** The expiry warning covers it, but it's a chore 3LO didn't have.
- **The scopes can't change.** If a later feature needs a new scope, everyone makes a new token.
- **The cloud id lookup is undocumented.** If `tenant_info` goes, the sheet asks for the cloud id and says where an admin finds it.
- **Moving off stored GitHub tokens.** Someone with a pasted token and no `gh` loses access on upgrade. The *Not found* state shows how to install `gh`. A one-release grace period that keeps the stored token read-only is an option.
- **Keychain prompts from `gh`.** After a Homebrew upgrade of `gh`, a probe may wait on a prompt. The probe's timeout keeps Gossamr responsive, and the status says to run a `gh` command once.
- **Agents push as `gh`'s active account,** whichever instance a workstream's repo belongs to. Passing `-u` would need git's credential helper to follow, so it waits until someone has two accounts on one repo.
- **Org SSO.** A token that isn't authorised for an SSO org fails only on that org's repos. The probe can't tell in advance, so the sync error keeps today's "authorise the organisation" copy.
- **The community Linear CLI** is someone else's tool. If it changes, Linear can fall back to a personal API key in the Keychain, as Jira does.
