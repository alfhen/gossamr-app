import type { Intent, ItemRef, Proposal, Run, WorkstreamEvent, WorkstreamView } from "../types";
import { docText } from "./docs";
import { isReporterFollowUp, isReporterNudge, isReporterQuestions, makerName, targetOf, workstreamOf } from "./proposals";
import { fromRunPhrase } from "./runNames";
import { maskSecrets } from "./riskyText";
import { diffLines, withGaps } from "./textDiff";
import { isJiraWrite } from "./workstreamWither";

/**
 * "What Jira saw from me": everything Gossamr wrote to Jira on the person's approval, newest first, for the person to look
 * back at what other people read. It reads what is already kept: the applied drafts (what was written, who drafted it, whether
 * the person edited it first: an `Edited` revision) and the workstreams' audit (`draft_approved`, which says when it was
 * approved and in which workstream). Nothing here writes. A review posted to GitHub is not Jira's and is left out.
 */

/** What kind of change it was, in the person's words. */
export type SentKind = "comment" | "transition" | "description" | "subtasks" | "ticket" | "change" | "link";

export const SENT_LABEL: Record<SentKind, string> = {
  comment: "Comment",
  transition: "Move",
  description: "Description edit",
  subtasks: "Subtasks",
  ticket: "New ticket",
  change: "Change",
  link: "Link",
};

export interface SentEntry {
  /** The draft's id. */
  id: string;
  /** When it was approved: the audit's `draft_approved` line when it is known, else when the draft last changed. */
  at: string;
  /** The ticket it went to; null for a new ticket that was created. */
  ticketKey: string | null;
  kind: SentKind;
  /** What the pill says in place of the kind's label, for a comment that is more specific than "Comment": "Questions to the reporter". */
  label?: string;
  /** One short line: what was posted. */
  summary: string;
  /** A second line for a comment or a description edit, whose summary alone is thin: what follows the opener, or what was added. "(+N more)" ends it when more lines of a comment follow. */
  second?: string;
  /** The whole of it, a line per paragraph or item, for the disclosure. */
  detail: string[];
  /** The workstream it came from, by id, and its name ("CA-401"), when it came from one. */
  workstreamId: string | null;
  workstream: string | null;
  /** Who drafted it: "Pip", "An agent", "Gossamr", "You". */
  madeBy: string;
  /** Where the draft came from: "Pip's conversation", "run R3", "the board". */
  from: string;
  /** The person changed Pip's (or an agent's) words before approving. */
  edited: boolean;
  /** Part of the posted text looked like a secret: it is masked here, though Jira holds it in full. */
  masked: boolean;
}

const SHORT = 120;

/** A line that only greets ("Hi @Mette Lund,"): it says nothing about what was posted. */
const GREETING = /^(hi|hello|hey|hej|dear)\b[^\n]{0,60}$/i;

/** The first line of `text` that says something, cut to `SHORT` characters: a leading greeting is skipped. */
const short = (text: string) => {
  const all = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const first = (all.length > 1 && GREETING.test(all[0]) ? all[1] : all[0]) ?? "";
  return first.length > SHORT ? `${first.slice(0, SHORT - 1).trimEnd()}…` : first;
};

/** A line that starts a bullet or a numbered item: "- Goal?", "• Goal?", "1. Goal?", "2) Goal?". */
const ITEM = /^(?:[-*•]|\d+[.)])\s/;

/**
 * The line after the one `short` picks: a comment's opener is often the same ("Before work starts…"), what follows it is not.
 * A reply of more says how many are not shown: "(+N more)", counting the items when the line shown starts a list (a closing
 * "Thanks!" or a wrapped line is not an item), else the lines.
 */
const after = (text: string) => {
  const all = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const at = all.length > 1 && GREETING.test(all[0]) ? 2 : 1;
  const next = all[at] ?? "";
  const cut = next.length > SHORT ? `${next.slice(0, SHORT - 1).trimEnd()}…` : next;
  const rest = all.slice(at + 1);
  const more = ITEM.test(next) ? rest.filter((l) => ITEM.test(l)).length : rest.length;
  return cut && more > 0 ? `${cut} (+${more} more)` : cut;
};

const lines = (text: string) => text.split("\n").map((l) => l.trimEnd()).filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""));

