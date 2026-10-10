import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MentionTextarea } from "../components/MentionTextarea";
import { docText } from "../lib/docs";
import { autoLink, liveMentions, type Mention } from "../lib/mentions";
import { targetOf, unreachable } from "../lib/proposals";
import { useBackend } from "../backend/useBackend";
import type { Person, Proposal, ProposalEdit } from "../types";
import { draftStatus } from "./boardLogic";
import { showMe } from "./jump";
import { KIND_LABEL } from "./agentsLogic";
import { askPip } from "./askPip";
import { commentWithPipPrompt } from "./runSheetLogic";
import { useRunSetup } from "./runSetupStore";
import { useRuns } from "./runsStore";
import { useWorkspace, workflowOfItem } from "../workspaceStore";
import { peekFocusAfterLeaving } from "./peekDrafts";
import { itemKey } from "../lib/filter";
import { FOLLOW_UP_LIMIT, followUpProblem, followUpTitle, nextPass } from "./followUp";
import { RetiredDraft } from "./RetiredDraft";
import { answerProblem, MAX_ANSWER } from "../lib/answer";
import { answerTitle, editThenSend, isSendKey, NOT_WAITING, useAnswerRun, type AnswerRun } from "./runAnswer";
import { bodyChangeSize, RewriteView, rewriteBlocked, rewriteEdit, rewriteFields, rewriteWhat, takesBackendText } from "./RewriteDiff";

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
      return [i.title ? `Title: ${i.title.from} → ${i.title.to}` : null, size ? `Description: ${size.added} added, ${size.removed} removed` : null].filter(Boolean).join("; ");
    }
    case "link":
      return linkSentence(i);
    case "startRun":
      return `${i.spec.kind} in ${i.spec.repo}`;
    case "followUp":
      return i.reason;
    case "runAnswer":
      return i.message.replace(/\s+/g, " ");
    default:
      return unreachable(i);
  }
}

export interface DraftCardProps {
  proposal: Proposal;
  /** The status a transition moves to, by name. */
  statusName: string | null;
  people: Person[];
  working: boolean;
  error: string | null;
  onApprove(edit: ProposalEdit | null): void;
  onSkip(): void;
  /** Opens the setup sheet for a run draft, the one place it is approved. */
  onReview?(): void;
  /** Present when the draft's item may be off screen. */
  onShow?(): void;
  /** Opens the agent run a draft was made from. */
  onOpenRun?(runId: string): void;
  /** Present on a comment made from a run's result: opens Pip on the run and this draft. */
  onDiscuss?(): void;
  /** For a follow-up, the pass the agent would be on once it is sent. */
  pass?: number;
  /** Sends a follow-up back to its run, after saving the edit. */
  onSendBack?(edit: ProposalEdit | null, message: string): void;
  /** For an answer, how the run it answers stands now. */
  answer?: AnswerRun | null;
  /** Sends an answer to its run, after saving the edit. */
  onSendAnswer?(edit: ProposalEdit | null, message: string): void;
}

const button = "rounded-md border border-ws-sep2 px-2.5 py-1 text-sm hover:bg-ws-hover disabled:opacity-45";
const primary = "rounded-md bg-ws-pip px-3.5 py-1.5 text-sm font-semibold text-ws-on-pip shadow-sm hover:brightness-110 disabled:opacity-45";

export function DraftCard(props: DraftCardProps) {
  const p = props.proposal;
  if (p.state.type !== "retired") return <DraftCardBody {...props} />;
  return (
    <RetiredDraft proposal={p} title={draftTitle(p, props.answer?.label)} state={BADGE.retired}>
      <DraftCardBody {...props} />
    </RetiredDraft>
  );
}

