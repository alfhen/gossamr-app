import type { Intent, ItemRef, Proposal, Run, WorkstreamEvent, WorkstreamView } from "../types";
import { docText } from "./docs";
import { isReporterFollowUp, isReporterNudge, isReporterQuestions, makerName, targetOf, workstreamOf } from "./proposals";
import { fromRunPhrase } from "./runNames";
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

const lines = (text: string) => text.split("\n").map((l) => l.trimEnd()).filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""));

/** A description's change as lines for the disclosure: what was removed ("− "), added ("+ ") and a little around it, as drafted. */
function descriptionDiff(from: string, to: string): string[] {
  return withGaps(diffLines(from, to)).map((r) => (r.kind === "gap" ? `… ${r.count} unchanged lines` : `${r.kind === "del" ? "− " : r.kind === "add" ? "+ " : "  "}${r.text}`));
}

/**
 * What a Jira write said, short and whole. Null for an intent that isn't a Jira write. `created` are the keys of the
 * tickets it made (`Proposal.created`): a subtasks entry names each, entry `i` for summary `i`.
 */
export function sentWhat(intent: Intent, label: string | null, created: readonly ItemRef[] = []): { kind: SentKind; summary: string; detail: string[] } | null {
  switch (intent.type) {
    case "comment": {
      const text = docText(intent.body);
      return { kind: "comment", summary: short(text), detail: lines(text) };
    }
    case "transition":
      return { kind: "transition", summary: `Moved to ${label ?? intent.to}`, detail: [`Moved to ${label ?? intent.to}`] };
    case "rewrite": {
      const parts = [intent.title && `Title: ${intent.title.from} → ${intent.title.to}`, intent.body && "Description, as it read and as it now reads:"].filter((x): x is string => !!x);
      const body = intent.body ? descriptionDiff(intent.body.fromText, intent.body.toText) : [];
      const summary = intent.body ? `Description rewritten${intent.title ? " and title changed" : ""}` : `Title changed to ${intent.title?.to ?? ""}`;
      return { kind: "description", summary, detail: [...parts, ...body] };
    }
    case "subtasks": {
      const named = intent.summaries.map((s, i) => (created[i] ? `${created[i].key} ${s}` : s));
      return { kind: "subtasks", summary: `${intent.summaries.length} ${intent.summaries.length === 1 ? "subtask" : "subtasks"}: ${short(named.join("; "))}`, detail: named.map((s) => `• ${s}`) };
    }
    case "create":
      return { kind: "ticket", summary: `Created “${intent.fields.title}”`, detail: [intent.fields.title, ...lines(docText(intent.fields.body))] };
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
    return p.createdBy === "pip" ? (key ? `Pip, on ${key}` : "Pip's conversation") : workstreamOf(p) ? "Gossamr" : "the conversation";
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
