import type { Need, NeedActionId, NeedGroup } from "../lib/needs";
import type { Proposal, Run, WorkstreamView } from "../types";
import { draftKeyAction } from "./draftKeys";
import type { Command } from "./commands";

/**
 * What the palette's "This item" entries act on: the one thing the keyboard was on when it opened. A row of Needs you (or
 * its open decision) is a need; a draft's card, a run's card or sheet, or a workstream selected on Pip home are themselves.
 */
export type Subject = { type: "need"; key: string } | { type: "draft"; id: string } | { type: "run"; id: string } | { type: "workstream"; id: string };

/**
 * What an entry does, by name. Each is a function the buttons already call (`needsActions`, `draftDecisions`, the stores):
 * the palette adds no way of doing anything, so a confirm or an Undo the button has, the entry has.
 */
export interface ContextDeps {
  /** What the need's own button of that name does, with its confirm where it has one: asks for Enter in a key, a click in a button. */
  needAct(need: Need, id: NeedActionId): void;
  /** The pane's "Open in workstream". */
  openInWorkstream(need: Need): void;
  approveDraft(p: Proposal): void;
  /** A draft whose approval needs reading first, opened where it is read. */
  openDraft(p: Proposal): void;
  skipDraft(p: Proposal): void;
  draftInWorkstream(p: Proposal): void;
  openRun(run: Run): void;
  hold(id: string): void;
  resume(id: string): void;
  advise(id: string): void;
  openWorkstream(id: string): void;
  /** Opens the Needs you list on `workstreamId`'s group with its combined preview ready for the person to confirm. */
  approveSafe(group: NeedGroup): void;
}

/** What the entries are built from: the stores' current contents. */
export interface ContextData {
  needs: readonly Need[];
  proposals: Readonly<Record<string, Proposal | undefined>>;
  runs: readonly Run[];
  workstreams: readonly WorkstreamView[];
}

const GROUP = "This item" as const;

const entry = (id: string, label: string, run: () => void, extra: Partial<Command> = {}): Command => ({ id: `context:${id}`, group: GROUP, icon: "→", label, keywords: "this selected focused item action", run, ...extra });

/** What a need's button is called in the palette, with a word that finds it: "Allow once" for "Allow once in Terminal". */
const NEED_ENTRY: Record<NeedActionId, { label?: string; keywords: string; icon: string }> = {
  approve: { keywords: "approve post send apply yes", icon: "✓" },
  allow: { label: "Allow once", keywords: "allow permit yes terminal permission", icon: "✓" },
  deny: { label: "Deny", keywords: "deny refuse no permission", icon: "✕" },
  dismiss: { keywords: "dismiss skip discard hide remove", icon: "✕" },
  edit: { label: "Edit", keywords: "edit change revise", icon: "✎" },
  retry: { label: "Retry", keywords: "retry again launch", icon: "↻" },
  resume: { label: "Resume", keywords: "resume continue carry on lift hold", icon: "▶" },
  answer: { label: "Answer", keywords: "answer reply respond question", icon: "↩" },
  open: { keywords: "open show look", icon: "→" },
};

/** The workstream's own controls: Hold or Resume, and Advise while it is in Manage. */
function workstreamEntries(view: WorkstreamView, deps: ContextDeps, ticket: string): Command[] {
  const ws = view.workstream;
  return [
    ws.heldReason ? entry(`resume:${ws.id}`, `Resume the workstream on ${ticket}`, () => deps.resume(ws.id), { icon: "▶", keywords: "resume lift hold workstream" }) : entry(`hold:${ws.id}`, `Hold the workstream on ${ticket}`, () => deps.hold(ws.id), { icon: "⏸", hint: "undo for 8 s", keywords: "hold pause workstream stop waking" }),
    ...(ws.mode === "manage" ? [entry(`advise:${ws.id}`, `Switch ${ticket} to Advise`, () => deps.advise(ws.id), { icon: "◇", hint: "undo for 8 s", keywords: "advise manage mode pip stop managing workstream" })] : []),
    entry(`open:${ws.id}`, `Open the workstream on ${ticket}`, () => deps.openWorkstream(ws.id), { icon: "◇", keywords: "open workstream pip home conversation" }),
  ];
}

/**
 * The palette's entries for `subject`: whatever its buttons offer, nothing it doesn't. A need offers its own actions
 * (approve, allow once, deny, skip or dismiss, edit, retry, resume, answer), "Open in workstream", and its workstream's
 * Hold or Resume and Advise; a draft offers approve (or review and approve), edit, skip and "Open in workstream"; a run
 * offers what its need does, else to open it; a workstream offers its controls. Null or a subject that has gone: nothing.
 */
