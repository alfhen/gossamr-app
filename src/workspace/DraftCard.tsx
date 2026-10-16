import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MentionTextarea } from "../components/MentionTextarea";
import { docText } from "../lib/docs";
import { autoLink, liveMentions, mentionNote, rewriteNote, type Mention } from "../lib/mentions";
import { answersProvenance, isAnswersDraft, isReporterNudge, isReporterQuestions, targetOf, unreachable } from "../lib/proposals";
import { APPROVAL_STARTS_BUILD, approvalStartsBuild } from "../lib/nextStep";
import { useClaude } from "../claudeStore";
import { useWorkstreams } from "./workstreamsStore";
import { useTabs } from "./tabsStore";
import { useBackend } from "../backend/useBackend";
import type { Person, Proposal, ProposalEdit, ProposalStateKind, ReviewAccess } from "../types";
import { useRepoReviewAccess, useReviewAccess } from "./reviewAccess";
import { editThenPost, ReviewDraft, reviewWithPipPrompt } from "./ReviewDraft";
import { draftStatus } from "./boardLogic";
import { showMe } from "./jump";
import { KIND_LABEL } from "./agentsLogic";
import { askPip } from "./askPip";
import { PIP_SHOWN, pipAsks } from "./runSheetLogic";
import { useRunSetup } from "./runSetupStore";
import { useRuns } from "./runsStore";
import { useWorkspace, workflowOfItem } from "../workspaceStore";
import { PEEK_DRAFT_MARGIN, peekFocusAfterLeaving } from "./peekDrafts";
import { useToasts } from "./toasts";
import { doneText, postedToJira, waitStarted } from "./NeedsPane";
import { escLeavesPause, useCardKeys } from "./draftCardKeys";
import { takeDraftEditIntent } from "./draftKeys";
import { itemKey } from "../lib/filter";
import { FOLLOW_UP_LIMIT, followUpProblem, followUpTitle, nextPass } from "./followUp";
import { RetiredDraft } from "./RetiredDraft";
import { answerProblem, MAX_ANSWER } from "../lib/answer";
import { answerTitle, editThenSend, isSendKey, NOT_WAITING, useAnswerRun, type AnswerRun } from "./runAnswer";
import { bodyChangeSize, RewriteView, rewriteBlocked, rewriteEdit, rewriteFields, rewriteWhat, takesBackendText } from "./RewriteDiff";
import { newRiskQuote, newRisks, type Risk, type RiskQuotes } from "../lib/riskyText";
import { PostingPause } from "./PostingPause";
import { liveDraft, setLiveDraft, touchDrafts, useDraftsRev } from "./draftLive";
import { focusWhenDrawn } from "./focusDrawn";

import { FromRun, RunName, useFromRunName } from "./RunProvenance";

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