/** A description's change as lines for the disclosure: what was removed ("− "), added ("+ ") and a little around it, as drafted. */
function descriptionDiff(from: string, to: string): string[] {
  return withGaps(diffLines(from, to)).map((r) => (r.kind === "gap" ? `… ${r.count} unchanged lines` : `${r.kind === "del" ? "− " : r.kind === "add" ? "+ " : "  "}${r.text}`));
}

/**
 * What a Jira write said, short and whole. Null for an intent that isn't a Jira write. `created` are the keys of the
 * tickets it made (`Proposal.created`): a subtasks entry names each, entry `i` for summary `i`.
 */
export function sentWhat(intent: Intent, label: string | null, created: readonly ItemRef[] = []): { kind: SentKind; label?: string; summary: string; second?: string; detail: string[]; masked: boolean } | null {
  let masked = false;
  // Text that looks like a secret is masked from the first read on, so no summary, second line or detail shows it.
  const hide = (text: string) => {
    const out = maskSecrets(text);
    if (out !== text) masked = true;
    return out;
  };
  const what = sentWhatOf(intent, label, created, hide);
  return what && { ...what, masked };
}

function sentWhatOf(intent: Intent, label: string | null, created: readonly ItemRef[], hide: (text: string) => string): { kind: SentKind; label?: string; summary: string; second?: string; detail: string[] } | null {
  switch (intent.type) {
    case "comment": {
      const text = hide(docText(intent.body));
      const second = after(text);
      return { kind: "comment", summary: short(text), ...(second ? { second } : {}), detail: lines(text) };
    }
    case "transition":
      return { kind: "transition", summary: `Moved to ${label ?? intent.to}`, detail: [`Moved to ${label ?? intent.to}`] };
    case "rewrite": {
      const body = intent.body ? descriptionDiff(hide(intent.body.fromText), hide(intent.body.toText)) : [];
      // An edit that only adds is said as an addition, and one on an empty description as a new description.
      const empty = !intent.body?.fromText.trim();
      const onlyAdds = !body.some((l) => l.startsWith("− "));
      // The pill says the same kind of change the summary does: "Description edit" over "Description added" was two words for one thing.
      const [summary, lead, pill] = !intent.body
        ? [`Title changed to ${hide(intent.title?.to ?? "")}`, null, "Title change"]
        : empty
          ? [`Description added${intent.title ? " and title changed" : ""}`, "The new description:", "New description"]
          : onlyAdds
            ? [`Added to the description${intent.title ? " and title changed" : ""}`, "Added to the description:", "Description addition"]
            : [`Description rewritten${intent.title ? " and title changed" : ""}`, "Description, as it read and as it now reads:", "Description rewrite"];
      const parts = [intent.title && `Title: ${hide(intent.title.from)} → ${hide(intent.title.to)}`, lead].filter((x): x is string => !!x);
      // What the edit put in: the first line it added, which says more than "Description added".
      // A heading or rule is no summary of it: the first added line with words of its own, else the heading's text.
      const addedLines = body.filter((l) => l.startsWith("+ ") && l.slice(2).trim()).map((l) => l.slice(2).trim());
      const plain = (l: string) => l.replace(/^[#>\-*\s]+/, "").trim();
      const isHeadingOrRule = (l: string) => /^#{1,6}(\s|$)/.test(l) || /^([-*_])(\s*\1){2,}$/.test(l);
      const added = plain(addedLines.find((l) => !isHeadingOrRule(l) && plain(l)) ?? addedLines.find((l) => plain(l)) ?? "");
      const second = added.length > SHORT ? `${added.slice(0, SHORT - 1).trimEnd()}…` : added;
      return { kind: "description", label: pill, summary, ...(second ? { second } : {}), detail: [...parts, ...body] };
    }
    case "subtasks": {
      const named = intent.summaries.map((s, i) => (created[i] ? `${created[i].key} ${hide(s)}` : hide(s)));
      return { kind: "subtasks", summary: `${intent.summaries.length} ${intent.summaries.length === 1 ? "subtask" : "subtasks"}: ${short(named.join("; "))}`, detail: named.map((s) => `• ${s}`) };
    }
    case "create":
      return { kind: "ticket", summary: `Created “${hide(intent.fields.title)}”`, detail: [hide(intent.fields.title), ...lines(hide(docText(intent.fields.body)))] };
    case "update": {
      const p = intent.patch;
      const changes = [p.assignee && "the assignee", p.priority && `the priority to ${p.priority}`, p.parent && `the parent to ${p.parent.key}`].filter((x): x is string => !!x);
      return { kind: "change", summary: `Changed ${changes.join(" and ") || "the ticket"}`, detail: [`Changed ${changes.join(" and ") || "the ticket"}`] };
    }
    case "link":
      return { kind: "link", summary: `Linked ${intent.from.key} ${intent.kind} ${intent.to.key}`, detail: [`${intent.from.key} ${intent.kind} ${intent.to.key}`] };
    default:
      return null;
  }
}

/**
 * Where a draft came from, in a few words. `labels` are the runs' short names of its workstream (`[runId, "R3"]`); a run
 * outside them is named as the rest of the app does ("the CA-401 plan"), never by its id.
 */
function fromWords(p: Proposal, labels: readonly (readonly [string, string])[], runs: readonly RunNamed[]): string {
  if (p.origin.type === "run") {
    const id = p.origin.runId;
    const label = labels.find(([l]) => l === id)?.[1];
    return label ? `run ${label}` : fromRunPhrase(p, runs.find((r) => r.id === id));
  }
  if (p.origin.type === "chat") {
    const key = p.createdBy === "pip" ? (targetOf(p.intent)?.key ?? null) : null;
    // What Gossamr drafted at the person's ask ("Ask the reporter now") is named by that, not by Gossamr again: the line before says who drafted it.
    return p.createdBy === "pip" ? (key ? `Pip, on ${key}` : "Pip's conversation") : workstreamOf(p) ? "your request" : "the conversation";
  }
  return p.origin.type === "autopilot" ? "the autopilot" : "the board";
}

/** What names a run outside a workstream's labels: its step and ticket. */
type RunNamed = Pick<Run, "id" | "spec" | "item">;

export interface SentInput {
  proposals: readonly Proposal[];
  /** Each workstream's audit by id, for when a draft was approved and where it was; any that aren't loaded just aren't read. */
  events: Readonly<Record<string, readonly WorkstreamEvent[] | undefined>>;
  /** The workstreams, open and closed, for their names and their runs' short names. */
  workstreams: readonly WorkstreamView[];
  /** The runs, to name those a draft came from that no workstream's label list holds. */
  runs?: readonly RunNamed[];
}

/** Everything Jira was written, newest first. A draft still waiting, skipped, retired or one that starts a run isn't. */
export function jiraSent({ proposals, events, workstreams, runs = [] }: SentInput): SentEntry[] {
  const approvals = new Map<string, { at: string; workstreamId: string }>();
  for (const [id, list] of Object.entries(events)) {
    for (const e of list ?? []) if (e.action === "draft_approved" && e.actor === "person" && e.proposalId) approvals.set(e.proposalId, { at: e.at, workstreamId: id });
  }
  const out: SentEntry[] = [];
  for (const p of proposals) {
    if (p.state.type !== "applied" || !isJiraWrite(p.intent)) continue;
    const what = sentWhat(p.intent, p.label, p.created);
    if (!what) continue;
    const approved = approvals.get(p.id);
    const workstreamId = workstreamOf(p) ?? approved?.workstreamId ?? null;
    const view = workstreams.find((v) => v.workstream.id === workstreamId);
    out.push({
      id: p.id,
      at: approved?.at ?? p.updatedAt,
      ticketKey: targetOf(p.intent)?.key ?? p.created[0]?.key ?? null,
      ...what,
      ...(isReporterFollowUp(p) ? { label: "Follow-up questions to the reporter" } : isReporterQuestions(p) ? { label: "Questions to the reporter" } : isReporterNudge(p) ? { label: "Nudge to the reporter" } : {}),
      workstreamId,
      workstream: view ? (view.workstream.itemKey ?? view.workstream.title) : null,
      madeBy: isReporterQuestions(p) || isReporterNudge(p) ? "Gossamr" : makerName(p.createdBy),
      from: fromWords(p, view?.labels ?? [], runs),
      edited: p.revisions.some((r) => r.note === "Edited"),
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || (a.id < b.id ? 1 : -1));
}

/** How the entry reads on its line about the draft: "Pip drafted it, you edited it", "Pip drafted it; posted without changes". */
export function editedWords(e: Pick<SentEntry, "madeBy" | "edited">): string {
  if (e.madeBy === "You") return e.edited ? "You wrote it and edited it before approving" : "You wrote it";
  return e.edited ? `${e.madeBy} drafted it; you edited it before approving` : `${e.madeBy} drafted it; posted without changes`;
}
