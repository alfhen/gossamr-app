import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MentionTextarea } from "../components/MentionTextarea";
import { PipGlyph } from "../components/PipGlyph";
import { docText } from "../lib/docs";
import { autoLink, liveMentions, rewriteNote, subtasksNote, type Mention } from "../lib/mentions";
import { isRunDraft as isAgentDraft, targetOf, unreachable } from "../lib/proposals";
import { useBackend } from "../backend/useBackend";
import type { Person, Proposal, ProposalEdit, ProposalStateKind, ReviewAccess } from "../types";
import { useRepoReviewAccess, useReviewAccess } from "./reviewAccess";
import { editThenPost, ReviewDraft, reviewWithPipPrompt } from "./ReviewDraft";
import { draftStatus } from "./boardLogic";
import { showMe } from "./jump";
import { askPip } from "./askPip";
import { useRuns } from "./runsStore";
import { useWorkspace, workflowOfItem } from "../workspaceStore";
import { PEEK_DRAFT_MARGIN, peekFocusAfterLeaving } from "./peekDrafts";
import { KeyHint } from "./KeyHint";
import { keptEdits, keptEditsOfDraft, type KeptEdits } from "./keptEdits";
import { useToasts } from "./toasts";
import { doneText, postedToJira } from "./NeedsPane";
import { escLeavesPause, useCardKeys } from "./draftCardKeys";
import { takeDraftEditIntent } from "./draftKeys";
import { itemKey } from "../lib/filter";
import { RetiredDraft } from "./RetiredDraft";
import { bodyChangeSize, RewriteView, rewriteBlocked, rewriteEdit, rewriteFields, rewriteWhat, takesBackendText } from "./RewriteDiff";
import { newRiskQuote, newRisks, type Risk, type RiskQuotes } from "../lib/riskyText";
import { PostingPause } from "./PostingPause";
import { liveDraft, setLiveDraft, touchDrafts, useDraftsRev } from "./draftLive";
import { focusWhenDrawn } from "./focusDrawn";

import { FromRun, useFromRunName } from "./RunProvenance";

export { focusWhenDrawn };

const BADGE: Record<Proposal["state"]["type"], string> = {
  pending: "Needs your approval",
  applying: "Working…",
  applied: "Done",
  skipped: "Skipped",
  retired: "Out of date",
};

const LINK_VERB: Record<Extract<Proposal["intent"], { type: "link" }>["kind"], string> = { blocks: "blocks", relates: "relates to", duplicates: "duplicates", implementedBy: "is implemented by" };

/** What a link draft says, such as `CA-2 blocks CA-1`. */
export const linkSentence = (i: Extract<Proposal["intent"], { type: "link" }>) => `${i.from.key} ${LINK_VERB[i.kind]} ${i.to.key}`;

/** A draft's title. Drafts that started or messaged an agent are history: Pip does that directly now. */
export function draftTitle(p: Proposal): string {
  const i = p.intent;
  switch (i.type) {
    case "comment":
      return `Comment on ${i.item.key}`;
    case "transition":
      return `Move ${i.item.key}`;
    case "subtasks":
      return `Subtasks under ${i.parent.key}`;
    case "create":
      return `New ${i.fields.kind}`;
    case "update":
      return `Update ${i.item.key}`;
    case "rewrite":
      return `Update the ${rewriteWhat(i)} of ${i.item.key}`;
    case "link":
      return `Link ${i.from.key}`;
    case "startRun":
      return `Agent run: ${i.item?.key ?? `${i.spec.repo}, no ticket`}`;
    case "followUp":
      return i.item ? `Follow-up for the ${i.item.key} run` : "Follow-up for a run";
    case "runAnswer":
      return i.item ? `Answer for the ${i.item.key} run` : "Answer for a run";
    case "githubReview":
      return `GitHub review of ${i.repo}#${i.number}`;
    default:
      return unreachable(i);
  }
}

