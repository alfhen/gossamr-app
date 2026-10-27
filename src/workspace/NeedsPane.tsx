import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { higherPriority, needAfter, leftOutLabel, needGroups, repeatedComments, REPEATED_COMMENT_NOTE, type Need } from "../lib/needs";
import { type Proposal, type Run, type WorkstreamView } from "../types";
import { rewriteWhat } from "./RewriteDiff";
import { useWorkspace } from "../workspaceStore";
import { OpenInTerminal, FailureNext } from "./AgentParts";
import { Box, BoxTitle, Btn } from "./AgentSheet";
import { planOpenQuestions } from "./agentsLogic";
import { draftSummary, draftTitle, LiveDraftCard, useEditedDraft } from "./DraftCard";
import { failureAction } from "./failureActions";
import { failureHelp } from "./failureHelp";
import { GroupBatch, GroupChip } from "./NeedsYou";
import { groupId, openNeed, openPipAsk, setPaneIntent, takePaneIntent } from "./needsActions";
import { chipLabel, editedTitle } from "../lib/needs";
import { PermissionAsk } from "./PermissionAsk";
import { useWorkView } from "./workViewStore";
import { RunAnswer } from "./RunAnswer";
import { SignInBox } from "./RunSheet";
import { useRuns } from "./runsStore";
import { BatchConfirm, PlanApproval, confirmBatch, planResultFor } from "./StepRail";
import { batchLabel, EDITED_ASIDE, editedPending, freezeBatch, type BatchSnapshot } from "./workViewLogic";
import { speakQuietToasts, useToasts } from "./toasts";
import { controlActions, PausedBanner } from "./WorkstreamControls";
import { useWorkstreams } from "./workstreamsStore";

const STACK = "[data-workstream-needs]";

/** The header of `need` in its workstream's Needs you stack. */
function rowFor(need: Need): HTMLElement | null {
  return document.querySelector<HTMLElement>(`${STACK} [data-need-key="${CSS.escape(need.key)}"]`);
}

/** Where Esc from a decision puts the keyboard: what opened it while that is still on the page and outside the pane, else the need's own header. */
export function closeTarget(opener: HTMLElement | null, pane: Pick<Node, "contains"> | null, row: () => HTMLElement | null): HTMLElement | null {
  if (opener && opener.tagName !== "BODY" && opener.isConnected && !pane?.contains(opener)) return opener;
  return row();
}

/**
 * Where the keyboard goes once a need is dealt with: the next need of the same workstream, in rank order, opens in its
 * stack when the stack was on the one dealt with. With none left it lands on the stack's heading and a toast says what was done.
 */
