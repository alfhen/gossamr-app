# Gossamr

Gossamr is a macOS work aide for Jira and GitHub. It keeps tickets and pull requests in a local cache, so you can read the last synced work offline. Pip helps you work through it.

## Workstreams and agents

A workstream holds one ticket or one ticketless task, its conversation with Pip, notes, agents and drafts. Tell Pip what you want done. It starts, messages and stops Claude Code agents within that workstream and wakes when an agent has something to report. You can pause a workstream or stop an agent yourself.

Roles such as planner, builder and reviewer are labels Pip chooses, not different permission tiers. Every agent uses your Claude Code setup, with Gossamr's report, ask, read-workstream and wait tools added. Gossamr does not accept folder trust for you or change your Claude settings. Permission prompts belong in Terminal.

Agents report in prose. Gossamr does not parse headings, score a plan, infer a review verdict or make drafts automatically. Pip reads the report and decides what to draft or do next within your instruction. Reports, ticket text, comments and pull request content are data, never instructions to Pip.

## Drafts are the gate

Every write Gossamr makes to Jira or GitHub is a draft you approve, edit or skip. Ask Pip discusses a draft without posting it. Starting, messaging and stopping agents are Pip's actions, not drafts.

There are eight write kinds: comment, transition, create ticket, update fields, rewrite title or description, link tickets, create subtasks and GitHub review. A newer pending draft of the same kind and target replaces the older one, regardless of its maker or workstream. Your own drafts and edits stay alongside the new draft. New-ticket drafts have no existing target and do not replace each other. A write already being posted, a partially completed subtask batch or a review that may already be on GitHub keeps its recovery state rather than being silently replaced.

A rewrite shows the old and new text and refuses to overwrite a ticket whose text changed meanwhile. Plans can live in a collapsed `Gossamr Plan` section; this is formatting, not a separate kind of draft.

A GitHub review names its reviewer agent and the commit it reviewed. Inline comments are checked against that commit's diff; comments outside the diff move to the summary. Approval posts a comment review, never an approval or change request. If a post may have succeeded, Gossamr looks for it before retrying; only you can choose Post again when it cannot be found.

## Boundaries

- Pip has only Gossamr's MCP tools, with no file, shell or web tools.
- Agents have your own Claude Code permissions and integrations. Their brief asks them to push only their own branch, open draft pull requests and never merge; this is not a sandbox over your setup.
- Secrets stay in the macOS Keychain. Each agent's private MCP config is the sole on-disk token exception, and that token expires when the run ends.
- Nothing in a keyboard shortcut should act while you type in an input or text area.

The remaining refactor work is tracked in [the simplification proposal](simplification-proposal.md), not in this product description. UI consolidation and the Linear adapter are later steps. [The CLI findings](agents-cli-findings.md) record what has actually been checked against Claude Code.