/** One line for lists: what approving would do. */
export function draftSummary(p: Proposal, statusName: string | null): string {
  const i = p.intent;
  switch (i.type) {
    case "comment":
      return docText(i.body).replace(/\s+/g, " ");
    case "transition":
      return `to ${statusName ?? p.label ?? i.to}`;
    case "subtasks":
      return `${i.summaries.length} subtask${i.summaries.length === 1 ? "" : "s"}: ${i.summaries.join(", ")}`;
    case "create":
      return i.fields.title;
    case "update":
      return "Change fields";
    case "rewrite": {
      const size = i.body ? bodyChangeSize(i.body.fromText, i.body.toText) : null;
      return [i.title ? `Title: ${i.title.from} → ${i.title.to}` : null, size ? `Description: ${size.added} ${size.added === 1 ? "line" : "lines"} added, ${size.removed} removed` : null].filter(Boolean).join("; ");
    }
    case "link":
      return linkSentence(i);
    case "startRun":
      return `${i.spec.role} in ${i.spec.repo}`;
    case "followUp":
      return i.reason;
    case "runAnswer":
      return i.message.replace(/\s+/g, " ");
    case "githubReview":
      return `${i.comments.length} inline comment${i.comments.length === 1 ? "" : "s"}: ${i.summary.split("\n")[0]}`;
    default:
      return unreachable(i);
  }
}

/** Brings the posting pause into view and puts the keyboard on its Keep editing. The actions row is scrolled first and the note last, so the note is what the last scroll leaves in view (its scroll margin clears a sticky footer). */
export function showPause(card: Pick<ParentNode, "querySelector"> | null) {
  const keep = card?.querySelector<HTMLElement>("[data-post-pause-keep]");
  if (!keep) return;
  keep.focus({ preventScroll: true });
  card?.querySelector<HTMLElement>("[data-draft-actions]")?.scrollIntoView?.({ block: "nearest" });
  (keep.closest?.<HTMLElement>("[data-post-pause]") ?? keep).scrollIntoView?.({ block: "nearest" });
}

/** The pause for an edited rewrite: lines count in the description alone, since the title above it is not line 1 of what the person edits, and the title's catches carry no line (G4). */
export function rewriteRisks(wasTitle: string, wasText: string, newTitle: string, newText: string): { risks: Risk[]; quote: RiskQuotes } {
  const quote: RiskQuotes = newRiskQuote(wasText, newText);
  for (const [r, found] of Object.entries(newRiskQuote(wasTitle, newTitle)) as [Risk, string[]][]) quote[r] = [...found.map((q) => q.split("\t")[0]), ...(quote[r] ?? [])];
  return { risks: newRisks(`${wasTitle}\n${wasText}`, `${newTitle}\n${newText}`), quote };
}

/** What Esc at the posting pause tells a screen reader: the editor closed and the words are still there. */
export const EDIT_KEPT_NOTE = "Edit kept. Nothing was posted.";

/** What a screen reader hears when `p` was posted from its card: what was posted. Null when `done` did not reach Jira. */
export function postedNote(p: Proposal, done: Proposal | null): string | null {
  if (!done) return null;
  const proposals = { [p.id]: done };
  const target = { type: "draft", id: p.id } as const;
  if (!postedToJira({ target }, proposals)) return null;
  return doneText({ title: draftTitle(p), ticketKey: undefined, workstreamTitle: "" }, true);
}

export interface DraftCardProps {
  proposal: Proposal;
  /** The status a transition moves to, by name. */
  statusName: string | null;
  people: Person[];
  working: boolean;
  error: string | null;
  /** `postAnyway` is a review's Post anyway: the person's choice to send one that may already be on GitHub. */
  onApprove(edit: ProposalEdit | null, options?: { postAnyway?: boolean }): void;
  onSkip(): void;
  /** Present when the draft's item may be off screen. */
  onShow?(): void;
  /** Opens the agent run a draft was made from. */
  onOpenRun?(runId: string): void;
  /** Present on a comment or a review made from a run's result: opens Pip on the run and this draft. A review card hands over the person's unsent edit, saved first so Pip reads their version. */
  onDiscuss?(edit?: ProposalEdit | null): void;
  /** For a GitHub review, whether the token may post it; null while that is being asked. Approving a review posts it. */
  access?: ReviewAccess | null;
  /** The level of the headings inside the card, one below the heading of the surface it sits in (the decision pane's is 2, so 3). */
  headingLevel?: 3 | 4;
}

