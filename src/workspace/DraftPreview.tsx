import { docText } from "../lib/docs";
import { itemKey } from "../lib/filter";
import { targetOf, unreachable } from "../lib/proposals";
import type { Proposal } from "../types";
import { useWorkspace, workflowOfItem } from "../workspaceStore";
import { draftStatus } from "./boardLogic";
import { draftTitle, linkSentence } from "./DraftCard";
import { showDraft } from "./draftTicket";
import { showMe } from "./jump";
import { useRunSetup } from "./runSetupStore";

const ICON: Record<Proposal["intent"]["type"], string> = { comment: "✎", transition: "⇄", subtasks: "☰", create: "＋", update: "✦", link: "✦", startRun: "▶" };

const STATE: Record<Proposal["state"]["type"], string> = { pending: "Draft", applying: "Working…", applied: "Done", skipped: "Skipped", retired: "Out of date" };

const HEADER: Record<Proposal["state"]["type"], string> = {
  pending: "bg-ws-pip-soft text-ws-pip",
  applying: "bg-ws-pip-soft text-ws-pip",
  applied: "bg-ws-done-soft text-ws-done",
  skipped: "bg-ws-sel text-ws-ink3",
  retired: "bg-ws-sel text-ws-ink3",
};

/** A few lines of what approving would do. */
const clipText = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
};

export function draftPreviewBody(p: Proposal, statusName: string | null): string {
  const i = p.intent;
  switch (i.type) {
    case "comment":
      return docText(i.body);
    case "transition":
      return `Move ${i.item.key} to ${statusName ?? p.label ?? i.to}`;
    case "subtasks":
      return i.summaries.map((s) => `• ${s}`).join("\n");
    case "create":
      return [i.fields.title, docText(i.fields.body)].filter(Boolean).join("\n");
    case "update":
      return "Change fields";
    case "link":
      return linkSentence(i);
    case "startRun":
      return `Start an agent: ${i.item?.key ?? `${i.spec.repo}, no ticket`}\n${!i.item && i.spec.instruction.trim() ? `${clipText(i.spec.instruction)}\n` : ""}${i.spec.focus?.trim() ? `Focus from Pip: ${i.spec.focus.trim()}\n` : ""}Read the exact prompt, then start it. Nothing runs before that.`;
    default:
      return unreachable(i);
  }
}

interface Props {
  proposal: Proposal;
  statusName: string | null;
  /** The target ticket's title when it is cached. */
  targetTitle: string | null;
  onOpen(): void;
}

/** A draft as it appears in the conversation: what it is, how it stands and where to go to decide. Deciding happens on the ticket. */
export function DraftPreview({ proposal: p, statusName, targetTitle, onOpen }: Props) {
  const state = p.state.type;
  const target = targetOf(p.intent);
  const pending = state === "pending" || state === "applying";
  const revision = p.revisions[p.revisions.length - 1];
  const made = p.intent.type === "create" && state === "applied" ? p.created[0] : undefined;
  const go = pending ? (p.intent.type === "startRun" ? "Review and start →" : target ? `Review on ${target.key} →` : "Review draft →") : (target ?? made) ? `Open ${(target ?? made)!.key} →` : "";
  return (
    <button
      type="button"
      aria-label={draftTitle(p)}
      data-draft={p.id}
      onClick={onOpen}
      className={`block w-full overflow-hidden rounded-xl border border-ws-sep2 bg-ws-win text-left shadow-sm transition hover:-translate-y-px hover:border-ws-pip hover:shadow-md ${state === "applied" ? "opacity-70" : state === "skipped" || state === "retired" ? "opacity-45" : ""}`}
    >
      <span className={`flex items-center gap-2 px-2.5 py-1.5 text-sm font-semibold ${HEADER[state]}`}>
        <span aria-hidden>{ICON[p.intent.type]}</span>
        <span className="min-w-0 truncate">{draftTitle(p)}</span>
        <span className="ml-auto shrink-0 font-medium text-ws-ink3">{STATE[state]}</span>
      </span>
      <span className="line-clamp-3 px-2.5 py-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{draftPreviewBody(p, statusName)}</span>
      {p.state.type === "retired" ? (
        <span className="mx-2.5 mb-1.5 block text-xs font-semibold text-ws-ink3">✕ {p.state.reason}</span>
      ) : (
        pending && revision && <span className="mx-2.5 mb-1.5 block text-xs font-semibold text-ws-pip">↻ {revision.note}</span>
      )}
      <span className="flex items-center gap-1.5 border-t border-ws-sep px-2.5 py-1 text-xs text-ws-ink3">
        <span className="shrink-0 font-mono font-semibold whitespace-nowrap">{target?.key ?? "new ticket"}</span>
        {targetTitle && <span className="min-w-0 truncate">{targetTitle}</span>}
        {go && <span className="ml-auto shrink-0 font-semibold text-ws-pip">{go}</span>}
      </span>
    </button>
  );
}

/** The preview wired to the workspace: opening it shows the ticket, or the draft of a ticket that doesn't exist yet. */
export function LiveDraftPreview({ proposal: p }: { proposal: Proposal }) {
  const containers = useWorkspace((s) => s.containers);
  const target = targetOf(p.intent);
  const item = useWorkspace((s) => (target ? s.items[itemKey(target)] : undefined));
  const statusName = item && p.intent.type === "transition" ? (draftStatus(p, workflowOfItem({ containers }, item))?.name ?? null) : null;
  const open = () => {
    if (p.intent.type === "startRun" && p.state.type === "pending") void useRunSetup.getState().begin({ proposalId: p.id });
    else if (target) showMe(target, { peek: true });
    else if (p.state.type === "pending" || p.state.type === "applying") showDraft(p.id);
    else if (p.created[0] && !showMe(p.created[0])) showDraft(p.id);
  };
  return <DraftPreview proposal={p} statusName={statusName} targetTitle={item?.title ?? null} onOpen={open} />;
}
