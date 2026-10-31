# First trial against a real Jira site

Gossamr's Jira calls were written from Atlassian's REST v3 documentation and tested against recorded-shape responses. Sign-in and scopes have been checked on a real site (see [Scope check](#scope-check)), but what each write does to a ticket has not. This page is the safe order to try them in, and what to send back when one fails.

## Before you start

- A Mac with the requirements in the README (Xcode Command Line Tools, Rust, Node 22, pnpm).
- A Jira Cloud site you can sign in to, and a project where you may create and edit tickets. Use a test project if there is one.
- A few tickets you own (assigned to you or reported by you), in a project you can write to. Do not start on other people's tickets.
- Claude Code installed and logged in, if you want to try Pip's agent runs. Not needed for the Jira checks.

## Make a token

Gossamr signs in with a scoped Atlassian API token. Your organisation may limit tokens or block them; if the token page says so, ask an admin.

1. Start the app (`pnpm install`, then `pnpm tauri dev`) and enter your Jira site, like `acme.atlassian.net`.
2. Click **Create token**. The page opens with Jira, the scopes `read:jira-work`, `write:jira-work` and `read:jira-user`, and the longest expiry your organisation allows already filled in. Press **Create** and copy the token.
3. Paste your email and the token, set the expiry date to the one on the token page, and click **Connect Jira**.
4. Wait for the first sync to finish.

If the page doesn't fill in, **The page didn't fill in** lists the scopes to tick. If Gossamr can't look up the site's cloud id, it asks you for it.

The three scopes cover every call Gossamr makes (see [Scope check](#scope-check)). If Jira still refuses a call with 401 or 403, send it back with the call's name (see the end of this page).

## What to try, in order

Stop at the first step that fails and report it (see the end of this page).

**1. Read only.** Nothing here changes Jira.

- Sync: Settings, **Sync now**. Tickets appear and there is no error toast.
- Board: each project shows its own statuses as columns.
- Peek: open a ticket. Check the description, links, sub-tasks and attachments.
- Comments: read the comments in the peek sheet on a ticket that has formatting (bold, code, a panel, a mention, an image).

**2. One comment.** On a ticket you own, write one comment in the peek sheet. It becomes a draft. Read it, approve it, then open the ticket in Jira and check it.

**3. One move.** On a ticket you own in a test project, drop its card on another column. Approve the draft. Check the status in Jira. Try a column Jira will refuse, such as one the workflow does not allow, and read the error.

**4. One description rewrite.** On a ticket you own, ask Pip to rewrite the title or description. Read the before-and-after diff. Approve it. Check Jira, and check that the old text is in the issue history.

**5. Only then, if you want:** a new ticket, sub-tasks from a draft, and a link between two tickets.

Keep workstreams in **Advise** for the whole trial. Do not use Manage or Autopilot until steps 1 to 4 have worked.

## What to watch, call by call

| What you do | Jira call | Look for |
| --- | --- | --- |
| Open the app for the first time | `project/search` | Your projects are all listed. Archived and empty ones are fine. |
| Open the board | `project/{key}/statuses` | The columns match the statuses in Jira's board settings. A status with no category shows as active. |
| Open the peek sheet | `issue/{key}/comment` | Text, mentions and links are right. Media, some panels and macros show as plain text; that is known. |
| Pick up a card | `issue/{key}/transitions` | Only the reachable columns stay lit. |
| Approve a move | `POST issue/{key}/transitions` | The ticket lands in the right status. Required fields: only Resolution is filled in for you. Any other required field is named in the error, and you set it in Jira. |
| Approve a new ticket | `issue/createmeta/{project}/issuetypes`, `POST issue` | The ticket has the right type, parent, priority and labels. If the project has no Task or Bug type under that name, you get an error and nothing is created. |
| Approve sub-tasks | `issue/createmeta/...`, `POST issue` | They sit under the parent and use the project's sub-task type. It stops at the first one Jira refuses; check how many were made. |
| Approve a link | `POST issueLink` | Direction: "A blocks B" must show as A blocks B on both tickets. If it is reversed, report it with both keys. |
| Approve a priority, assignee or epic change | `PUT issue/{key}` | The field changes. Some projects do not have a priority field; Jira says so. |
| Approve a rewrite | `PUT issue/{key}` | The description keeps its headings, lists, code and links. Tables, panels, images and macros become plain text; the draft warns about that. A ticket edited in Jira since the draft is refused. |

## Scope check

On 31 October 2026 a scoped token with only `read:jira-work`, `write:jira-work` and `read:jira-user` was tried against a real Jira Cloud site through `api.atlassian.com/ex/jira/{cloudId}`, with the cloud id from the site's `/_edge/tenant_info`.

- **Reads all succeeded:** `myself`, `search/jql`, an issue with its changelog, `issue/{key}/changelog`, `issue/{key}/transitions?expand=transitions.fields`, `user/viewissue/search`, `issue/{key}/comment`, `project/search` (with and without `expand=insight`), `project/{key}/statuses`, `issue/createmeta/{project}/issuetypes`, `attachment/meta` and `attachment/content/{id}` (303 to the media service).
- **Writes were sent with bodies Jira must reject, so nothing changed:** `POST issue/{key}/comment`, `PUT issue/{key}`, `POST issue/{key}/transitions`, `POST issue`, `POST issueLink` and a multipart `POST issue/{key}/attachments`. Each came back 400 or 404 with a validation message, not 401 or 403, so the scopes allow them.
- **`/myself` gave the same account id** that Atlassian sign-in gave, so the connection id and its cache carry over.
- **Not covered:** a transition with a screen of required fields (none of the tried issue's transitions had one), and what each write really does to a ticket. Steps 2 to 5 above still cover that.

## Reporting a failure

Every failed Jira call now shows one line in the toast or on the draft. It has the HTTP status, the method, the path and Jira's own words. Tokens and the Authorization header are never in it. For example:

```
Jira returned 400: PUT issue/CA-12: description: Operation value must be an Atlassian Document Format document.
```

To report a failure, send:

1. That line, copied exactly.
2. What you did just before, and which step above it was.
3. The ticket key, if it is not sensitive.
4. Whether the same step works in Jira's own web UI.

Do not send screenshots that show your client secret or tokens. If a line is cut short, it ends in an ellipsis; send it anyway and say it was cut.