/** A draft's title; an answer names its run by `runLabel` ("R1") when the caller knows it. */
export function draftTitle(p: Proposal, runLabel?: string | null): string {
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
      return `Start an agent: ${i.item?.key ?? `${i.spec.repo}, no ticket`}`;
    case "followUp":
      return followUpTitle(i);
    case "runAnswer":
      return answerTitle(i, runLabel);
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
      return `${i.spec.kind} in ${i.spec.repo}`;
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

/** What Esc at the posting pause tells a screen reader: the editor closed and the words are still there. */
export const EDIT_KEPT_NOTE = "Edit kept. Nothing was posted.";

/** What a screen reader hears when `p` was posted from its card: what was posted, and that the ticket waits on the reporter when that is what it started. Null when `done` did not reach Jira. */
export function postedNote(p: Proposal, done: Proposal | null): string | null {
  if (!done) return null;
  const key = targetOf(p.intent)?.key ?? "";
  const title = isReporterQuestions(p) ? `Questions for the reporter${key ? ` on ${key}` : ""}` : isReporterNudge(p) ? `Nudge for the reporter${key ? ` on ${key}` : ""}` : draftTitle(p);
  const proposals = { [p.id]: done };
  const target = { type: "draft", id: p.id } as const;
  if (!postedToJira({ target }, proposals)) return null;
  const waits = waitStarted({ target, ticketKey: key || undefined }, proposals);
  return `${doneText({ title, ticketKey: undefined, workstreamTitle: "" }, true)}${waits ? ` ${waits}.` : ""}`;
}

/** Whether approving `p` also starts a Build (`approvalStartsBuild`), read from the runs, the workstream and Settings' switches. */
export function useApprovalStartsBuild(p: Proposal): boolean {
  const runId = p.origin.type === "run" ? p.origin.runId : null;
  const run = useRuns((s) => (runId ? s.runs.find((r) => r.id === runId) : undefined));
  // The plan's own workstream: only a run in it is one the supervisor starts a Build after.
  const ws = run?.spec.workstream ?? null;
  const view = useWorkstreams((s) => (ws ? s.list.find((v) => v.workstream.id === ws) : undefined));
  const globals = useWorkstreams((s) => s.globals);
  return approvalStartsBuild(p, run, view, globals);
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
  /** Opens the setup sheet for a run draft, the one place it is approved. */
  onReview?(): void;
  /** Present when the draft's item may be off screen. */
  onShow?(): void;
  /** Opens the agent run a draft was made from. */
  onOpenRun?(runId: string): void;
  /** Present on a comment or a review made from a run's result: opens Pip on the run and this draft. A review card hands over the person's unsent edit, saved first so Pip reads their version. */
  onDiscuss?(edit?: ProposalEdit | null): void;
  /** For a follow-up, the pass the agent would be on once it is sent. */
  pass?: number;
  /** Sends a follow-up back to its run, after saving the edit. */
  onSendBack?(edit: ProposalEdit | null, message: string): void;
  /** For an answer, how the run it answers stands now. */
  answer?: AnswerRun | null;
  /** Sends an answer to its run, after saving the edit. */
  onSendAnswer?(edit: ProposalEdit | null, message: string): void;
  /** For a GitHub review, whether the token may post it; null while that is being asked. Approving a review posts it. */
  access?: ReviewAccess | null;
  /** The level of the headings inside the card, one below the heading of the surface it sits in (the decision pane's is 2, so 3). */
  headingLevel?: 3 | 4;
}

const button = "rounded-md border border-ws-sep2 px-2.5 py-1 text-sm hover:bg-ws-hover disabled:opacity-45";
const primary = "rounded-md bg-ws-pip px-3.5 py-1.5 text-sm font-semibold text-ws-on-pip shadow-sm hover:brightness-110 disabled:opacity-45";

/** What an answers draft's text would put in front of everyone: checked against nothing, since none of it was on the ticket before the person typed it in the composer. */
export function answersRisks(text: string): { risks: Risk[]; quote: RiskQuotes } {
  return { risks: newRisks("", text), quote: newRiskQuote("", text) };
}

export function DraftCard(props: DraftCardProps) {
  const p = props.proposal;
  // A review has a card of its own: its comments sit over their lines of the diff, and it is posted to GitHub, not applied.
  const Body = p.intent.type === "githubReview" ? ReviewDraft : DraftCardBody;
  if (p.state.type !== "retired") return <Body {...props} />;
  return (
    <RetiredDraft proposal={p} title={draftTitle(p, props.answer?.label)} state={BADGE.retired}>
      <Body {...props} />
    </RetiredDraft>
  );
}

/** What was typed into a draft's fields when it was skipped, so Undo brings the draft back with the edit still in them. */
export interface KeptEdits {
  body?: { text: string; mentions: Mention[] };
  rewrite?: { title: string; text: string };
  message?: string;
  /** Which proposed subtasks were still ticked, when any was unticked. */
  picked?: boolean[];
}
const keptEdits = new Map<string, KeptEdits>();

/** Remember the unsaved `edits` of draft `id`, until the draft is posted or retired; no edits leave nothing kept. */
export function keepEditsOfDraft(id: string, edits: KeptEdits): void {
  if (edits.body || edits.rewrite || edits.message !== undefined || edits.picked) keptEdits.set(id, edits);
  else keptEdits.delete(id);
  touchDrafts();
}

/** The edits kept for draft `id`, if any. They stay while the draft can still be shown, so leaving a restored card before posting it doesn't lose them. */
export function keptEditsOfDraft(id: string): KeptEdits | undefined {
  return keptEdits.get(id);
}

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

function DraftCardBody({ proposal: p, statusName, people, working, error, onApprove, onSkip, onReview, onShow, onOpenRun, onDiscuss, pass, onSendBack, answer, onSendAnswer, headingLevel }: DraftCardProps) {
  const intent = p.intent;
  const key = targetOf(intent)?.key ?? "";
  const stored = intent.type === "comment" ? docText(intent.body) : "";
  const linked = useMemo(() => autoLink(stored, people), [stored, people]);
  // A card that comes back after Skip (Undo) starts from what was typed in it, in edit mode.
  const [kept] = useState(() => keptEditsOfDraft(p.id));
  useEffect(() => settleKeptEdits(p.id, p.state.type), [p.id, p.state.type]);
  const [body, setBody] = useState(kept?.body?.text ?? linked.text);
  const [mentions, setMentions] = useState<Mention[]>(kept?.body?.mentions ?? linked.mentions);
  const [editing, setEditing] = useState(!!kept);
  const edited = useRef(!!kept?.body);
  const rewrite = intent.type === "rewrite" ? intent : null;
  const startsBuild = useApprovalStartsBuild(p);
  const runName = useFromRunName(p);
  // The message the answers draft was made from, for its provenance line: the person's reply in the conversation that asked Pip.
  const replyRequest = p.origin.type === "chat" && isAnswersDraft(p) ? p.origin.requestId : null;
  const replyPrompt = useClaude((s) => (replyRequest ? (Object.values(s.byTicket).flatMap((c) => c.turns).find((t) => t.requestId === replyRequest)?.prompt ?? null) : null));
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
  const followUp = intent.type === "followUp" ? intent : null;
  const reply = intent.type === "runAnswer" ? intent : null;
  const sentMessage = followUp?.message ?? reply?.message ?? "";
  const [message, setMessage] = useState(kept?.message ?? sentMessage);
  const messageEdited = useRef(kept?.message !== undefined);
  useEffect(() => {
    if (!takesBackendText(messageEdited.current, attempting.current)) return;
    messageEdited.current = false;
    setMessage(sentMessage);
  }, [sentMessage]);
  const messageProblem = followUp ? followUpProblem(message) : reply ? answerProblem(message) : null;
  /** Why an answer can't be sent now: what is wrong with the reply, or the run moved on. */
  const replyBlock = reply ? (messageProblem ?? (answer?.waiting ? null : NOT_WAITING)) : null;
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
    ...((followUp || reply) && messageEdited.current ? { message } : {}),
    ...(intent.type === "subtasks" && picked.some((on) => !on) ? { picked } : {}),
  });
  // A card restored with kept edits keeps its saved copy current, so it survives the card going away before it is posted.
  useEffect(() => {
    if (keptEditsOfDraft(p.id)) keepEditsOfDraft(p.id, typed());
  }, [body, mentions, newTitle, newText, message, picked]);

  /** Skip, taking what was typed along, so Undo shows it again. */
  const skip = () => {
    keepEditsOfDraft(p.id, typed());
    onSkip();
  };

  const edit = (): ProposalEdit | null => {
    if (intent.type === "comment" && edited.current) return { type: "comment", body, mentions: liveMentions(body, mentions) };
    if (rewrite && rewriteEdited.current) return rewriteEdit(rewrite, newTitle, newText);
    if (followUp && messageEdited.current) return { type: "followUp", message };
    if (reply && messageEdited.current) return { type: "runAnswer", message };
    if (intent.type === "subtasks") {
      const wanted = summaries.filter((_, i) => i < made || picked[i]);
      return wanted.length === summaries.length ? null : { type: "subtasks", summaries: wanted };
    }
    return null;
  };

  // Edited words that mention everyone or look like a secret wait for a second press: a confirm the person can pass, never a block.
  const [pause, setPause] = useState<{ risks: Risk[]; quote: RiskQuotes } | null>(null);
  const risks = (): { risks: Risk[]; quote: RiskQuotes } => {
    // An answers draft is the person's own reply put into a comment: what they pasted into the composer is new to the ticket, so all of it is checked, edited or not.
    if (intent.type === "comment" && isAnswersDraft(p)) {
      return answersRisks(edited.current ? body : linked.text);
    }
    if (intent.type === "comment" && edited.current) return { risks: newRisks(linked.text, body), quote: newRiskQuote(linked.text, body) };
    if (rewrite && rewriteEdited.current) {
      const was = `${rewriteFields(rewrite).title}\n${rewriteFields(rewrite).text}`;
      const now = `${newTitle}\n${newText}`;
      return { risks: newRisks(was, now), quote: newRiskQuote(was, now) };
    }
    return { risks: [], quote: {} };
  };
  // The keyboard route from Needs you's list reads this: an edit or a pause waiting means "a, Enter" opens the card and doesn't approve the stored text (G1).
  useEffect(() => {
    setLiveDraft(p.id, p.state.type === "pending" ? { edited: Object.keys(typed()).length > 0 || edit() !== null, risky: risks().risks.length > 0, ...(intent.type === "comment" && edited.current ? { text: body } : {}) } : null);
  });
  // The latest typed edits and state, for the cleanup below to read as the card goes.
  const leaving = useRef({ state: p.state.type, edits: typed() });
  leaving.current = { state: p.state.type, edits: typed() };
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

  const runDraft = intent.type === "startRun";
  const sendAnswer = () => {
    if (!reply || working || state !== "pending" || replyBlock) return;
    if (onSendAnswer) onSendAnswer(edit(), message.trim());
  };
  /** The field of the card the keyboard goes to for e: a text box, or the first choice. */
  const focusField = (selector: string) => requestAnimationFrame(() => card.current?.querySelector<HTMLElement>(selector)?.focus());
  const approvable = open && !working && state !== "applying";
  const startEditing = !open
    ? undefined
    : intent.type === "comment" || rewrite
      ? () => (setEditing(true), focusField("textarea, input:not([type]), input[type=text]"))
      : followUp
        ? () => focusField(`#follow-up-${p.id}`)
        : reply
          ? () => focusField(`#run-answer-${p.id}`)
          : intent.type === "subtasks"
            ? () => focusField("input[type=checkbox]")
            : runDraft && onReview
              ? onReview
              : undefined;
  // Opened by e on the compact card (in the peek, after it): it starts in editing, as e on this card would.
  useEffect(() => {
    if (takeDraftEditIntent(p.id)) startEditing?.();
  }, []);
  const keys = useCardKeys(p, {
    // Approving by key is the same step the button takes, asked for Enter first; what needs reading first has no key.
    approve: !approvable
      ? undefined
      : reply
        ? replyBlock
          ? undefined
          : sendAnswer
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
  const action =
    intent.type === "comment"
      ? "Post comment"
      : intent.type === "transition"
        ? (p.label ?? `Move to ${statusName ?? ""}`.trim())
        : intent.type === "create"
          ? `Create ${intent.fields.kind}`
          : intent.type === "subtasks"
            ? `Create ${remaining} subtask${remaining === 1 ? "" : "s"}`
            : intent.type === "link"
              ? "Create link"
              : rewrite
                ? `Update ${rewriteWhat(rewrite)}`
                : "Apply";

  return (
    <article
      ref={card}
      aria-label={draftTitle(p, answer?.label)}
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
        <span aria-hidden>✦</span>
        {draftTitle(p, answer?.label)}
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
        {intent.type === "comment" && (isReporterQuestions(p) || isReporterNudge(p)) && open && mentionNote(liveMentions(body, mentions)) && (
          <p data-mention-note className="m-0 text-sm text-ws-ink3">
            {mentionNote(liveMentions(body, mentions))}
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
        {intent.type === "startRun" && (
          <div className="grid gap-1.5">
            <p className="m-0 flex items-baseline gap-2 font-semibold">
              {KIND_LABEL[intent.spec.kind]} {intent.item?.key ?? `in ${intent.spec.repo}, no ticket`}
              {p.createdBy === "pip" && <span className="rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">Proposed by Pip</span>}
            </p>
            <p className="m-0 line-clamp-3 whitespace-pre-wrap text-ws-ink2 [overflow-wrap:anywhere]">{intent.spec.instruction}</p>
            {!intent.item && intent.spec.project && (
              <p data-ticketless className="m-0 text-sm text-ws-ink2">
                {p.createdBy === "pip" ? "Pip wrote this question; read and edit it in the prompt before you start. " : ""}When the agent finishes, Gossamr drafts one new ticket from what it found, for you to approve.
              </p>
            )}
            {intent.spec.plan?.trim() && intent.spec.planFromRun && (
              <p data-plan-from className="m-0 text-sm text-ws-ink2">
                Follows the {intent.spec.planApproved ? "" : "unedited "}plan from <RunName id={intent.spec.planFromRun} /> ({intent.spec.plan.length.toLocaleString("en")} characters, shown whole in the prompt).
              </p>
            )}
            {intent.spec.buildAccount?.trim() && intent.spec.buildFromRun && (
              <p data-build-from className="m-0 text-sm text-ws-ink2">
                Checks the builder&apos;s account from <RunName id={intent.spec.buildFromRun} /> ({intent.spec.buildAccount.length.toLocaleString("en")} characters, shown whole in the prompt) as a claim, not as evidence.
              </p>
            )}
            {intent.spec.focus?.trim() && (
              <p className="m-0 rounded-md border border-dashed border-ws-pip bg-ws-pip-soft px-2 py-1 text-sm [overflow-wrap:anywhere]">
                <b className="font-semibold text-ws-pip">Focus from Pip{intent.spec.focusFromRun ? `, after reading run ${intent.spec.focusFromRun}` : ""}:</b> {intent.spec.focus.trim()}
              </p>
            )}
            <p className="m-0 text-sm text-ws-ink3">Runs as you, with your Claude settings, in a new worktree of {intent.spec.clonePath}. {state === "applied" ? "Started: see its run in the steps." : "Read the exact prompt and checks, then start it. Nothing runs before that."}</p>
          </div>
        )}
        {followUp && (
          <div className="grid gap-1.5" data-follow-up>
            <p className="m-0 flex flex-wrap items-baseline gap-2 font-semibold">
              Send the agent back for another pass
              {open && <span className="rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">Pass {pass ?? 2}</span>}
              {p.createdBy === "pip" && <span className="rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">Proposed by Pip</span>}
            </p>
            <p className="m-0 text-sm text-ws-ink2">
              Why: {followUp.reason}
              {onOpenRun && (
                <>
                  {" · "}
                  <button type="button" onClick={() => onOpenRun(followUp.runId)} className="text-ws-pip hover:underline">
                    Open the run
                  </button>
                </>
              )}
            </p>
            <label className="grid gap-1 text-sm font-semibold" htmlFor={`follow-up-${p.id}`}>
              Message the agent will get
              <textarea
                id={`follow-up-${p.id}`}
                value={message}
                disabled={!open || working}
                rows={Math.min(14, Math.max(5, message.split("\n").length + 1))}
                maxLength={FOLLOW_UP_LIMIT}
                onChange={(e) => {
                  messageEdited.current = true;
                  setMessage(e.target.value);
                }}
                className="w-full resize-y rounded-md border border-ws-sep2 bg-ws-win px-2 py-1.5 text-base font-normal [overflow-wrap:anywhere]"
              />
            </label>
            <p className="m-0 text-sm text-ws-ink3">
              {open
                ? "Gossamr puts its standing reminder in front, then resumes the agent in its worktree with this message. Nothing is sent before you press Send back."
                : state === "applied"
                  ? "Sent back."
                  : "Not sent."}
            </p>
          </div>
        )}
        {reply && (
          <div className="grid gap-1.5" data-run-answer>
            <p className="m-0 flex flex-wrap items-baseline gap-2 font-semibold">
              Answer the agent&apos;s question
              {p.createdBy === "pip" && <span className="rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">Suggested by Pip</span>}
            </p>
            {(answer?.question ?? reply.question) && (
              <blockquote data-question className="m-0 rounded-md border-l-2 border-ws-sep2 bg-ws-sel px-2 py-1 text-sm whitespace-pre-wrap text-ws-ink2 [overflow-wrap:anywhere]">
                <b className="font-semibold">{answer?.label ?? "The agent"} asks:</b> {answer?.question ?? reply.question}
              </blockquote>
            )}
            <p className="m-0 text-sm text-ws-ink3">
              The question is the agent&apos;s words.
              {onOpenRun && (
                <>
                  {" "}
                  <button type="button" onClick={() => onOpenRun(reply.runId)} className="text-ws-pip hover:underline">
                    Open the run
                  </button>
                </>
              )}
            </p>
            <label className="grid gap-1 text-sm font-semibold" htmlFor={`run-answer-${p.id}`}>
              Reply the agent will get
              <textarea
                id={`run-answer-${p.id}`}
                value={message}
                disabled={!open || working}
                rows={Math.min(14, Math.max(4, message.split("\n").length + 1))}
                maxLength={MAX_ANSWER}
                aria-keyshortcuts="Meta+Enter Control+Enter"
                onChange={(e) => {
                  messageEdited.current = true;
                  setMessage(e.target.value);
                }}
                onKeyDown={(e) => {
                  // Esc leaves the reply with the edit kept, so the next Esc closes the peek, as its other fields do.
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.currentTarget.blur();
                    return;
                  }
                  if (!isSendKey(e)) return;
                  e.preventDefault();
                  sendAnswer();
                }}
                className="w-full resize-y rounded-md border border-ws-sep2 bg-ws-win px-2 py-1.5 text-base font-normal [overflow-wrap:anywhere]"
              />
            </label>
            <p className="m-0 text-sm text-ws-ink3">
              {open
                ? answer?.waiting === false
                  ? `${NOT_WAITING}. Skip this draft.`
                  : "Gossamr puts its standing reminder in front, then resumes the agent with this reply, as your own answer goes. Nothing is sent before you press Send answer (⌘↵)."
                : state === "applied"
                  ? "Sent."
                  : "Not sent."}
            </p>
          </div>
        )}
        {p.origin.type === "run" && (
          <p data-provenance="run" className="m-0 text-sm text-ws-ink3">
            {p.createdBy === "agent" && (
              <span data-created-by={isReporterQuestions(p) ? "gossamr" : "agent"} className="mr-2 rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">
                {isReporterQuestions(p) ? "Drafted by Gossamr" : "Drafted by an agent"}
              </span>
            )}{" "}
            <FromRun proposal={p} onOpen={onOpenRun ? () => onOpenRun((p.origin as { runId: string }).runId) : undefined} />
            {isReporterQuestions(p) ? ". Gossamr wrote this around the triage's open questions, which are the agent's words. Read and edit them before you approve." : ". The words are the agent's. Read and edit them before you approve."}
          </p>
        )}
        {p.origin.type === "chat" && isReporterQuestions(p) && (
          <p data-provenance="gossamr" className="m-0 text-sm text-ws-ink3">
            <span data-created-by="gossamr" className="mr-2 rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">
              Drafted by Gossamr
            </span>{" "}
            Gossamr wrote this from what the ticket&apos;s description leaves out. Read and edit the questions before you approve.
          </p>
        )}
        {p.origin.type === "chat" && isReporterNudge(p) && (
          <p data-provenance="gossamr" className="m-0 text-sm text-ws-ink3">
            <span data-created-by="gossamr" className="mr-2 rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">
              Drafted by Gossamr
            </span>{" "}
            Gossamr wrote this follow-up because the reporter hasn&apos;t answered for days. Read and edit it before you approve.
          </p>
        )}
        {p.origin.type === "chat" && isAnswersDraft(p) && (
          <p data-provenance="pip" className="m-0 text-sm text-ws-ink3">
            <span data-created-by="pip" className="mr-2 rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">
              Drafted by Pip
            </span>{" "}
            {answersProvenance(replyPrompt, intent.type === "comment" ? body : undefined)}
          </p>
        )}
        {p.state.type === "retired" && <p className="m-0 text-sm text-ws-ink3">{p.state.reason}</p>}
        {open && revision && !shownError && <p className="m-0 text-sm text-ws-ink3">{revision.note}</p>}
        {shownError && (
          <p ref={errorLine} role="alert" className="m-0 text-sm text-ws-blocked">
            {shownError}
          </p>
        )}
        {startsBuild && open && (
          <p data-approval-starts-build className="m-0 text-sm text-ws-ink2">
            {APPROVAL_STARTS_BUILD}{" "}
            <button
              type="button"
              onClick={() => {
                useTabs.getState().setRoute("agents");
                useRuns.getState().openSafety();
              }}
              className="rounded text-ws-ink2 underline hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip"
            >
              Agents settings
            </button>
          </p>
        )}
        {pause && open && <PostingPause risks={pause.risks} quote={pause.quote} subject={edited.current ? "Your edit" : intent.type === "comment" && isAnswersDraft(p) ? "Your reply" : "This draft"} anyway="Post anyway" working={working || state === "applying"} onKeep={keepEditing} onPost={approve} />}
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
                    Discuss with Pip
                  </button>
                )}
                {(intent.type === "comment" || rewrite) && (
                  <button type="button" data-draft-edit disabled={working} onClick={() => setEditing(!editing)} className={button}>
                    {editing ? "Done editing" : "Edit"}
                  </button>
                )}
                <button type="button" disabled={working} onClick={skip} className={button}>
                  Skip
                </button>
                {runDraft && onReview && (
                  <button type="button" disabled={working} onClick={onReview} className={primary}>
                    Review and start
                  </button>
                )}
                {followUp && (
                  <button type="button" disabled={working || state === "applying" || !!messageProblem} title={messageProblem ?? undefined} onClick={() => (onSendBack ? onSendBack(edit(), message.trim()) : onApprove(edit()))} className={`${primary} px-5 py-2 text-base`}>
                    {working || state === "applying" ? "Sending…" : "Send back"}
                  </button>
                )}
                {reply && (
                  <button type="button" disabled={working || state === "applying" || !!replyBlock} title={replyBlock ?? undefined} onClick={sendAnswer} className={`${primary} px-5 py-2 text-base`}>
                    {working || state === "applying" ? "Sending…" : "Send answer"}
                  </button>
                )}
                {/* While the pause shows, its own Post anyway stands in for this button, beside Keep editing. */}
                {!runDraft && !followUp && !reply && !pause && (
                  <button type="button" disabled={working || state === "applying" || (intent.type === "comment" && !body.trim()) || (intent.type === "subtasks" && remaining === 0) || rewriteBlock} onClick={approve} className={primary}>
                    {working || state === "applying" ? "Working…" : action}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {keys.hint && (
        <p role="status" data-key-hint className={`m-0 border-t border-ws-sep px-3 py-1 text-xs ${keys.asking ? "bg-ws-pip-soft font-semibold text-ws-pip" : "bg-ws-bar text-ws-ink3"}`}>
          {keys.hint}
        </p>
      )}
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

  const pass = useRuns((s) => (p.intent.type === "followUp" && p.state.type === "pending" ? nextPass(s.runs.find((r) => r.id === (p.intent as { runId: string }).runId)) : undefined));
  const answer = useAnswerRun(p);
  const discuss = () => p.origin.type === "run" && askPip(pipAsks.comment({ id: p.origin.runId, item: target ?? null }, p.id));
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
      onDiscuss={
        p.origin.type === "run" && p.intent.type === "comment"
          ? discuss
          : review
            ? (edit) =>
                void run(async () => {
                  // The person's edit is saved first, so Pip reads their version, and it is theirs from then on.
                  if (edit && backend) await backend.proposalsEdit(p.id, edit);
                  askPip({ prompt: reviewWithPipPrompt(p), shown: PIP_SHOWN.review });
                  return null;
                })
            : undefined
      }
      pass={pass}
      onSendBack={(edit, message) =>
        void run(async () => {
          if (edit && backend) await backend.proposalsEdit(p.id, edit);
          await useWorkspace.getState().sendFollowUp(p.id, message);
          return null;
        })
      }
      answer={answer}
      onSendAnswer={(edit, message) =>
        void run(async () => {
          if (!backend) return null;
          await editThenSend(p.id, edit, message, { saveEdit: (id, e) => backend.proposalsEdit(id, e), send: (id, m) => useWorkspace.getState().sendAnswerDraft(id, m) });
          return null;
        })
      }
      onReview={p.intent.type === "startRun" ? () => void useRunSetup.getState().begin({ proposalId: p.id }) : undefined}
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