const button = "rounded-md border border-ws-sep2 px-2.5 py-1 text-sm hover:bg-ws-hover disabled:opacity-45";
const primary = "rounded-md bg-ws-pip px-3.5 py-1.5 text-sm font-semibold text-ws-on-pip shadow-sm hover:brightness-110 disabled:opacity-45";

/** Under a comment being read whose text looks like a secret: the pause is coming, and the text above is what would be posted. */
export const SECRET_NOTE = "This holds something that looks like a secret. Gossamr will pause before posting it.";

export function DraftCard(props: DraftCardProps) {
  const p = props.proposal;
  // A review has a card of its own: its comments sit over their lines of the diff, and it is posted to GitHub, not applied.
  const Body = p.intent.type === "githubReview" ? ReviewDraft : isAgentDraft(p.intent) ? AgentDraftHistory : DraftCardBody;
  if (p.state.type !== "retired") return <Body {...props} />;
  return (
    <RetiredDraft proposal={p} title={draftTitle(p)} state={BADGE.retired}>
      <Body {...props} />
    </RetiredDraft>
  );
}

export type { KeptEdits } from "./keptEdits";

/** Remember the unsaved `edits` of draft `id`, until the draft is posted or retired; no edits leave nothing kept. */
export function keepEditsOfDraft(id: string, edits: KeptEdits): void {
  if (edits.body || edits.rewrite || edits.picked) keptEdits.set(id, edits);
  else keptEdits.delete(id);
  touchDrafts();
}

/** The edits kept for draft `id`, if any. They stay while the draft can still be shown, so leaving a restored card before posting it doesn't lose them. */
export { keptEditsOfDraft } from "./keptEdits";

/** A card going away with its draft still pending keeps what was typed in it (G1), so the card that comes back shows it and "a, Enter" opens the card and doesn't post the stored text. */
export function keepEditsOnLeave(id: string, state: ProposalStateKind, edits: KeptEdits): void {
  if (state === "pending") keepEditsOfDraft(id, edits);
}

/** Forget the kept edits of draft `id` once it is posted or retired: nothing will show them again. */
export function settleKeptEdits(id: string, state: ProposalStateKind): void {
  if ((state === "applied" || state === "retired") && keptEdits.delete(id)) touchDrafts();
}

/** Whether draft `id` holds an edit its stored text doesn't (a mounted card's or one kept for it), and a comment's text as edited; follows the card as it is typed in. */
export function useEditedDraft(id: string): { edited: boolean; text?: string } {
  useDraftsRev();
  const live = liveDraft(id);
  const kept = keptEditsOfDraft(id);
  return { edited: !!live?.edited || !!kept, text: live?.text ?? kept?.body?.text };
}