function DraftCardBody({ proposal: p, statusName, people, working, error, onApprove, onSkip, onReview, onShow, onOpenRun, onDiscuss, pass, onSendBack, answer, onSendAnswer }: DraftCardProps) {
  const intent = p.intent;
  const key = targetOf(intent)?.key ?? "";
  const stored = intent.type === "comment" ? docText(intent.body) : "";
  const linked = useMemo(() => autoLink(stored, people), [stored, people]);
  const [body, setBody] = useState(linked.text);
  const [mentions, setMentions] = useState<Mention[]>(linked.mentions);
  const [editing, setEditing] = useState(false);
  const edited = useRef(false);
  const rewrite = intent.type === "rewrite" ? intent : null;
  const [newTitle, setNewTitle] = useState(rewriteFields(rewrite).title);
  const [newText, setNewText] = useState(rewriteFields(rewrite).text);
  const rewriteEdited = useRef(false);
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
  const [message, setMessage] = useState(sentMessage);
  const messageEdited = useRef(false);
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
  const [picked, setPicked] = useState<boolean[]>(summaries.map(() => true));
  useEffect(() => setPicked(summaries.map(() => true)), [summaries.join("\n")]);
  // People can arrive after the card first renders; link them unless the text was edited by hand.
  useEffect(() => {
    if (edited.current) return;
    setBody(linked.text);
    setMentions(linked.mentions);
  }, [linked]);

  const state = p.state.type;
  const open = state === "pending" || state === "applying";
  const remaining = summaries.filter((_, i) => i >= made && picked[i]).length;
  const revision = p.revisions[p.revisions.length - 1];
  const shownError = error ?? p.error;

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

  const runDraft = intent.type === "startRun";
  const sendAnswer = () => {
    if (!reply || working || state !== "pending" || replyBlock) return;
    if (onSendAnswer) onSendAnswer(edit(), message.trim());
  };
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
      onFocus={() => (hadFocus.current = true)}
      onBlur={(ev) => {
        if (ev.relatedTarget && !ev.currentTarget.contains(ev.relatedTarget as Node)) hadFocus.current = false;
      }}
      className={`ws-legacy overflow-clip rounded-[10px] border border-dashed border-ws-pip bg-ws-win text-base ${state === "skipped" || state === "retired" ? "opacity-55" : ""}`}
    >
      <div className="flex items-center gap-2 bg-ws-pip-soft px-3 py-1.5 text-sm font-semibold text-ws-pip">
        <span aria-hidden>✦</span>
        {draftTitle(p, answer?.label)}
        <span className="ml-auto font-normal text-ws-ink3">{BADGE[state]}</span>
      </div>
      <div className="grid gap-2 px-3 py-2.5">
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
              className="rounded-md border border-ws-sep2 bg-ws-win"
            />
          ) : (
            <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{body}</p>
          ))}
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
          />
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
                Follows the {intent.spec.planApproved ? "" : "unedited "}plan from run <b className="font-mono font-semibold">{intent.spec.planFromRun}</b> ({intent.spec.plan.length.toLocaleString("en")} characters, shown whole in the prompt).
              </p>
            )}
            {intent.spec.buildAccount?.trim() && intent.spec.buildFromRun && (
              <p data-build-from className="m-0 text-sm text-ws-ink2">
                Checks the builder&apos;s account from run <b className="font-mono font-semibold">{intent.spec.buildFromRun}</b> ({intent.spec.buildAccount.length.toLocaleString("en")} characters, shown whole in the prompt) as a claim, not as evidence.
              </p>
            )}
            {intent.spec.focus?.trim() && (
              <p className="m-0 rounded-md border border-dashed border-ws-pip bg-ws-pip-soft px-2 py-1 text-sm [overflow-wrap:anywhere]">
                <b className="font-semibold text-ws-pip">Focus from Pip{intent.spec.focusFromRun ? `, after reading run ${intent.spec.focusFromRun}` : ""}:</b> {intent.spec.focus.trim()}
              </p>
            )}
            <p className="m-0 text-sm text-ws-ink3">Runs as you, with your Claude settings, in a new worktree of {intent.spec.clonePath}. Read the exact prompt and checks, then start it. Nothing runs before that.</p>
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
              <span data-created-by="agent" className="mr-2 rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">
                Drafted by an agent
              </span>
            )}
            From agent run{" "}
            {onOpenRun ? (
              <button type="button" onClick={() => onOpenRun((p.origin as { runId: string }).runId)} className="font-mono font-semibold text-ws-pip hover:underline">
                {p.origin.shortId ?? "(no session id)"}
              </button>
            ) : (
              <b className="font-mono">{p.origin.shortId ?? "(no session id)"}</b>
            )}
            . The words are the agent&apos;s. Read and edit them before you approve.
          </p>
        )}
        {p.state.type === "retired" && <p className="m-0 text-sm text-ws-ink3">{p.state.reason}</p>}
        {open && revision && !shownError && <p className="m-0 text-sm text-ws-ink3">{revision.note}</p>}
        {shownError && (
          <p role="alert" className="m-0 text-sm text-ws-blocked">
            {shownError}
          </p>
        )}
        {(open || onShow) && (
          <div className="sticky bottom-0 z-[1] -mx-3 -mb-2.5 flex flex-wrap items-center justify-end gap-2 border-t border-ws-sep bg-ws-win px-3 py-2">
            {onShow && (
              <button type="button" onClick={onShow} className="mr-auto text-sm text-ws-pip hover:underline">
                Show me
              </button>
            )}
            {open && (
              <>
                {onDiscuss && (
                  <button type="button" disabled={working} onClick={onDiscuss} title="Pip reads the whole run and this draft, and changes the draft if you ask" className={button}>
                    Discuss with Pip
                  </button>
                )}
                {(intent.type === "comment" || rewrite) && (
                  <button type="button" disabled={working} onClick={() => setEditing(!editing)} className={button}>
                    {editing ? "Done editing" : "Edit"}
                  </button>
                )}
                <button type="button" disabled={working} onClick={onSkip} className={button}>
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
                {!runDraft && !followUp && !reply && (
                  <button
                    type="button"
                    disabled={working || state === "applying" || (intent.type === "comment" && !body.trim()) || (intent.type === "subtasks" && remaining === 0) || rewriteBlock}
                    onClick={() => onApprove(edit())}
                    className={primary}
                  >
                    {working || state === "applying" ? "Working…" : action}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/** A draft card wired to the workspace: approving or skipping goes through the store, and edits are saved first. */
export function LiveDraftCard({ proposal: p, jump = true }: { proposal: Proposal; jump?: boolean }) {
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
  const discuss = () => p.origin.type === "run" && askPip(commentWithPipPrompt({ id: p.origin.runId, item: target ?? null }, p.id));

  return (
    <DraftCard
      proposal={p}
      statusName={statusName}
      people={people}
      working={working}
      error={error}
      onShow={jump && target && item ? () => showMe(target) : undefined}
      onSkip={() => void run(() => useWorkspace.getState().skip(p.id))}
      onOpenRun={(id) => useRuns.getState().openRun(id)}
      onDiscuss={p.origin.type === "run" && p.intent.type === "comment" ? discuss : undefined}
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
      onApprove={(edit) =>
        void run(async () => {
          if (edit && backend) await backend.proposalsEdit(p.id, edit);
          return useWorkspace.getState().approve(p.id);
        })
      }
    />
  );
}