export function contextCommands(subject: Subject | null, data: ContextData, deps: ContextDeps): Command[] {
  if (!subject) return [];
  if (subject.type === "need") {
    const need = data.needs.find((n) => n.key === subject.key);
    if (!need) return [];
    const seen = new Set<string>();
    const own = [need.primary, ...need.secondary].flatMap((spec): Command[] => {
      if (seen.has(spec.id)) return [];
      seen.add(spec.id);
      const meta = NEED_ENTRY[spec.id];
      // "Open" and "Answer" lead into the decision, where the rest is done; everything else is the need's button itself.
      return [entry(`need:${need.key}:${spec.id}`, `${meta.label ?? spec.label}`, () => deps.needAct(need, spec.id), { icon: meta.icon, keywords: meta.keywords, hint: need.head ?? need.title })];
    });
    const view = need.workstreamId ? data.workstreams.find((v) => v.workstream.id === need.workstreamId) : undefined;
    return [
      ...own,
      entry(`need:${need.key}:workstream`, "Open in workstream", () => deps.openInWorkstream(need), { icon: "→", keywords: "open workstream show where it lives" }),
      ...(view ? workstreamEntries(view, deps, view.workstream.itemKey ?? view.workstream.title).filter((c) => !(need.kind === "hold" && c.id.startsWith("context:resume:"))) : []),
    ];
  }
  if (subject.type === "draft") {
    const p = data.proposals[subject.id];
    if (!p) return [];
    const pending = p.state.type === "pending";
    const on = p.intent.type === "githubReview" ? "review" : "draft";
    const approves = draftKeyAction(p, "a", true) === "approve";
    return [
      ...(pending ? [approves ? entry(`draft:${p.id}:approve`, p.intent.type === "githubReview" ? "Post this review" : p.intent.type === "runAnswer" ? "Send this reply" : "Approve this draft", () => deps.approveDraft(p), { icon: "✓", keywords: NEED_ENTRY.approve.keywords }) : entry(`draft:${p.id}:approve`, "Review and approve this draft", () => deps.openDraft(p), { icon: "✓", keywords: NEED_ENTRY.approve.keywords })] : []),
      ...(pending && draftKeyAction(p, "e") ? [entry(`draft:${p.id}:edit`, `Edit this ${on}`, () => deps.openDraft(p), { icon: "✎", keywords: NEED_ENTRY.edit.keywords })] : []),
      ...(pending ? [entry(`draft:${p.id}:skip`, `Skip this ${on}`, () => deps.skipDraft(p), { icon: "✕", hint: "undo for 8 s", keywords: NEED_ENTRY.dismiss.keywords })] : []),
      entry(`draft:${p.id}:workstream`, "Open in workstream", () => deps.draftInWorkstream(p), { icon: "→", keywords: "open workstream show where it lives" }),
    ];
  }
  if (subject.type === "run") {
    const run = data.runs.find((r) => r.id === subject.id);
    if (!run) return [];
    const need = data.needs.find((n) => n.runId === run.id);
    if (need) return contextCommands({ type: "need", key: need.key }, data, deps);
    return [entry(`run:${run.id}:open`, "Open this run", () => deps.openRun(run), { icon: "→", keywords: "open run sheet agent" })];
  }
  const view = data.workstreams.find((v) => v.workstream.id === subject.id && v.workstream.closedAt === null);
  return view ? workstreamEntries(view, deps, view.workstream.itemKey ?? view.workstream.title) : [];
}

/**
 * "Approve all safe drafts in KEY" for each workstream whose Needs you group holds two or more drafts that may go together
 * (`safeBatch`): it opens that group with the combined preview ready, where the person confirms, as the list's own
 * "Approve N safe drafts" does. It approves nothing by itself.
 */
export function batchCommands(groups: readonly NeedGroup[], deps: Pick<ContextDeps, "approveSafe">): Command[] {
  return groups
    .filter((g) => g.safeBatch.length >= 2)
    .map((g): Command => ({
      id: `batch:${g.workstreamId ?? "general"}`,
      group: "Agents",
      icon: "✓",
      label: `Approve all safe drafts in ${g.ticketKey ?? g.title}`,
      hint: `${g.safeBatch.length} drafts · shows them first`,
      keywords: "approve safe drafts batch all workstream comments moves subtasks",
      run: () => deps.approveSafe(g),
    }));
}