function DraftCardBody({ proposal: p, statusName, people, working, error, onApprove, onSkip, onShow, onOpenRun, onDiscuss, headingLevel }: DraftCardProps) {
  const intent = p.intent;
  const key = targetOf(intent)?.key ?? "";
  const stored = intent.type === "comment" ? docText(intent.body) : "";
  const linked = useMemo(() => autoLink(stored, people), [stored, people]);
  // A card that comes back after Skip (Undo) starts from what was typed in it, shown as a preview with Edit beside it.
  const [kept] = useState(() => keptEditsOfDraft(p.id));
  useEffect(() => settleKeptEdits(p.id, p.state.type), [p.id, p.state.type]);
  const [body, setBody] = useState(kept?.body?.text ?? linked.text);
  const [mentions, setMentions] = useState<Mention[]>(kept?.body?.mentions ?? linked.mentions);
  const [editing, setEditing] = useState(false);
  const edited = useRef(!!kept?.body);
  const rewrite = intent.type === "rewrite" ? intent : null;
  const runName = useFromRunName(p);
  const [newTitle, setNewTitle] = useState(kept?.rewrite?.title ?? rewriteFields(rewrite).title);
  const [newText, setNewText] = useState(kept?.rewrite?.text ?? rewriteFields(rewrite).text);
  const rewriteEdited = useRef(!!kept?.rewrite);
  const card = useRef<HTMLElement>(null);
  /** The keyboard was in the card, and hasn't gone anywhere else since: a button disabled while it works drops it on the page. */
  const hadFocus = useRef(false);
  // A card decided in the peek leaves "Drafts waiting"; if the keyboard was in it, it goes on to the next card, not nowhere.
  useLayoutEffect(() => {
    const el = card.current;
    return () => {
      const at = document.activeElement;
      if (!el || !hadFocus.current || !(!at || at === document.body || el.contains(at))) return;
      peekFocusAfterLeaving(el, document);
    };
  }, []);
  const attempting = useRef(working);
  attempting.current = working;
  // Pip may revise its draft while the card is open; follow it until the person types. Text that changes during an approval is
  // the person's own edit coming back from the backend, which normalises it (a title is one line, whitespace collapsed), so take it too.
  useEffect(() => {
    if (!takesBackendText(rewriteEdited.current, attempting.current)) return;
    rewriteEdited.current = false;
    setNewTitle(rewriteFields(rewrite).title);
    setNewText(rewriteFields(rewrite).text);
  }, [rewrite?.title?.to, rewrite?.body?.toText]);
  const rewriteBlock = !!rewrite && rewriteBlocked(rewrite, newTitle, newText);
  const summaries = intent.type === "subtasks" ? intent.summaries : [];
  const made = p.created.length;
  const [picked, setPicked] = useState<boolean[]>(() => (kept?.picked?.length === summaries.length ? kept.picked : summaries.map(() => true)));
  // New subtasks start ticked again; the ones a card came back with (Undo) keep the ticks they had.
  const pickedFor = useRef(summaries.join("\n"));
  useEffect(() => {
    if (pickedFor.current === summaries.join("\n")) return;
    pickedFor.current = summaries.join("\n");
    setPicked(summaries.map(() => true));
  }, [summaries.join("\n")]);
  // People can arrive after the card first renders; link them unless the text was edited by hand.
  useEffect(() => {
    if (edited.current) return;
    setBody(linked.text);
    setMentions(linked.mentions);
  }, [linked]);

  const state = p.state.type;
  const open = state === "pending" || state === "applying";
  // Posted from a card outside the Needs pane (a peek, a workstream): the keyboard was on a button that is gone or disabled, so it goes to the line that says it is done, not to whatever the page falls back on. The pane has its own line.
  const doneLine = useRef<HTMLSpanElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = open;
    if (!was || state !== "applied" || !hadFocus.current || card.current?.closest("[data-needs-pane]")) return;
    focusWhenDrawn(() => doneLine.current, () => document.activeElement);
  }, [open, state]);
  const remaining = summaries.filter((_, i) => i >= made && picked[i]).length;
  const revision = p.revisions[p.revisions.length - 1];
  const shownError = error ?? p.error;
  // A refusal above the fold of a tall diff is brought into view, not left for the person to find.
  const errorLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (shownError) errorLine.current?.scrollIntoView?.({ block: "nearest" });
  }, [shownError]);

  /** What is typed in the card's fields that the draft doesn't hold yet. */
  const typed = (): KeptEdits => ({
    ...(intent.type === "comment" && edited.current ? { body: { text: body, mentions } } : {}),
    ...(rewrite && rewriteEdited.current ? { rewrite: { title: newTitle, text: newText } } : {}),
    ...(intent.type === "subtasks" && picked.some((on) => !on) ? { picked } : {}),
  });
  // A card restored with kept edits keeps its saved copy current, so it survives the card going away before it is posted.
  useEffect(() => {
    if (keptEditsOfDraft(p.id)) keepEditsOfDraft(p.id, typed());
  }, [body, mentions, newTitle, newText, picked]);

  /** Skip, taking what was typed along, so Undo shows it again. */
  const skip = () => {
    keepEditsOfDraft(p.id, typed());
    onSkip();
  };

  const edit = (): ProposalEdit | null => {
    if (intent.type === "comment" && edited.current) return { type: "comment", body, mentions: liveMentions(body, mentions) };
    if (rewrite && rewriteEdited.current) return rewriteEdit(rewrite, newTitle, newText);
    if (intent.type === "subtasks") {
      const wanted = summaries.filter((_, i) => i < made || picked[i]);
      return wanted.length === summaries.length ? null : { type: "subtasks", summaries: wanted };
    }
    return null;
  };

  // Edited words that mention everyone or look like a secret wait for a second press: a confirm the person can pass, never a block.
  const [pause, setPause] = useState<{ risks: Risk[]; quote: RiskQuotes } | null>(null);
  const risks = (): { risks: Risk[]; quote: RiskQuotes } => {
    if (intent.type === "comment" && edited.current) return { risks: newRisks(linked.text, body), quote: newRiskQuote(linked.text, body) };
    if (rewrite && rewriteEdited.current) {
      const { title, text } = rewriteFields(rewrite);
      return rewriteRisks(title, text, newTitle, newText);
    }
    return { risks: [], quote: {} };
  };
  // Words the person changed, a comment's body or a rewrite's title and text: the alert and the provenance line stop calling them the agent's (G5).
  const youEdited = edited.current || rewriteEdited.current;
  // The keyboard route from Needs you's list reads this: an edit or a pause waiting means "a, Enter" opens the card and doesn't approve the stored text (G1).
  useEffect(() => {
    setLiveDraft(p.id, p.state.type === "pending" ? { edited: Object.keys(typed()).length > 0 || edit() !== null, risky: risks().risks.length > 0, ...(intent.type === "comment" && edited.current ? { text: body } : {}) } : null);
  });
  // The latest committed edits and state, for the cleanup below to read as the card goes; set after each commit, never in render.
  const leaving = useRef({ state: p.state.type, edits: typed() });
  useEffect(() => {
    leaving.current = { state: p.state.type, edits: typed() };
  });
  useEffect(
    () => () => {
      keepEditsOnLeave(p.id, leaving.current.state, leaving.current.edits);
      setLiveDraft(p.id, null);
    },
    [p.id],
  );
  /** The step the Post button and Enter take: pauses once for edited text that would reach everyone, else approves. */
  const approve = () => {
    const found = risks();
    if (found.risks.length && !pause) {
      setPause(found);
      // The keyboard goes to the safe choice, not to a Post button that now reads "Post anyway"; the note and the actions come into view with it.
      requestAnimationFrame(() => showPause(card.current));
      return;
    }
    setPause(null);
    onApprove(edit());
  };
  /** Keep editing: the pause goes, the text stays and the field has the keyboard. */
  const keepEditing = () => {
    setPause(null);
    setEditing(true);
    focusField("textarea, input:not([type]), input[type=text]");
  };
  /** Esc in the editor while the pause shows: the editor closes with the text kept, the pause goes with it (the next Approve checks the words again) and the Edit button has the keyboard. */
  const leaveEditing = () => {
    setPause(null);
    setEditing(false);
    focusWhenDrawn(() => card.current?.querySelector<HTMLElement>("[data-draft-edit]") ?? null, () => document.activeElement);
    useToasts.getState().push(EDIT_KEPT_NOTE, "info");
  };
  // Another edit takes the pause back: it said what the earlier words held.
  useEffect(() => setPause(null), [body, newTitle, newText]);

  /** The field of the card the keyboard goes to for e: a text box, or the first choice. */
  const focusField = (selector: string) => requestAnimationFrame(() => card.current?.querySelector<HTMLElement>(selector)?.focus());
  const approvable = open && !working && state !== "applying";
  const startEditing = !open
    ? undefined
    : intent.type === "comment" || rewrite
      ? () => (setEditing(true), focusField("textarea, input:not([type]), input[type=text]"))
      : intent.type === "subtasks"
        ? () => focusField("input[type=checkbox]")
        : undefined;
  // Opened by e on the compact card (in the peek, after it): it starts in editing, as e on this card would.
  useEffect(() => {
    if (takeDraftEditIntent(p.id)) startEditing?.();
  }, []);
  const keys = useCardKeys(p, {
    // Approving by key is the same step the button takes, asked for Enter first; what needs reading first has no key.
    approve: !approvable
      ? undefined
      : intent.type === "comment"
        ? body.trim()
          ? approve
          : undefined
        : intent.type === "subtasks"
          ? remaining > 0
            ? () => onApprove(edit())
            : undefined
          : rewrite
            ? approve
            : () => onApprove(edit()),
    skip: open && !working ? skip : undefined,
    edit: startEditing,
    open: onShow,
    primary: () => focusField("[data-draft-actions] button:not(:disabled):last-of-type"),
  });
  const action = "Approve";
  const moveName = undefined;
  const Title = headingLevel === 4 ? "h4" : "h3";
  const titleId = useId();
  return (
    <article
      ref={card}
      aria-labelledby={titleId}
      data-draft={p.id}
      {...keys.props}
      onFocus={(ev) => {
        hadFocus.current = true;
        keys.props.onFocus(ev);
      }}
      onBlur={(ev) => {
        if (ev.relatedTarget && !ev.currentTarget.contains(ev.relatedTarget as Node)) hadFocus.current = false;
        keys.props.onBlur(ev);
      }}
      className={`ws-legacy ${PEEK_DRAFT_MARGIN} overflow-clip rounded-[10px] border border-dashed border-ws-pip bg-ws-win text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip ${state === "skipped" || state === "retired" ? "opacity-55" : ""}`}
    >
      <div className="flex items-center gap-2 bg-ws-pip-soft px-3 py-1.5 text-sm font-semibold text-ws-pip">
        <PipGlyph />
        {/* The card is named by this heading, so a screen reader says the title once. */}
        <Title id={titleId} className="m-0 text-sm font-semibold">
          {draftTitle(p)}
        </Title>
        <span ref={doneLine} tabIndex={-1} data-draft-state className="ml-auto font-normal text-ws-ink3 focus-visible:outline-2 focus-visible:outline-ws-pip">
          {BADGE[state]}
        </span>
      </div>
      <div
        className="grid gap-2 px-3 py-2.5"
        onKeyDown={(ev) => {
          if (!escLeavesPause({ key: ev.key, defaultPrevented: ev.defaultPrevented, target: ev.target as HTMLInputElement }, !!pause, editing)) return;
          ev.preventDefault();
          ev.stopPropagation();
          leaveEditing();
        }}
      >
        {intent.type === "comment" &&
          (editing && open ? (
            <MentionTextarea
              id={`draft-${p.id}`}
              value={body}
              mentions={mentions}
              onChange={(v, m) => {
                edited.current = true;
                setBody(v);
                setMentions(m);
              }}
              ticketKey={key}
              people={people}
              label={`Edit the comment on ${key}`}
              // Grows with its text, and never shorter than about six lines: two lines was too little to edit a comment in.
              fill
              className="rounded-md border border-ws-sep2 bg-ws-win [&_textarea]:min-h-40"
            />
          ) : (
            <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{body}</p>
          ))}
        {intent.type === "comment" && !editing && open && risks().risks.includes("secret") && (
          // The words stay as written, since the person posts what they read; what the pause would catch is said before Post, not only at it.
          <p data-secret-note className="m-0 text-sm text-ws-ink3">
            {SECRET_NOTE}
          </p>
        )}
        {intent.type === "transition" && (
          <p className="m-0">
            Move <b className="font-mono">{key}</b> to <b>{statusName ?? p.label ?? intent.to}</b>
          </p>
        )}
        {intent.type === "create" && (
          <div className="grid gap-1">
            <b>{intent.fields.title}</b>
            {docText(intent.fields.body) && <div className="whitespace-pre-wrap text-ws-ink2">{docText(intent.fields.body)}</div>}
          </div>
        )}
        {rewrite && (
          <RewriteView
            intent={rewrite}
            title={newTitle}
            body={newText}
            editing={editing}
            disabled={!open}
            onTitle={(v) => ((rewriteEdited.current = true), setNewTitle(v))}
            onBody={(v) => ((rewriteEdited.current = true), setNewText(v))}
            runName={p.origin.type === "run" ? runName : null}
            headingLevel={headingLevel}
          />
        )}
        {rewrite && open && (
          <p data-rewrite-note className="m-0 text-sm text-ws-ink3">
            {rewriteNote(rewriteWhat(rewrite))}
          </p>
        )}
        {intent.type === "subtasks" && open && remaining > 0 && (
          <p data-subtasks-note className="m-0 text-sm text-ws-ink3">
            {subtasksNote(remaining, intent.parent.key)}
          </p>
        )}
        {intent.type === "link" && (
          <p className="m-0">
            <b className="font-mono">{intent.from.key}</b> {LINK_VERB[intent.kind]} <b className="font-mono">{intent.to.key}</b>
          </p>
        )}
        {intent.type === "subtasks" &&
          summaries.map((s, i) => (
            <label key={i} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={picked[i] || i < made}
                disabled={!open || i < made}
                onChange={(e) => setPicked(picked.map((v, j) => (j === i ? e.target.checked : v)))}
                className="mt-1"
              />
              {s}
              {i < made && <span className="ml-auto font-mono text-ws-ink3">{p.created[i].key}</span>}
            </label>
          ))}
        {p.origin.type === "run" && (
          <p data-provenance="run" className="m-0 text-sm text-ws-ink3">
            {p.createdBy === "agent" && (
              <span data-created-by="agent" className="mr-2 rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">
                Drafted by an agent
              </span>
            )}{" "}
            <FromRun proposal={p} onOpen={onOpenRun ? () => onOpenRun((p.origin as { runId: string }).runId) : undefined} />
            {youEdited ? ". You edited it." : ". The words are the agent's."}
          </p>
        )}
        {p.state.type === "retired" && <p className="m-0 text-sm text-ws-ink3">{p.state.reason}</p>}
        {open && revision && !shownError && <p className="m-0 text-sm text-ws-ink3">{revision.note}</p>}
        {shownError && (
          <p ref={errorLine} role="alert" className="m-0 text-sm text-ws-blocked">
            {shownError}
          </p>
        )}
        {pause && open && <PostingPause risks={pause.risks} quote={pause.quote} subject={youEdited ? "Your edit" : "This draft"} anyway="Post anyway" working={working || state === "applying"} onKeep={keepEditing} onPost={approve} />}
        {(open || onShow) && (
          <div data-draft-actions className="sticky bottom-0 z-[1] -mx-3 -mb-2.5 flex flex-wrap items-center justify-end gap-2 border-t border-ws-sep bg-ws-win px-3 py-2">
            {onShow && (
              <button type="button" onClick={onShow} className="mr-auto text-sm text-ws-pip hover:underline">
                Show me
              </button>
            )}
            {open && (
              <>
                {onDiscuss && (
                  <button type="button" disabled={working} onClick={() => onDiscuss()} title="Pip reads the whole run and this draft, and changes the draft if you ask" className={button}>
                    Ask Pip
                  </button>
                )}
                {(intent.type === "comment" || rewrite) && (
                  <button type="button" data-draft-edit disabled={working} onClick={() => (editing ? setEditing(false) : (setEditing(true), focusField("textarea, input:not([type]), input[type=text]")))} className={button}>
                    {editing ? "Done editing" : "Edit"}
                  </button>
                )}
                <button type="button" disabled={working} onClick={skip} className={button}>
                  Skip
                </button>
                {/* While the pause shows, its own Post anyway stands in for this button, beside Keep editing. */}
                {!pause && (
                  <button type="button" disabled={working || state === "applying" || (intent.type === "comment" && !body.trim()) || (intent.type === "subtasks" && remaining === 0) || rewriteBlock} aria-label={working || state === "applying" ? undefined : moveName} onClick={approve} className={primary}>
                    {working || state === "applying" ? "Working…" : action}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {/* Always mounted, so the live region is there before the confirm that fills it. */}
      <KeyHint hint={keys.hint ?? ""} asking={!!keys.asking} className={`m-0 border-t border-ws-sep px-3 py-1 text-xs ${keys.asking ? "bg-ws-pip-soft font-semibold text-ws-pip" : "bg-ws-bar text-ws-ink3"}`} />
    </article>
  );
}

/** A draft that started or messaged an agent, from before Pip did that directly: read-only, with what it was and how it ended. */
function AgentDraftHistory({ proposal: p, onOpenRun }: DraftCardProps) {
  const text = p.intent.type === "startRun" ? p.intent.spec.brief : draftSummary(p, null);
  const runId = p.run ?? (p.intent.type === "followUp" || p.intent.type === "runAnswer" ? p.intent.runId : null);
  return (
    <article data-draft={p.id} data-agent-draft-history className="ws-legacy grid gap-1.5 rounded-[10px] border border-ws-sep bg-ws-win px-3 py-2.5 text-base opacity-80">
      <p className="m-0 flex items-baseline gap-2 font-semibold">
        {draftTitle(p)}
        <span data-draft-state className="ml-auto text-sm font-normal text-ws-ink3">
          {BADGE[p.state.type]}
        </span>
      </p>
      <p className="m-0 line-clamp-3 whitespace-pre-wrap text-ws-ink2 [overflow-wrap:anywhere]">{text}</p>
      <p className="m-0 text-sm text-ws-ink3">
        Pip starts and messages agents directly now, so this kind of draft is kept only as history.
        {runId && onOpenRun && (
          <>
            {" "}
            <button type="button" onClick={() => onOpenRun(runId)} className="text-ws-pip hover:underline">
              Open the run
            </button>
          </>
        )}
      </p>
    </article>
  );
}

/** A draft card wired to the workspace: approving or skipping goes through the store, and edits are saved first. */
export function LiveDraftCard({ proposal: p, jump = true, headingLevel }: { proposal: Proposal; jump?: boolean; headingLevel?: 3 | 4 }) {
  const backend = useBackend();
  const names = useWorkspace((s) => s.names);
  const containers = useWorkspace((s) => s.containers);
  const target = targetOf(p.intent);
  const item = useWorkspace((s) => (target ? s.items[itemKey(target)] : undefined));
  const people = useMemo(() => Object.entries(names).map(([accountId, name]) => ({ accountId, name })), [names]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusName = item && p.intent.type === "transition" ? (draftStatus(p, workflowOfItem({ containers }, item))?.name ?? null) : null;

  const run = async (job: () => Promise<Proposal | null>) => {
    setWorking(true);
    setError(null);
    try {
      const done = await job();
      if (done?.error) setError(done.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const review = p.intent.type === "githubReview" ? p.intent : null;
  const access = useRepoReviewAccess(review?.connectionId ?? null, review?.repo ?? null);

  return (
    <DraftCard
      proposal={p}
      headingLevel={headingLevel}
      statusName={statusName}
      people={people}
      working={working}
      error={error}
      onShow={jump && target && item ? () => showMe(target) : undefined}
      onSkip={() => void run(() => useWorkspace.getState().skip(p.id))}
      onOpenRun={(id) => useRuns.getState().openRun(id)}
      onDiscuss={(edit) => void run(async () => {
        if (edit && backend) await backend.proposalsEdit(p.id, edit);
        askPip({ prompt: review ? reviewWithPipPrompt(p) : `Read draft ${p.id} in full with get_proposal, then help me improve it. Change it only if I ask. Nothing is posted until I approve it.`, shown: "Ask Pip about this draft" });
        return null;
      })}
      access={access}
      onApprove={(edit, options) =>
        void run(async () => {
          // A review goes to GitHub by its own path, and only on this approval; never through the tracker.
          if (review) {
            if (!backend) return null;
            // The person's edit is saved first, so what is posted is what the card shows.
            const done = await editThenPost(p.id, edit, p.revisions.length, { saveEdit: (id, e) => backend.proposalsEdit(id, e), post: (id, revisions) => useWorkspace.getState().postReview(id, revisions, options?.postAnyway) });
            // A refusal may have been for want of access, which is then asked again.
            if (done.error) useReviewAccess.getState().forget(review.connectionId, review.repo);
            return done;
          }
          if (edit && backend) await backend.proposalsEdit(p.id, edit);
          const inPane = !!document.querySelector(`[data-draft="${CSS.escape(p.id)}"]`)?.closest("[data-needs-pane]");
          const done = await useWorkspace.getState().approve(p.id);
          // The pane's own line says it when a post moves on to the next need; anywhere else this is the only word.
          const note = inPane ? null : postedNote(p, done);
          if (note) useToasts.getState().push(note, "info");
          return done;
        })
      }
    />
  );
}
