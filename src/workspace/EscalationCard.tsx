import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { itemKey } from "../lib/filter";
import { targetOf } from "../lib/proposals";
import type { Escalation, Proposal, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { Icon } from "./AgentIcons";
import { Btn } from "./AgentSheet";
import { openLiveDraft } from "./DraftPreview";
import { draftKey } from "./draftTicket";
import { usePipHome } from "./pipHomeStore";
import { useTabs } from "./tabsStore";
import { useWorkstreams } from "./workstreamsStore";

/** What each choice does, said under its button. Only the person chooses; Pip and the rules have none of them. */
export const FIX_ROUND_HELP = "Sends the build the review's blocking findings again, as the automatic rounds did. Each extra round needs your click.";
export const TAKE_OVER_HELP = "Switches this workstream to Advise. Nothing else changes.";
export const POST_AS_IS_HELP = "Opens the review draft. Nothing goes to GitHub until you use its own Post review; once it is posted, this card closes.";
/** Why Post the review as is can't be pressed. */
export const NO_REVIEW_DRAFT = "This review has no draft waiting.";

/** Why every choice waits while the review draft it opened is open and not yet posted. */
export const DRAFT_OPEN = "Review draft open: post it from the draft. These choices come back if you close or discard the draft.";

/**
 * The review draft each escalation (by its review run) opened with "Post the review as is". Whether it is still open is
 * read from the draft itself: posted, the escalation is resolved and the card is gone; dismissed or discarded, the card's
 * choices come back.
 */
export const useEscalationDrafts = create<{ opened: Record<string, string> }>(() => ({ opened: {} }));

/**
 * The draft `escalation` opened that is still open and waiting to be posted, from the drafts and the selection as they
 * are now; null when none is: posted, it resolves the escalation; discarded, or its peek closed, the choices are back.
 */
export function draftOpen(escalation: Escalation, opened: Readonly<Record<string, string>>, proposals: Readonly<Record<string, Proposal>>, selected: string | null): string | null {
  const id = opened[escalation.reviewRun];
  const p = id ? proposals[id] : undefined;
  if (!id || !p || (p.state.type !== "pending" && p.state.type !== "applying")) return null;
  const target = targetOf(p.intent);
  return selected !== null && selected === (target ? itemKey(target) : draftKey(id)) ? id : null;
}

/** Whether the choices wait on Pip home's decision pane: Post the review as is was pressed and its draft is still pending. */
export const postingReview = (posted: boolean, draft: Pick<Proposal, "state"> | undefined) => posted && draft?.state.type === "pending";

/** The confirmation once the person chose, in the words the card shows. */
export const fixRoundSent = (build: string) => `Fix round sent to ${build || "the build"}.`;
export const TAKEN_OVER = "Over to you: this workstream is on Advise now.";

/** The person's three choices on a review that still blocks after the automatic fix rounds. */
export interface EscalationActions {
  /** Run another fix round: resolves with whether it was sent. */
  onFixRound(): Promise<boolean>;
  /** I'll take it from here: resolves with whether the workstream went to Advise. */
  onTakeOver(): Promise<boolean>;
  /** Post the review as is: opens draft `id`, which posts nothing by itself. */
  onPost(id: string): void;
}

/** The choices wired to workstreamsStore and the draft's own card, for workstream `id`. */
export function escalationActions(id: string, e: Escalation): EscalationActions {
  return {
    onFixRound: async () => (await useWorkstreams.getState().fixRound(e.reviewRun)) !== null,
    onTakeOver: () => useWorkstreams.getState().takeOver(id, e.reviewRun),
    onPost: (draft) => {
      const p = useWorkspace.getState().proposals[draft];
      // The draft's card, where its own Post review is: in the peek, over Pip home when that is where the person is.
      if (p) openLiveDraft(p, { inline: useTabs.getState().route === "pip" });
      else usePipHome.getState().focus({ type: "draft", id: draft });
    },
  };
}

/** The focused line that says what the choice did, as the answer flow's confirmation does. */
export function EscalationSent({ text }: { text: string }) {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const at = document.activeElement;
      // The button pressed has gone with the card; the keyboard comes here rather than to nowhere.
      if (!at || at === document.body || !at.isConnected) line.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <p ref={line} tabIndex={-1} role="status" data-escalation-sent className="m-0 flex items-center gap-1.5 text-sm font-semibold text-ws-pip outline-none">
      <Icon name="check" className="size-3.5" />
      {text}
    </p>
  );
}

export interface EscalationCardViewProps {
  escalation: Escalation;
  /** A choice is on its way: the buttons wait. */
  busy: boolean;
  /** The review draft it opened is open and not posted: the choices wait, and the card says why. */
  drafting?: boolean;
  /** Says "R3 still blocks after 2 fix rounds. What next?" first. Left out where something above already says it (the decision pane's header). */
  titled?: boolean;
  onFixRound(): void;
  onTakeOver(): void;
  onPost(): void;
}

/**
 * A review that still blocks after the automatic fix rounds, and the person's three choices, in this order: another fix
 * round, taking the workstream over, or posting the review as it is. Each is the person's alone.
 */