function useAdvance(all: readonly Need[], workstreamId: string | null, onAdvance: (done: Need, next: Need) => void, onLast: (done: Need) => void) {
  const needs = useMemo(() => all.filter((n) => n.workstreamId === workstreamId), [all, workstreamId]);
  const previous = useRef<string[]>([]);
  const earlier = useRef<readonly Need[]>([]);
  const focused = useRef<string | null>(null);
  useEffect(() => {
    const onFocus = (ev: FocusEvent) => {
      const row = ev.target instanceof Element ? ev.target.closest("[data-need-key]") : null;
      // Focus anywhere else lets go of the row: what happens to a need then is not the keyboard's business here.
      focused.current = row ? row.getAttribute("data-need-key") : null;
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);
  useEffect(() => {
    const keys = needs.map((n) => n.key);
    const before = previous.current;
    const was = earlier.current;
    previous.current = keys;
    earlier.current = needs;
    const home = useWorkView.getState();
    const deciding = home.deciding;
    const lands = (next: Need | null) => requestAnimationFrame(() => (next ? rowFor(next) : (document.querySelector<HTMLElement>("[data-workstream-needs-title]") ?? document.getElementById("workstream-sheet")))?.focus());
    if (deciding && before.includes(deciding) && !keys.includes(deciding)) {
      const next = needAfter(before, deciding, needs);
      if (next) {
        // The line says what was done and what is now open; the new pane's heading takes the keyboard, so no key lands on a button by accident.
        const done = was.find((n) => n.key === deciding);
        if (done) onAdvance(done, next);
        setPaneIntent("card");
        home.decide(next.key);
      } else {
        // Nothing comes next, so no pane line says what was done: it is said where a screen reader hears it (G6).
        const done = was.find((n) => n.key === deciding);
        if (done) onLast(done);
        home.closeDecision();
        lands(null);
      }
      return;
    }
    const watched = focused.current;
    if (watched && before.includes(watched) && !keys.includes(watched)) {
      focused.current = null;
      const at = document.activeElement;
      // Focus that is somewhere that still works stays.
      if (at && at !== document.body && at.isConnected) return;
      lands(needAfter(before, watched, needs));
    }
  }, [needs]);
}

/** The line over the pane once it moved on by itself: what was dealt with, and what is open now. */
export const advancedText = (done: Pick<Need, "title" | "ticketKey" | "workstreamTitle">, next: Pick<Need, "title" | "ticketKey">, posted: boolean | string = false, skipped = false) =>
  `${doneText(done, posted, skipped)} Now: ${next.ticketKey ? `${next.ticketKey} · ` : ""}${next.title}`;

/** Whether the need was a draft the person skipped, so the line says "Skipped" and not "Done". */
export const skippedDraft = (done: Pick<Need, "target">, proposals: Readonly<Record<string, Proposal>>) => done.target.type === "draft" && proposals[done.target.id]?.state.type === "skipped";

/**
 * The note for the last need decided from the pane, or null when its draft went without being posted: a Skip says so in
 * its own Undo note, and "Done:" would claim it was dealt with.
 */
export function lastNeedText(done: Need, proposals: Readonly<Record<string, Proposal>>): string | null {
  if (done.target.type === "draft") {
    const state = proposals[done.target.id]?.state.type;
    if (state !== "applied" && state !== "applying") return null;
  }
  return doneText(done, postedFor(done, proposals));
}

/** What was done and in which workstream: "Done: Draft comment on CA-408." The pane moved on, so the line is what says where it happened. */
export const doneText = (done: Pick<Need, "title" | "ticketKey" | "workstreamTitle">, posted: boolean | string = false, skipped = false) => {
  // A posted description change or set of subtasks says what Jira got, not the title of the card it was decided on (G7).
  if (typeof posted === "string") return posted;
  // A skipped draft was not dealt with: the line says so, and it is the one thing a screen reader hears of the skip (G6).
  const said = skipped ? "Skipped" : posted ? "Posted to Jira" : "Done";
  const where = done.ticketKey ?? done.workstreamTitle;
  // A title that already names the ticket is not repeated, and a question is not quoted as if it were what was done.
  const key = done.ticketKey;
  // The title names the ticket only when the key ends there: CA-40 is not the start of "CA-408: …".
  if (key && done.title.startsWith(key) && (done.title.length === key.length || /^[\s:·-]/.test(done.title.slice(key.length)))) {
    const rest = done.title.slice(key.length).replace(/^\s+/, "").replace(/^[:·-]\s*/, "");
    if (rest.endsWith("?")) return `${said}: decided "${rest}" on ${key}.`;
    return `${said}: ${done.title}.`;
  }
  return `${said}: ${done.title}${where ? ` on ${where}` : ""}.`;
};

const JIRA_WRITES: ReadonlySet<string> = new Set(["comment", "rewrite", "transition", "subtasks", "create", "link"]);

/** Whether `done` was a draft that is applied (or applying) and writes to Jira, so the line says it was posted there, not just done. */
export function postedToJira(done: Pick<Need, "target">, proposals: Readonly<Record<string, Proposal>>): boolean {
  const p = done.target.type === "draft" ? proposals[done.target.id] : undefined;
  return !!p && JIRA_WRITES.has(p.intent.type) && (p.state.type === "applied" || p.state.type === "applying");
}

/** What Jira got, in words, when `done` was a description change or subtasks that were posted; null for a comment or anything else, whose Done line names the card. */
export function postedWhat(done: Pick<Need, "target">, proposals: Readonly<Record<string, Proposal>>): string | null {
  const p = done.target.type === "draft" ? proposals[done.target.id] : undefined;
  // Only a posted draft says what Jira got: one still applying has not created or changed anything yet.
  if (!p || !JIRA_WRITES.has(p.intent.type) || p.state.type !== "applied") return null;
  const { intent } = p;
  if (intent.type === "rewrite") return `Updated the ${rewriteWhat(intent)} of ${intent.item.key} in Jira.`;
  if (intent.type === "subtasks") return `Created ${intent.summaries.length} subtask${intent.summaries.length === 1 ? "" : "s"} on ${intent.parent.key} in Jira.`;
  return null;
}

/** What `doneText` takes for `posted`: the words for a description change or subtasks, else whether it was posted at all. */
export const postedFor = (done: Pick<Need, "target">, proposals: Readonly<Record<string, Proposal>>): boolean | string => postedWhat(done, proposals) ?? postedToJira(done, proposals);

/** The line with an id of its own: two advances with the same words (drafts with one title) are still two, so the line shows again and its timer restarts. */
export interface Advanced {
  id: number;
  text: string;
  /** The workstream the done need was in, which the line's `Done: …` part opens; absent for a need outside any (General). */
  back?: { workstreamId: string; label: string };
  /** The key of the need that was done: when Undo brings it back the line is stale. */
  doneKey?: string;
  /** The key of the need the pane moved on to: opening another one makes the line stale. */
  nextKey?: string;
}

/** The line for a new advance after `previous`, whose id is never the same. */
export const nextAdvanced = (previous: Advanced | null, text: string, back?: Advanced["back"], doneKey?: string, nextKey?: string): Advanced => ({
  id: (previous?.id ?? 0) + 1,
  text,
  ...(back ? { back } : {}),
  ...(doneKey ? { doneKey } : {}),
  ...(nextKey ? { nextKey } : {}),
});

/** Whether the line is stale: the person opened another need than the one it says is open now. */
export const advancedStale = (advanced: Advanced | null, deciding: string | null): boolean => !!advanced?.nextKey && deciding !== advanced.nextKey;

/** Whether the line is stale because the need it says was done is back in `needs` (Undo brought it back). */
export const advancedUndone = (advanced: Advanced | null, needs: readonly Pick<Need, "key">[]): boolean => !!advanced?.doneKey && needs.some((n) => n.key === advanced.doneKey);

/** How long the line saying the pane moved on stays. */
export const ADVANCED_MS = 5000;

/**
 * The slim bar's owner. Its snapshot of the needs' keys as they were when `need` was opened (so a need that came in since can
 * be told from one that was already there) is state, not a ref written in render: a discarded render drops it, so a new need
 * is never marked seen by mistake. The pane keys it by the open need, so each decision takes its own snapshot.
 */
export function HigherPriority({ needs, need }: { needs: readonly Need[]; need: Need }) {
  const [seen] = useState<ReadonlySet<string>>(() => new Set(needs.map((n) => n.key)));
  const higher = higherPriority(needs, need.key, seen);
  return higher ? <HigherPriorityBar need={higher} /> : null;
}

/** A need's title as the person has it: a draft they edited and have not posted titles by its words as edited, as its row in Needs you does, and says so. */
export function useNeedTitle(need: Need): { title: string; edited: boolean } {
  const { edited, text } = useEditedDraft(need.target.type === "draft" ? need.target.id : "");
  return { title: editedTitle(need.title, text), edited };
}

/** The slim bar over the pane: a higher-ranked Decide or Unblock came in while another is open. It opens that need when pressed (Enter too); nothing switches by itself. */
function HigherPriorityBar({ need }: { need: Need }) {
  const { title } = useNeedTitle(need);
  return (
    <button
      type="button"
      data-needs-higher={need.key}
      onClick={() => openNeed(need)}
      className="flex w-full min-w-0 shrink-0 items-center gap-1.5 border-b border-ws-sep bg-ws-pip-soft px-3 py-1 text-left text-sm text-ws-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ws-pip"
    >
      <b className="shrink-0 font-semibold">Higher priority:</b>
      <span className="min-w-0 truncate">{title}</span>
      <span className="shrink-0 font-semibold text-ws-accent">· Open</span>
    </button>
  );
}

/** Where the keyboard lands when a decision is reached by F6 as well as by Enter on its row: the pane's heading, so a screen reader hears what is open and Tab goes on to the decision. The pane itself when it has none. */
export const paneStop = (pane: HTMLElement): HTMLElement => pane.querySelector<HTMLElement>("[data-needs-pane-title]") ?? pane;

/** The first thing the person decides with in the pane: a permission's buttons, an answer box, a draft's main button, else the first button. */
export function firstDecision(root: HTMLElement): HTMLElement | null {
  const body = '[data-needs-pane-body]';
  const decisions = root.querySelector<HTMLElement>(`${body} [data-permission-decisions] button:not(:disabled)`);
  if (decisions) return decisions;
  const answer = root.querySelector<HTMLElement>(`${body} textarea:not(:disabled)`);
  if (answer) return answer;
  // A draft: its card, not its post button, so that approving is the key's a and then Enter, never a second Enter by accident.
  const card = root.querySelector<HTMLElement>(`${body} [data-draft][tabindex="0"]`);
  if (card) return card;
  const draft = Array.from(root.querySelectorAll<HTMLElement>(`${body} [data-draft-actions] button:not(:disabled)`)).pop();
  if (draft) return draft;
  return root.querySelector<HTMLElement>(`${body} button:not(:disabled), ${body} input:not(:disabled)`);
}

/** The box an edit is typed in: a draft's text, or a rewrite's title (an input with no type). */
export const EDIT_FIELD = "[data-needs-pane-body] textarea, [data-needs-pane-body] input:not([type]), [data-needs-pane-body] input[type=text]";

/** A draft card's button that ends its edit, if the pane holds a card being edited. */
const doneEditing = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLButtonElement>("[data-needs-pane-body] button")).find((b) => b.textContent?.trim() === "Done editing" && !b.disabled);

/** Esc in the pane while a card is being edited ends the edit (keeping what was typed) instead of closing the decision; false when none is. */
export function endEditing(root: ParentNode): boolean {
  const done = doneEditing(root);
  done?.click();
  return !!done;
}

function PermissionBody({ run }: { run: Run }) {
  const store = useRuns.getState();
  return <PermissionAsk run={run} onAttach={() => void store.attach(run.id)} />;
}

function AnswerBody({ run }: { run: Run }) {
  const answering = useRuns((s) => s.answering.has(run.id));
  const store = useRuns.getState();
  return <RunAnswer key={run.id} run={run} answering={answering} on={{ answer: (text) => store.answer(run.id, text), attach: () => void store.attach(run.id) }} />;
}

function Dismiss({ run }: { run: Run }) {
  return (
    <Btn tone="plain" icon="x" onClick={() => useRuns.getState().dismiss(run.id)} title="Takes it out of Needs you. The run stays in Agents.">
      Dismiss
    </Btn>
  );
}

function FailureBody({ run }: { run: Run }) {
  const opened = useRuns((s) => s.terminalOpened.has(run.id));
  const help = failureHelp(run);
  const store = useRuns.getState();
  return (
    <Box tone="failed" label="Failure">
      <BoxTitle icon="alert" tone="failed">
        {run.shortId ? "The run stopped without finishing" : "It didn't start"}
      </BoxTitle>
      {help ? (
        <>
          <p className="m-0 font-semibold text-ws-ink">{help.summary}</p>
          <p className="m-0 text-ws-ink2">{help.detail}</p>
          <FailureNext run={run} failure={{ opened, on: { act: (act) => failureAction(run.id, act), retry: () => void store.retryLaunch(run.id), copied: () => store.noteCopied(run.id) } }} />
        </>
      ) : (
        <pre className="selectable m-0 font-mono text-sm leading-normal break-words whitespace-pre-wrap text-ws-ink2">{run.error?.trim() || "No reason was recorded."}</pre>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!help && !run.shortId && (
          <Btn tone="primary" icon="retry" onClick={() => void store.retryLaunch(run.id)}>
            Retry launch
          </Btn>
        )}
        {!help && !!run.shortId && <OpenInTerminal run={run} onOpen={() => void store.attach(run.id)} />}
        <Dismiss run={run} />
      </div>
    </Box>
  );
}

function DraftBody({ need, proposal: p }: { need: Need; proposal: Proposal }) {
  const runs = useRuns((s) => s.runs);
  return (
    <div className="grid gap-2">
      {need.kind === "plan" && <PlanApproval questions={planOpenQuestions(planResultFor(p, runs, undefined))} />}
      <LiveDraftCard proposal={p} jump={false} headingLevel={3} />
    </div>
  );
}

/** The question Pip asked, with the way to answer it where it was asked, or to dismiss it. */
function PipAskBody({ need, view }: { need: Need; view: WorkstreamView }) {
  return (
    <Box tone="needs" label="Pip asks you">
      <BoxTitle icon="spark" tone="needs">
        Pip asks you
      </BoxTitle>
      <p data-pip-ask className="selectable m-0 whitespace-pre-wrap text-ws-ink [overflow-wrap:anywhere]">
        {view.pipAsk?.question}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Btn tone="primary" icon="spark" onClick={() => openPipAsk(need)}>
          Answer in Pip
        </Btn>
        <Btn tone="plain" icon="x" onClick={() => void useWorkstreams.getState().dismissAsk(view.workstream.id)} title="Takes it out of Needs you. Pip carries on without an answer.">
          Dismiss
        </Btn>
      </div>
    </Box>
  );
}

/** Which of the existing decision components `need` is decided with. */
function Decision({ need }: { need: Need }) {
  const run = useRuns((s) => (need.runId ? s.runs.find((r) => r.id === need.runId) : undefined));
  const view = useWorkstreams((s) => (need.workstreamId ? s.list.find((v) => v.workstream.id === need.workstreamId) : undefined));
  const proposal = useWorkspace((s) => (need.target.type === "draft" ? s.proposals[need.target.id] : undefined));
  switch (need.kind) {
    case "permission":
      return run ? <PermissionBody run={run} /> : null;
    case "question":
      return run ? <AnswerBody run={run} /> : null;
    case "pipAsk":
      return view?.pipAsk ? <PipAskBody need={need} view={view} /> : null;
    case "signIn":
      return run ? <SignInBox run={run} onAttach={() => void useRuns.getState().attach(run.id)} /> : null;
    case "failure":
      return run ? <FailureBody run={run} /> : null;
    case "paused":
      return view ? <PausedBanner view={view} actions={controlActions(view.workstream.id)} /> : null;
    case "plan":
    case "description":
    case "draft":
    case "review":
      return proposal ? <DraftBody need={need} proposal={proposal} /> : null;
  }
}

/** One need in its workstream's stack: what is asked and why, always shown; what waiting does and the decision once it is open. */
function NeedItem({ need, open }: { need: Need; open: boolean }) {
  const root = useRef<HTMLElement>(null);
  const focusRev = useWorkView((s) => s.focusRev);
  const close = () => {
    useWorkView.getState().closeDecision();
    requestAnimationFrame(() => rowFor(need)?.focus());
  };
  const openIt = () => (setPaneIntent("card"), useWorkView.getState().decide(need.key));
  // Opened by a key or a link, the keyboard goes to the heading, whatever kind of need it is, so a screen reader hears what was opened and Tab reaches the decision; "e" opens an edit where the card has one. Opened by the stack's own default or a click, it stays where it is.
  useEffect(() => {
    if (!open) return;
    const intent = takePaneIntent();
    if (!intent) return;
    let frame = 0;
    let tries = 0;
    let clicked = false;
    const go = () => {
      const el = root.current;
      if (!el) return;
      // It is brought into view as it takes the keyboard.
      el.scrollIntoView?.({ block: "nearest" });
      if (intent !== "edit") {
        paneStop(el).focus({ preventScroll: true });
        return;
      }
      if (intent === "edit") {
        const edit = clicked ? undefined : Array.from(el.querySelectorAll<HTMLButtonElement>("[data-needs-pane-body] button")).find((b) => b.textContent?.trim() === "Edit" && !b.disabled);
        if (edit) {
          edit.click();
          clicked = true;
        }
        // The field only exists once the edit has rendered, which may be a few frames on.
        if (clicked) {
          const field = el.querySelector<HTMLElement>(EDIT_FIELD);
          if (field) return void field.focus({ preventScroll: true });
          if (++tries < 60) frame = requestAnimationFrame(go);
          else firstDecision(el)?.focus({ preventScroll: true });
          return;
        }
      }
      const target = firstDecision(el);
      if (target) {
        target.focus({ preventScroll: true });
        target.scrollIntoView?.({ block: "nearest" });
        return;
      }
      if (++tries < 60) frame = requestAnimationFrame(go);
      else el.focus({ preventScroll: true });
    };
    go();
    return () => cancelAnimationFrame(frame);
  }, [open, focusRev]);
  const onKeyDown = (ev: KeyboardEvent<HTMLElement>) => {
    if (!open || ev.key !== "Escape" || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target as HTMLElement;
    // A confirmation that takes Esc itself keeps it.
    if (target.closest("[data-esc-local]")) return;
    ev.preventDefault();
    // In a field, Esc leaves the field first, so a half-written answer is not lost to a second key.
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return void root.current?.focus();
    // A card being edited ends its edit first: closing the decision would drop what was typed.
    if (root.current && endEditing(root.current)) return void root.current.focus({ preventScroll: true });
    close();
  };
  const paneTitle = useNeedTitle(need);
  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label={`Needs you: ${paneTitle.title}`}
      data-needs-pane={need.key}
      data-open={open || undefined}
      data-kind={need.kind}
      data-group={need.group}
      onKeyDown={onKeyDown}
      // A draft's action bar stays where its card ends: a sticky one would float over the text and the review comments beneath it.
      className="grid content-start gap-2 rounded-lg border border-ws-sep bg-ws-bar px-3 py-2 outline-none [&_[data-draft-actions]]:static [&_[data-diff]]:max-h-[min(50vh,28rem)] [&_[data-diff]]:overflow-y-auto"
    >
      {/* Pressing anywhere on a closed need opens it; the button is the same for the keyboard. */}
      <header data-need-row={need.key} data-kind={need.kind} data-group={need.group} onClick={open ? undefined : openIt} className={`flex items-start gap-2 ${open ? "" : "cursor-pointer"}`}>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-ws-ink3">
            {need.head && (
              <b data-needs-pane-head className="min-w-0 truncate font-semibold text-ws-ink">
                {need.head}
              </b>
            )}
            <GroupChip group={need.group} label={chipLabel(need)} />
            <span data-needs-pane-title data-needs-you-need-title title={paneTitle.title} role="heading" aria-level={3} tabIndex={-1} className="line-clamp-2 min-w-0 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip">
              {paneTitle.title}
            </span>
            {paneTitle.edited && (
              <span data-needs-pane-edited className="shrink-0 font-semibold text-ws-pip">
                edited
              </span>
            )}
          </div>
          <p data-needs-why className="m-0 text-sm font-semibold text-ws-ink [overflow-wrap:anywhere]">
            {need.why}
          </p>
          {open && (
            <p data-needs-if-you-wait className="m-0 text-sm text-ws-ink2 [overflow-wrap:anywhere]">
              <span className="font-semibold">If you wait:</span> {need.ifYouWait}
            </p>
          )}
        </div>
        <button
          type="button"
          data-need-key={need.key}
          aria-expanded={open}
          onClick={(ev) => (ev.stopPropagation(), open ? close() : openIt())}
          className="shrink-0 rounded px-2 py-px text-sm font-semibold text-ws-accent hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
        >
          {open ? "Hide" : "Decide"}
        </button>
      </header>
      {open && (
        <div data-needs-pane-body className="grid gap-2">
          <Decision need={need} />
        </div>
      )}
    </section>
  );
}

/**
 * The combined preview of a group's safe drafts, open in the pane like any decision: what each would do, fixed as it was
 * when the pane opened, then the one confirm (`BatchConfirm`). Cancel, Esc and × keep every draft as it is.
 */
function BatchDecision({ gid, needs }: { gid: string; needs: readonly Need[] }) {
  const proposals = useWorkspace((s) => s.proposals);
  const group = needGroups(needs).find((g) => groupId(g.workstreamId) === gid);
  // The drafts and what the preview covers are those of the moment it opened.
  const [ids] = useState(() => (group?.safeBatch ?? []).flatMap((n) => (n.target.type === "draft" ? [n.target.id] : [])));
  const drafts = ids.flatMap((id) => (proposals[id] ? [proposals[id]] : []));
  const [frozen, setFrozen] = useState<BatchSnapshot | null>(() => {
    const snap = freezeBatch(drafts);
    return snap.length >= 2 ? snap : null;
  });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; failed: boolean } | null>(null);
  // Comments with the text of an earlier one in the group are not in the batch; the confirm says so.
  const [leftOut] = useState(() => repeatedComments([group?.top, ...(group?.rest ?? [])].flatMap((n) => (n?.target.type === "draft" && proposals[n.target.id] ? [proposals[n.target.id]] : [])).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1))));
  const [title] = useState(() => group?.ticketKey ?? group?.title ?? "No workstream");
  const root = useRef<HTMLElement>(null);
  const close = () => {
    useWorkView.getState().closeDecision();
    requestAnimationFrame(() => (document.querySelector<HTMLElement>("[data-workstream-needs-title]") ?? document.getElementById("workstream-sheet"))?.focus());
  };
  const confirm = async (covered: BatchSnapshot) => {
    setFrozen(null);
    setBusy(true);
    // The drafts as they are when Yes is pressed, not as the pane last drew them.
    const now = useWorkspace.getState().proposals;
    const done = await confirmBatch(covered, ids.flatMap((id) => (now[id] ? [now[id]] : [])), (id) => useWorkspace.getState().approve(id));
    setBusy(false);
    setOutcome(done);
    // The drafts leave Needs you as they are approved.
    useToasts.getState().push(done.text, done.failed ? "error" : "info");
    requestAnimationFrame(() => root.current?.focus({ preventScroll: true }));
  };
  const onKeyDown = (ev: KeyboardEvent<HTMLElement>) => {
    if (ev.key !== "Escape" || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if ((ev.target as HTMLElement).closest("[data-esc-local]")) return;
    ev.preventDefault();
    close();
  };
  const count = frozen?.length ?? ids.length;
  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label="Decision"
      data-needs-pane={`batch:${gid}`}
      data-open
      data-kind="batch"
      data-group="approve"
      onKeyDown={onKeyDown}
      className="grid content-start gap-2 rounded-lg border border-ws-sep bg-ws-bar px-3 py-2 outline-none"
    >
      <header className="flex items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-ws-ink3">
            <b data-needs-pane-head className="min-w-0 truncate font-semibold text-ws-ink">
              {title}
            </b>
            <GroupChip group="approve" />
            <span data-needs-pane-title role="heading" aria-level={2} tabIndex={-1} className="min-w-0 truncate rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip">
              {batchLabel(count)}
            </span>
          </div>
          <p data-needs-why className="m-0 text-sm font-semibold text-ws-ink [overflow-wrap:anywhere]">
            These drafts may go together. Each is written to Jira as its card shows it.
          </p>
          <p data-needs-if-you-wait className="m-0 text-sm text-ws-ink2 [overflow-wrap:anywhere]">
            <span className="font-semibold">If you wait:</span> Nothing is posted until you choose.
          </p>
        </div>
        <button
          type="button"
          aria-label="Back to the list"
          title="Back to the list (Esc)"
          onClick={close}
          className="shrink-0 rounded px-1.5 text-ws-ink3 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
        >
          ×
        </button>
      </header>
      <div data-needs-pane-body className="grid gap-2">
        {frozen && (
          <>
            <ul data-needs-you-batch-preview aria-label="What approving these does" className="m-0 grid list-none gap-1 p-0 text-sm text-ws-ink2">
              {drafts
                .filter((p) => frozen.some((f) => f.id === p.id))
                .map((p) => (
                  <li key={p.id} className="[overflow-wrap:anywhere]">
                    <b className="font-semibold text-ws-ink">{draftTitle(p)}</b> · <span>{draftSummary(p, null)}</span>
                  </li>
                ))}
            </ul>
            {leftOut.length > 0 && (
              <p data-batch-left-out className="m-0 text-sm text-ws-ink2 [overflow-wrap:anywhere]">
                {REPEATED_COMMENT_NOTE}: {leftOut.map((p) => leftOutLabel(p, draftTitle(p))).join(", ")}.
              </p>
            )}
            {editedPending(drafts).length > 0 && (
              <p data-batch-left-out="edited" className="m-0 text-sm text-ws-ink2 [overflow-wrap:anywhere]">
                {EDITED_ASIDE}
              </p>
            )}
            <BatchConfirm count={frozen.length} onConfirm={() => void confirm(frozen)} onCancel={close} />
          </>
        )}
        {busy && <p className="m-0 text-sm text-ws-ink2">Approving…</p>}
        {!frozen && !busy && !outcome && <p className="m-0 text-sm text-ws-ink2">These drafts are no longer waiting together.</p>}
        {outcome && (
          <p role="status" data-batch-outcome className={`m-0 text-sm [overflow-wrap:anywhere] ${outcome.failed ? "text-ws-blocked" : "text-ws-ink2"}`}>
            {outcome.text}
          </p>
        )}
      </div>
    </section>
  );
}


