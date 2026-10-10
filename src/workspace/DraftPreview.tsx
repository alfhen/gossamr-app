import { useContext, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { docText } from "../lib/docs";
import { itemKey } from "../lib/filter";
import { targetOf, unreachable } from "../lib/proposals";
import type { Proposal } from "../types";
import { useWorkspace, workflowOfItem } from "../workspaceStore";
import { draftStatus } from "./boardLogic";
import { draftSummary, draftTitle, linkSentence } from "./DraftCard";
import { collapsible, draftFacts, isCreate, showDraft } from "./draftTicket";
import { showMe } from "./jump";
import { useRunSetup } from "./runSetupStore";
import { useRuns } from "./runsStore";
import { nextPass } from "./followUp";
import { FROM_INPUT, PIP_INPUT_ID, PIP_ROOT, draftKeyHint, draftKeyShortcuts, focusAfterLeaving, onDraftCardKey, type Asking } from "./draftKeys";
import { usePip } from "./pipStore";
import { InlineStart, InlineStartContext, inlineStartId, inlineStartKey, inlineStartable, useInlineStarts } from "./InlineStart";
import { focusPeekDraft } from "./peekDrafts";
import { useTabs } from "./tabsStore";

const ICON: Record<Proposal["intent"]["type"], string> = { comment: "✎", transition: "⇄", subtasks: "☰", create: "＋", update: "✦", rewrite: "✎", link: "✦", startRun: "▶", followUp: "↺" };

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

export function draftPreviewBody(p: Proposal, statusName: string | null, pass?: number): string {
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
    case "rewrite":
      return draftSummary(p, statusName).split("; ").join("\n");
    case "link":
      return linkSentence(i);
    case "startRun":
      return `Start an agent: ${i.item?.key ?? `${i.spec.repo}, no ticket`}\n${!i.item && i.spec.instruction.trim() ? `${clipText(i.spec.instruction)}\n` : ""}${i.spec.focus?.trim() ? `Focus from Pip: ${i.spec.focus.trim()}\n` : ""}Read the exact prompt, then start it. Nothing runs before that.`;
    case "followUp":
      return `Send the agent back for another pass${pass ? ` (pass ${pass})` : ""}. Why: ${i.reason}\n\n${i.message}\n\nNothing is sent until you read this and send it.`;
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

/** Text a card shows in full up to a few lines, and whole on request; it fades out rather than ending in an ellipsis. */
function Expandable({ id, text }: { id: string; text: string }) {
  const [open, setOpen] = useState(false);
  const long = collapsible(text);
  return (
    <div className="px-2.5 py-2">
      <div id={id} className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${long && !open ? "max-h-[11.6em] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_70%,transparent)]" : ""}`}>
        {text}
      </div>
      {long && (
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="mt-1 rounded text-sm font-semibold text-ws-pip hover:underline">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

interface Props {
  proposal: Proposal;
  statusName: string | null;
  /** The target ticket's title when it is cached. */
  targetTitle: string | null;
  /** For a follow-up, the pass the agent would be on once it is sent. */
  pass?: number;
  onOpen(): void;
  /** What the a key does on a focused card, for drafts that may be approved in place. */
  onApprove?(): void;
  /** What the s key does on a focused card. */
  onSkip?(): void;
  /**
   * A run draft started in place on Pip home: its action shows or hides `panel`, the review under the card, instead of
   * opening the setup sheet; `onKey` takes the review's own keys (⌘↵) pressed on the card itself, and says whether it did.
   */
  expander?: { open: boolean; panel: ReactNode; onKey?(ev: KeyboardEvent<HTMLElement>): boolean };
}

/** Hands typing that landed on a card back to Pip's input, after what is already there. */
function typeIntoInput(text: string): boolean {
  const input = document.getElementById(PIP_INPUT_ID);
  if (!input) return false;
  input.focus();
  usePip.getState().typeOn(text);
  return true;
}

/**
 * A draft as it appears in the conversation: what it is, how it stands and where to go to decide. Deciding happens on the
 * ticket, or from the keyboard on the focused card for a draft that needs no review. Only a card reached from the keyboard
 * takes its keys; one focused by a click on its text shows no ring and no hint, and its keys do nothing.
 */
export function DraftPreview({ proposal: p, statusName, targetTitle, pass, onOpen, onApprove, onSkip, expander }: Props) {
  /** Focused from the keyboard: only then does the card take its keys and show them. */
  const [armed, setArmed] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const ref = useRef<HTMLElement>(null);
  /** Set by a press of the pointer until the focus it causes has arrived. */
  const pointer = useRef(false);
  /** Set once a decision was made from the keys, so the card hands focus on if that decision takes it away. */
  const decided = useRef(false);
  const state = p.state.type;
  const target = targetOf(p.intent);
  const pending = state === "pending" || state === "applying";
  const revision = p.revisions[p.revisions.length - 1];
  const made = p.intent.type === "create" && state === "applied" ? p.created[0] : undefined;
  const go = pending ? (p.intent.type === "startRun" ? (expander ? "Review and start" : "Review and start →") : p.intent.type === "followUp" ? "Review and send back →" : target ? `Review on ${target.key} →` : "Review draft →") : (target ?? made) ? `Open ${(target ?? made)!.key} →` : "";
  const create = isCreate(p) ? p : null;
  const body = create ? docText(create.intent.fields.body) || "No description." : draftPreviewBody(p, statusName, pass);
  const decide = (run?: () => void) =>
    run &&
    (() => {
      decided.current = true;
      run();
    });

  // The hint renders under the card once it is armed, so the card is brought into view again with it.
  useLayoutEffect(() => {
    if (armed) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [armed, asking]);

  // A card decided from its keys can leave the conversation, as one under "Drafts waiting" does; focus moves on first.
  useLayoutEffect(() => {
    const card = ref.current;
    return () => {
      if (!card || !decided.current || !card.contains(document.activeElement)) return;
      focusAfterLeaving(card, card.closest(PIP_ROOT) ?? document, document.getElementById(PIP_INPUT_ID));
    };
  }, []);

  return (
    <article
      ref={ref}
      aria-label={draftTitle(p)}
      data-draft={p.id}
      data-state={state}
      // While a decision waits for Enter, Esc is the card's: it cancels the ask, and stops nothing else.
      data-esc-local={asking ? "" : undefined}
      tabIndex={0}
      aria-keyshortcuts={draftKeyShortcuts(p)}
      onMouseDown={() => {
        pointer.current = true;
        setTimeout(() => (pointer.current = false), 0);
      }}
      onKeyDown={(ev) => {
        // ⌘↵ starts an open review from the card that opened it too, on the same terms as its Start.
        if (ev.target === ev.currentTarget && expander?.open && expander.onKey?.(ev)) return;
        if (!armed) return;
        const fromInput = ev.target === ev.currentTarget && ev.currentTarget.hasAttribute(FROM_INPUT);
        if (ev.target === ev.currentTarget) ev.currentTarget.removeAttribute(FROM_INPUT);
        onDraftCardKey(ev, p, asking, { approve: decide(onApprove), skip: decide(onSkip), open: onOpen, ask: setAsking, type: typeIntoInput, fromInput });
      }}
      onFocus={(ev) => {
        const byPointer = pointer.current;
        pointer.current = false;
        if (ev.target === ev.currentTarget) setArmed(!byPointer);
      }}
      onBlur={(ev) => {
        if (ev.target !== ev.currentTarget) return;
        ev.currentTarget.removeAttribute(FROM_INPUT);
        setAsking(null);
        // A press inside the card (on Start in its review, say) takes the focus as it goes down; the hint goes once the
        // click is over, so nothing moves under the pointer and the click lands where it was aimed.
        if (pointer.current) return void window.addEventListener("mouseup", () => setTimeout(() => setArmed(false), 0), { once: true, capture: true });
        setArmed(false);
      }}
      className={`overflow-hidden rounded-xl border border-ws-sep2 bg-ws-win shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip ${state === "applied" ? "opacity-70" : state === "skipped" || state === "retired" ? "opacity-45" : ""}`}
    >
      <div className={`flex items-center gap-2 px-2.5 py-1.5 text-sm font-semibold ${HEADER[state]}`}>
        <span aria-hidden>{ICON[p.intent.type]}</span>
        <span className="min-w-0 truncate">{draftTitle(p)}</span>
        <span className="ml-auto shrink-0 font-medium text-ws-ink3">{STATE[state]}</span>
      </div>
      {create && (
        <>
          <p className="m-0 px-2.5 pt-2 font-semibold [overflow-wrap:anywhere]">{create.intent.fields.title}</p>
          <p className="m-0 px-2.5 pt-0.5 text-sm text-ws-ink2">{draftFacts(create).join(" · ")}</p>
        </>
      )}
      <Expandable id={`draft-body-${p.id}`} text={body} />
      {p.state.type === "retired" ? (
        <span className="mx-2.5 mb-1.5 block text-xs font-semibold text-ws-ink3">✕ {p.state.reason}</span>
      ) : (
        pending && revision && <span className="mx-2.5 mb-1.5 block text-xs font-semibold text-ws-pip">↻ {revision.note}</span>
      )}
      <div className="flex items-center gap-1.5 border-t border-ws-sep px-2.5 py-1.5 text-xs text-ws-ink3">
        <span className="shrink-0 font-mono font-semibold whitespace-nowrap">{target?.key ?? "new ticket"}</span>
        {targetTitle && <span className="min-w-0 truncate">{targetTitle}</span>}
        {go &&
          (pending ? (
            <button
              type="button"
              onClick={onOpen}
              aria-expanded={expander ? expander.open : undefined}
              aria-controls={expander?.open ? inlineStartId(p.id) : undefined}
              className="ml-auto shrink-0 rounded-md bg-ws-pip px-2.5 py-1 text-sm font-semibold text-ws-on-pip hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
            >
              {go}
            </button>
          ) : (
            <button type="button" onClick={onOpen} className="ml-auto shrink-0 rounded-md border border-ws-sep2 px-2.5 py-1 text-sm font-semibold text-ws-ink2 hover:bg-ws-hover">
              {go}
            </button>
          ))}
      </div>
      {expander?.open && expander.panel}
      {armed && (
        <p role="status" className={`m-0 border-t border-ws-sep px-2.5 py-1 text-xs ${asking ? "bg-ws-pip-soft font-semibold text-ws-pip" : "text-ws-ink3"}`}>
          {draftKeyHint(p, asking)}
        </p>
      )}
    </article>
  );
}

const deciding = new Set<string>();

/** Approving and skipping from a card's keys, through the store, one decision at a time per draft; a failure shows as a toast. */
export function draftDecisions(id: string): { approve(): void; skip(): void } {
  const decide = (verb: string, job: () => Promise<Proposal>) => {
    if (deciding.has(id)) return;
    deciding.add(id);
    void job()
      .then((done) => done.error && useWorkspace.getState().report(`Couldn't ${verb} that draft`, done.error))
      .catch((e) => useWorkspace.getState().report(`Couldn't ${verb} that draft`, e))
      .finally(() => deciding.delete(id));
  };
  return {
    approve: () => decide("approve", () => useWorkspace.getState().approve(id)),
    skip: () => decide("skip", () => useWorkspace.getState().skip(id)),
  };
}

/**
 * What a draft card's action does: a run draft opens the setup sheet, or on Pip home (`inline`) one of a kind started in
 * place shows its review under the card; a ticket's draft shows the ticket (on Pip home its peek opens over Pip home
 * rather than going to the canvas, where a rewrite's diff is read and approved as anywhere); a draft of a ticket that
 * doesn't exist yet shows that draft.
 */
export function openLiveDraft(p: Proposal, { inline = false }: { inline?: boolean } = {}) {
  const target = targetOf(p.intent);
  if (inline && inlineStartable(p)) return useInlineStarts.getState().toggle(p.id);
  if (p.intent.type === "startRun" && p.state.type === "pending") void useRunSetup.getState().begin({ proposalId: p.id });
  else if (target && inline && useWorkspace.getState().items[itemKey(target)]) {
    useTabs.getState().select(itemKey(target));
    // The keyboard goes with it, to the draft in the peek; closing the peek gives it back to where it was.
    focusPeekDraft(p.id);
  }
  else if (target) showMe(target, { peek: true });
  else if (p.state.type === "pending" || p.state.type === "applying") showDraft(p.id);
  else if (p.created[0] && !showMe(p.created[0])) showDraft(p.id);
}

/** ⌘↵ on the card of run draft `id` while its review is open: as in the review, it starts when Start would; true when the key was taken. */
function startKey(id: string, ev: KeyboardEvent<HTMLElement>): boolean {
  const inline = useInlineStarts.getState();
  const entry = inline.entries[id];
  const key = entry ? inlineStartKey(ev, entry) : null;
  if (!key) return false;
  ev.preventDefault();
  if (key === "start") void inline.start(id);
  return true;
}

/** The preview wired to the workspace: opening it shows the ticket, or the draft of a ticket that doesn't exist yet. */
export function LiveDraftPreview({ proposal: p }: { proposal: Proposal }) {
  const containers = useWorkspace((s) => s.containers);
  const inline = useContext(InlineStartContext);
  const target = targetOf(p.intent);
  const item = useWorkspace((s) => (target ? s.items[itemKey(target)] : undefined));
  const statusName = item && p.intent.type === "transition" ? (draftStatus(p, workflowOfItem({ containers }, item))?.name ?? null) : null;
  const startable = inline && inlineStartable(p);
  const expanded = useInlineStarts((s) => startable && (s.entries[p.id]?.phase ?? "closed") !== "closed");
  const pass = useRuns((s) => (p.intent.type === "followUp" && p.state.type === "pending" ? nextPass(s.runs.find((r) => r.id === (p.intent as { runId: string }).runId)) : undefined));
  const { approve, skip } = draftDecisions(p.id);
  return (
    <DraftPreview
      proposal={p}
      statusName={statusName}
      targetTitle={item?.title ?? null}
      pass={pass}
      onOpen={() => openLiveDraft(p, { inline })}
      onApprove={approve}
      onSkip={skip}
      expander={startable ? { open: expanded, panel: <InlineStart proposal={p} />, onKey: (ev) => startKey(p.id, ev) } : undefined}
    />
  );
}