export function EscalationCardView({ escalation: e, busy, drafting = false, titled = true, onFixRound, onTakeOver, onPost }: EscalationCardViewProps) {
  const review = e.reviewLabel || "The review";
  const draft = e.reviewDraft ?? null;
  const why = `escalation-${e.reviewRun}-draft`;
  const choice = (n: number, label: string, help: string, run: () => void, extra: { tone?: "primary" | "plain"; disabled?: boolean; title?: string } = {}) => (
    <li className="grid gap-0.5">
      <Btn
        tone={extra.tone ?? "plain"}
        disabled={busy || drafting || extra.disabled}
        title={drafting ? DRAFT_OPEN : extra.title}
        aria-describedby={drafting ? `escalation-${e.reviewRun}-${n} ${why}` : `escalation-${e.reviewRun}-${n}`}
        onClick={run}
        className="justify-self-start px-2 py-0.5"
      >
        {label}
      </Btn>
      <span id={`escalation-${e.reviewRun}-${n}`} className="text-xs text-ws-ink2">
        {help}
      </span>
    </li>
  );
  return (
    <div role="group" aria-label="Review still blocks" data-escalation={e.reviewRun} className="grid gap-1.5 rounded-md border border-ws-warn/40 bg-ws-warn/10 px-2.5 py-1.5 text-sm text-ws-ink">
      {titled && (
        <p className="m-0 font-semibold">
          {review} still blocks after {e.rounds} fix rounds. What next?
        </p>
      )}
      {drafting && (
        <p id={why} role="status" data-escalation-draft-open className="m-0 text-xs font-semibold text-ws-ink">
          {DRAFT_OPEN}
        </p>
      )}
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {choice(1, "Run another fix round", FIX_ROUND_HELP, onFixRound, { tone: "primary" })}
        {choice(2, "I'll take it from here", TAKE_OVER_HELP, onTakeOver)}
        {choice(3, "Post the review as is", POST_AS_IS_HELP, onPost, { disabled: !draft, title: draft ? undefined : NO_REVIEW_DRAFT })}
      </ul>
    </div>
  );
}

/** What the person chose on the escalation about `review`, as the card confirms it. */
export interface EscalationChoice {
  review: string;
  text: string;
  /** "I'll take it from here", whose confirmation holds only while the workstream isn't in Manage. */
  tookOver: boolean;
}

/**
 * What the card shows for `escalation` once the person chose `sent`, in workstream mode `mode`: the confirmation, the
 * card, or nothing. A newer escalation shows the card again, for a fresh click. "Over to you" is said only while it is
 * true: once Manage is on again it would be false, and the review taken over doesn't come back.
 */
export function escalationShown(escalation: Escalation | null, sent: EscalationChoice | null, mode: WorkstreamView["workstream"]["mode"]): "card" | "sent" | null {
  const said = sent && !(sent.tookOver && mode === "manage") ? sent : null;
  if (escalation && said?.review !== escalation.reviewRun) return "card";
  return said ? "sent" : null;
}

/** The card of workstream `view`'s escalation, wired to the person's commands, and the confirmation once they chose. */
export function EscalationCard({ view }: { view: WorkstreamView }) {
  const e = view.escalation ?? null;
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<EscalationChoice | null>(null);
  const id = view.workstream.id;
  const shown = escalationShown(e, sent, view.workstream.mode);
  const opened = useEscalationDrafts((s) => s.opened);
  const proposals = useWorkspace((s) => s.proposals);
  const selected = useTabs((s) => s.selected);
  const drafting = e ? draftOpen(e, opened, proposals, selected) !== null : false;
  // Once the draft has been open and isn't, the choice is spent: opening that ticket again for something else says nothing about it.
  const seen = useRef(false);
  const reviewRun = e?.reviewRun;
  useEffect(() => {
    if (drafting) seen.current = true;
    else if (seen.current && reviewRun) {
      seen.current = false;
      useEscalationDrafts.setState((s) => ({ opened: Object.fromEntries(Object.entries(s.opened).filter(([k]) => k !== reviewRun)) }));
    }
  }, [drafting, reviewRun]);
  if (e && shown === "card") {
    // A draft that was dismissed or discarded isn't there to post any more, whatever the view still says.
    const offered = e.reviewDraft && proposals[e.reviewDraft] && proposals[e.reviewDraft].state.type !== "pending" ? null : e.reviewDraft;
    const actions = escalationActions(id, e);
    const choose = (call: () => Promise<boolean>, text: string, tookOver: boolean) => {
      setBusy(true);
      void call()
        .then((done) => done && setSent({ review: e.reviewRun, text, tookOver }))
        .finally(() => setBusy(false));
    };
    return (
      <EscalationCardView
        escalation={{ ...e, reviewDraft: offered }}
        busy={busy}
        drafting={drafting}
        onFixRound={() => choose(actions.onFixRound, fixRoundSent(e.buildLabel), false)}
        onTakeOver={() => choose(actions.onTakeOver, TAKEN_OVER, true)}
        onPost={() => {
          if (!offered) return;
          useEscalationDrafts.setState((s) => ({ opened: { ...s.opened, [e.reviewRun]: offered } }));
          actions.onPost(offered);
        }}
      />
    );
  }
  return shown === "sent" && sent ? <EscalationSent text={sent.text} /> : null;
}