/**
 * A workstream's decisions, at the top of its detail under "Needs you": one item for each need it holds, most urgent first,
 * the one in `deciding` open (the top one until another is chosen), or a "Approve N safe drafts" preview (`batch`). They are
 * decided with the same components the cards and the run sheet use; once one is dealt with the next opens in its place.
 * `workstreamId` null is the runs and drafts that belong to no workstream.
 */
export function WorkstreamNeeds({ needs, workstreamId }: { needs: readonly Need[]; workstreamId: string | null }) {
  const deciding = useWorkView((s) => s.deciding);
  const batch = useWorkView((s) => s.batch);
  const paneRev = useWorkView((s) => s.paneRev);
  const ranked = useMemo(() => needs.filter((n) => n.workstreamId === workstreamId), [needs, workstreamId]);
  // A need's age changing as it is acted on must not move it: a reordered DOM node loses the keyboard. The order is the rank's while the set of needs is the same, and re-read when it changes.
  const order = useRef<{ set: string; keys: string[] }>({ set: "", keys: [] });
  const mine = useMemo(() => {
    const set = [...ranked.map((n) => n.key)].sort().join("\n");
    if (order.current.set !== set) order.current = { set, keys: ranked.map((n) => n.key) };
    const byKey = new Map(ranked.map((n) => [n.key, n]));
    return order.current.keys.map((k) => byKey.get(k)!);
  }, [ranked]);
  const [advanced, setAdvanced] = useState<Advanced | null>(null);
  const lastId = useRef(0);
  useAdvance(
    needs,
    workstreamId,
    (done, next) => {
      const proposals = useWorkspace.getState().proposals;
      const posted = postedFor(done, proposals);
      const skipped = skippedDraft(done, proposals);
      setAdvanced((prev) => nextAdvanced(prev ?? { id: lastId.current, text: "" }, advancedText(done, next, posted, skipped), undefined, done.key, next.key));
    },
    (done) => {
      const proposals = useWorkspace.getState().proposals;
      const text = lastNeedText(done, proposals);
      // No line follows the last need, so a skip's toast is the one place it is said (G6).
      if (!text) return skippedDraft(done, proposals) ? speakQuietToasts() : undefined;
      useToasts.getState().push(text, "info");
    },
  );
  useEffect(() => {
    if (advancedUndone(advanced, mine) || advancedStale(advanced, deciding)) setAdvanced(null);
  }, [advanced, mine, deciding]);
  useEffect(() => {
    if (!advanced) return;
    lastId.current = advanced.id;
    const timer = setTimeout(() => setAdvanced(null), ADVANCED_MS);
    return () => clearTimeout(timer);
  }, [advanced]);

  // The most urgent need is open when the detail opens, unless something already chose one of these.
  const keys = useRef<string[]>([]);
  keys.current = mine.map((n) => n.key);
  useEffect(() => {
    const view = useWorkView.getState();
    if (keys.current.length && view.batch === null && !(view.deciding && keys.current.includes(view.deciding))) view.expandNeed(keys.current[0]);
  }, []);

  const gid = groupId(workstreamId);
  const group = useMemo(() => needGroups(mine)[0], [mine]);
  const showBatch = batch === gid;
  if (!mine.length && !showBatch) return null;
  return (
    <section data-workstream-needs={gid} aria-label="Needs you" className="grid gap-2">
      <h3 data-workstream-needs-title tabIndex={-1} className="m-0 flex items-center gap-2 rounded text-xs font-semibold tracking-[0.05em] text-ws-ink2 uppercase focus-visible:outline-2 focus-visible:outline-ws-pip">
        Needs you
        <span data-workstream-needs-count className="rounded-full bg-ws-pip px-1.5 text-[10px] leading-4 text-ws-on-pip">
          {mine.length}
        </span>
      </h3>
      {advanced && (
        <p key={advanced.id} role="status" data-needs-advanced className="m-0 text-sm text-ws-ink2 [overflow-wrap:anywhere]">
          {advanced.text}
        </p>
      )}
      {group && <GroupBatch group={group} />}
      {showBatch && <BatchDecision key={batch} gid={batch} needs={needs} />}
      {mine.map((n) => (
        <NeedItem key={`${n.key}:${paneRev}`} need={n} open={!showBatch && n.key === deciding} />
      ))}
    </section>
  );
}
