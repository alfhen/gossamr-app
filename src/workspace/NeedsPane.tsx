import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { needAfter, needGroups, type Need } from "../lib/needs";
import { ALLOW_MORE_STEPS, type Proposal, type Run, type WorkstreamView } from "../types";
import { stepsOf } from "../lib/workstreamHold";
import { useWorkspace } from "../workspaceStore";
import { OpenInTerminal, FailureNext } from "./AgentParts";
import { Box, BoxTitle, Btn } from "./AgentSheet";
import { planOpenQuestions, progressText, quietMinutes, quietText } from "./agentsLogic";
import { draftSummary, draftTitle, LiveDraftCard } from "./DraftCard";
import { draftDecisions } from "./DraftPreview";
import { escalationActions, EscalationCardView, fixRoundSent, postingReview, TAKEN_OVER } from "./EscalationCard";
import { failureAction } from "./failureActions";
import { failureHelp } from "./failureHelp";
import { inlineStartable, InlineStart, useInlineStarts } from "./InlineStart";
import { GroupChip } from "./NeedsYou";
import { groupId, openInWorkstream, takePaneIntent } from "./needsActions";
import { openInWorkstreamLabel } from "../lib/needs";
import { PermissionAsk, StopRunConfirm } from "./PermissionAsk";
import { usePipHome } from "./pipHomeStore";
import { RunAnswer } from "./RunAnswer";
import { RunContinuation } from "./RunContinuation";
import { SignInBox } from "./RunSheet";
import { resumable } from "./runSheetLogic";
import { useRuns } from "./runsStore";
import { BatchConfirm, PlanApproval, confirmBatch, planResultFor } from "./StepRail";
import { batchLabel, freezeBatch, type BatchSnapshot } from "./pipHomeLogic";
import { useToasts } from "./toasts";
import { useNow } from "./useNow";
import { controlActions, HeldBanner } from "./WorkstreamControls";
import { useWorkstreams } from "./workstreamsStore";

/** The row of `need` in Pip home's list: its own when the group is expanded, else its group's. */
function rowFor(need: Need): HTMLElement | null {
  const list = '[data-pip-home-column="list"]';
  return document.querySelector<HTMLElement>(`${list} [data-need-key="${CSS.escape(need.key)}"]`) ?? document.querySelector<HTMLElement>(`${list} [data-needs-you-group="${groupId(need.workstreamId)}"]`);
}

/**
 * Where the keyboard goes once a need is dealt with: the next need in rank order opens in the pane when the pane was on
 * the one dealt with; from a row of the list it lands on the next row. With none left it lands on the list's title,
 * where "Nothing needs you." is said.
 */
function useAdvance(needs: readonly Need[]) {
  const previous = useRef<string[]>([]);
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
    previous.current = keys;
    const home = usePipHome.getState();
    const deciding = home.deciding;
    const lands = (next: Need | null) => requestAnimationFrame(() => (next ? rowFor(next) : document.querySelector<HTMLElement>('[data-pip-home-column="list"] [data-needs-you-title]'))?.focus());
    if (deciding && before.includes(deciding) && !keys.includes(deciding)) {
      const next = needAfter(before, deciding, needs);
      if (next) home.decide(next.key, next.workstreamId);
      else {
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

/** The first thing the person decides with in the pane: a permission's buttons, an answer box, a draft's main button, else the first button. */
export function firstDecision(root: HTMLElement): HTMLElement | null {
  const body = '[data-needs-pane-body]';
  const decisions = root.querySelector<HTMLElement>(`${body} [data-permission-decisions] button:not(:disabled)`);
  if (decisions) return decisions;
  // A review that still blocks: its first choice, ahead of the review draft folded under it.
  const choice = root.querySelector<HTMLElement>(`${body} [data-escalation] button:not(:disabled)`);
  if (choice) return choice;
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
  return <PermissionAsk run={run} onAttach={() => void store.attach(run.id)} onStop={() => void store.stop(run.id)} confirmStop />;
}

function AnswerBody({ run }: { run: Run }) {
  const answering = useRuns((s) => s.answering.has(run.id));
  const store = useRuns.getState();
  return <RunAnswer key={run.id} run={run} answering={answering} on={{ answer: (text) => void store.answer(run.id, text), attach: () => void store.attach(run.id) }} />;
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

function StoppedBody({ run }: { run: Run }) {
  const store = useRuns.getState();
  return (
    <div className="grid gap-2">
      {resumable(run) && <AnswerBody run={run} />}
      <RunContinuation key={`continue-${run.id}`} run={run} adopt={(session) => store.adoptSession(run.id, session)} />
      <div>
        <Dismiss run={run} />
      </div>
    </div>
  );
}

function QuietBody({ run }: { run: Run }) {
  const now = useNow();
  const [stopping, setStopping] = useState(false);
  const quiet = quietMinutes(run, now);
  const store = useRuns.getState();
  return (
    <Box tone="warn" label="Gone quiet">
      <BoxTitle icon="clock" tone="warn">
        {quiet === null ? "It has made progress again" : quietText(quiet)}
      </BoxTitle>
      <p className="m-0 text-ws-ink2">No new line and no new tokens for a while. It may be waiting on something slow. It was at: {progressText(run)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <OpenInTerminal run={run} onOpen={() => void store.attach(run.id)} filled={false} />
        {stopping ? (
          <StopRunConfirm name="this run" onStop={() => (setStopping(false), void store.stop(run.id))} onKeep={() => setStopping(false)} />
        ) : (
          <Btn tone="danger" icon="stop" onClick={() => setStopping(true)}>
            Stop the run
          </Btn>
        )}
      </div>
    </Box>
  );
}

function UnknownBody({ run }: { run: Run }) {
  const store = useRuns.getState();
  return (
    <Box tone="warn" label="State unclear">
      <BoxTitle icon="help" tone="warn">
        Open in Terminal to look
      </BoxTitle>
      <p className="m-0 text-ws-ink2">{run.needs?.trim() || run.lastDetail?.trim() || "Gossamr can't tell what this session is doing."}</p>
      <div className="flex flex-wrap items-center gap-2">
        <OpenInTerminal run={run} onOpen={() => void store.attach(run.id)} filled={false} />
        <Dismiss run={run} />
      </div>
    </Box>
  );
}

/** The choice a workstream that used its automatic steps asks for: allow more, or Advise, where nothing starts on its own. */
function BudgetBody({ view }: { view: WorkstreamView }) {
  const id = view.workstream.id;
  const { used, limit } = stepsOf(view.budget);
  const store = useWorkstreams.getState();
  return (
    <Box tone="warn" label="Automatic steps">
      <BoxTitle icon="clock" tone="warn">
        {used} of {limit} automatic steps used
      </BoxTitle>
      <p className="m-0 text-ws-ink2">Pip and the automatic steps are paused; its agents carry on. Allow {ALLOW_MORE_STEPS} more to carry on from here, or switch to Advise, where Pip suggests and you start.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Btn tone="primary" onClick={() => void store.allowMore(id)}>
          Allow {ALLOW_MORE_STEPS} more
        </Btn>
        <Btn tone="plain" onClick={() => void store.setMode(id, "advise")}>
          Switch to Advise
        </Btn>
      </div>
    </Box>
  );
}

/** The three choices on a ticket its triage found not clear enough to plan: ask the reporter, answer the questions, or plan anyway. */
function ReadinessBody({ view, need }: { view: WorkstreamView; need: Need }) {
  const r = view.readiness;
  const id = view.workstream.id;
  const [busy, setBusy] = useState(false);
  if (!r) return null;
  const key = view.workstream.itemKey ?? "the ticket";
  const choose = (call: () => Promise<boolean>) => {
    setBusy(true);
    void call().finally(() => setBusy(false));
  };
  const store = useWorkstreams.getState();
  return (
    <Box tone="warn" label={r.changed ? "Ticket changed" : "Not ready to plan"}>
      <BoxTitle icon="alert" tone="warn">
        {need.title}
      </BoxTitle>
      {r.questions.length > 0 ? (
        <ul data-readiness-questions className="m-0 grid gap-1 pl-5 text-ws-ink2">
          {r.questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-ws-ink2">The triage found {key} unclear but listed no questions.</p>
      )}
      {r.changed ? (
        <>
          <p className="m-0 text-ws-ink2">No plan starts until you choose. Read the ticket as it is now, then plan, or ask the reporter again; asking drafts a Jira comment for you to approve, and nothing is posted before that.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Btn tone="primary" disabled={busy} onClick={() => choose(() => store.planAnyway(id))}>
              Plan now
            </Btn>
            <Btn tone="plain" disabled={busy} onClick={() => choose(() => store.askReporter(id))}>
              Still unclear (ask again)
            </Btn>
          </div>
        </>
      ) : (
        <>
          <p className="m-0 text-ws-ink2">No plan starts until you choose. Asking the reporter drafts a Jira comment for you to approve; nothing is posted before that.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Btn tone="primary" disabled={busy} onClick={() => choose(() => store.askReporter(id))}>
              Ask the reporter
            </Btn>
            <Btn tone="plain" disabled={busy} onClick={() => choose(() => store.answerSelf(id))}>
              I'll answer
            </Btn>
            <Btn tone="plain" disabled={busy} onClick={() => choose(() => store.planAnyway(id))}>
              Plan anyway
            </Btn>
          </div>
        </>
      )}
    </Box>
  );
}

/** The three choices on a review that still blocks, and the review draft that folded into it, ready to post as it is. */
function EscalationBody({ view }: { view: WorkstreamView }) {
  const e = view.escalation;
  const [busy, setBusy] = useState(false);
  // Post the review as is was pressed: the choices wait, as on the rail's card, until the draft is posted or goes.
  const [posting, setPosting] = useState(false);
  const draft = useWorkspace((s) => (e?.reviewDraft ? s.proposals[e.reviewDraft] : undefined));
  const review = useRef<HTMLDivElement>(null);
  const pending = draft?.state.type === "pending";
  useEffect(() => {
    if (posting && !pending) setPosting(false);
  }, [posting, pending]);
  if (!e) return null;
  const actions = escalationActions(view.workstream.id, e);
  const choose = (call: () => Promise<boolean>, text: string) => {
    setBusy(true);
    void call()
      .then((done) => done && useToasts.getState().push(text, "info"))
      .finally(() => setBusy(false));
  };
  return (
    <div className="grid gap-2">
      <EscalationCardView
        escalation={e}
        busy={busy}
        drafting={postingReview(posting, draft)}
        titled={false}
        onFixRound={() => choose(actions.onFixRound, fixRoundSent(e.buildLabel))}
        onTakeOver={() => choose(actions.onTakeOver, TAKEN_OVER)}
        onPost={() => {
          setPosting(true);
          // The draft is under the choices; nothing goes to GitHub until its own Post review.
          const buttons = Array.from(review.current?.querySelectorAll<HTMLElement>("[data-draft-actions] button:not(:disabled)") ?? []);
          const post = buttons.pop() ?? review.current?.querySelector<HTMLElement>("button:not(:disabled)");
          post?.scrollIntoView?.({ block: "nearest" });
          post?.focus();
        }}
      />
      {draft && draft.state.type === "pending" && (
        <div ref={review}>
          <LiveDraftCard proposal={draft} jump={false} />
        </div>
      )}
    </div>
  );
}

function DraftBody({ need, proposal: p }: { need: Need; proposal: Proposal }) {
  const runs = useRuns((s) => s.runs);
  return (
    <div className="grid gap-2">
      {need.kind === "plan" && <PlanApproval questions={planOpenQuestions(planResultFor(p, runs, undefined))} />}
      <LiveDraftCard proposal={p} jump={false} />
    </div>
  );
}

/** A run draft: one of a kind that needs nothing chosen is read in place, with Start under it; any other opens its setup sheet from its card. */
function StartBody({ proposal: p }: { proposal: Proposal }) {
  const phase = useInlineStarts((s) => s.entries[p.id]?.phase ?? "closed");
  if (!inlineStartable(p)) return <LiveDraftCard proposal={p} jump={false} />;
  return (
    <div className="grid gap-2">
      <p className="m-0 text-sm text-ws-ink2">
        <b className="font-semibold text-ws-ink">{draftTitle(p)}</b> · {draftSummary(p, null)}
      </p>
      {phase === "closed" && (
        <div className="flex flex-wrap items-center gap-2">
          <Btn tone="primary" icon="play" onClick={() => void useInlineStarts.getState().open(p.id)}>
            Review and start
          </Btn>
          <Btn onClick={draftDecisions(p.id, p).skip}>Skip</Btn>
        </div>
      )}
      <InlineStart proposal={p} />
    </div>
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
      return proposal ? <LiveDraftCard proposal={proposal} jump={false} /> : run ? <AnswerBody run={run} /> : null;
    case "signIn":
      return run ? <SignInBox run={run} onAttach={() => void useRuns.getState().attach(run.id)} /> : null;
    case "failure":
      return run ? <FailureBody run={run} /> : null;
    case "stoppedAtLimit":
    case "continuation":
      return run ? <StoppedBody run={run} /> : null;
    case "quiet":
      return run ? <QuietBody run={run} /> : null;
    case "unknown":
      return run ? <UnknownBody run={run} /> : null;
    case "budget":
      return view ? <BudgetBody view={view} /> : null;
    case "hold":
      return view ? <HeldBanner view={view} onResume={() => controlActions(view.workstream.id).onResume()} /> : null;
    case "readiness":
      return view ? <ReadinessBody view={view} need={need} /> : null;
    case "escalation":
      return view ? <EscalationBody view={view} /> : null;
    case "runStart":
      return proposal ? <StartBody proposal={proposal} /> : null;
    case "plan":
    case "description":
    case "draft":
    case "review":
      return proposal ? <DraftBody need={need} proposal={proposal} /> : null;
  }
}

/** The pane's frame: what is asked and why, what waiting does, a way to the workstream and back, then the decision. */
function NeedDecision({ need }: { need: Need }) {
  const root = useRef<HTMLElement>(null);
  const close = () => {
    usePipHome.getState().closeDecision();
    requestAnimationFrame(() => rowFor(need)?.focus());
  };
  // Opened, the keyboard goes to the decision: its answer box or its main button; "e" opens an edit where the card has one.
  useEffect(() => {
    const intent = takePaneIntent();
    let frame = 0;
    let tries = 0;
    let clicked = false;
    const go = () => {
      const el = root.current;
      if (!el) return;
      if (intent === "card") {
        el.focus({ preventScroll: true });
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
  }, []);
  const onKeyDown = (ev: KeyboardEvent<HTMLElement>) => {
    if (ev.key !== "Escape" || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
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
  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label="Decision"
      data-needs-pane={need.key}
      data-kind={need.kind}
      data-group={need.group}
      onKeyDown={onKeyDown}
      // The pane is the one thing that scrolls in its place. Its drafts' action bars stay where the card ends (a sticky one would float over the text and the review comments beneath it).
      className="grid max-h-[60%] min-h-0 shrink-0 content-start gap-2 overflow-y-auto border-b border-ws-sep bg-ws-bar px-3 py-2.5 outline-none [&_[data-draft-actions]]:static"
    >
      {/* Kept in view while the decision under it scrolls: what is asked and why stays on screen. */}
      <header className="sticky -top-2.5 z-[2] -mx-3 -mt-2.5 flex items-start gap-2 bg-ws-bar px-3 pt-2.5 pb-1">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-ws-ink3">
            {need.head && (
              <b data-needs-pane-head className="min-w-0 truncate font-semibold text-ws-ink">
                {need.head}
              </b>
            )}
            <GroupChip group={need.group} />
            <span data-needs-pane-title className="min-w-0 truncate">
              {need.title}
            </span>
          </div>
          <p data-needs-why className="m-0 text-sm font-semibold text-ws-ink [overflow-wrap:anywhere]">
            {need.why}
          </p>
          <p data-needs-if-you-wait className="m-0 text-sm text-ws-ink2 [overflow-wrap:anywhere]">
            <span className="font-semibold">If you wait:</span> {need.ifYouWait}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2 text-sm">
          <a
            href="#open-in-workstream"
            onClick={(ev) => (ev.preventDefault(), openInWorkstream(need))}
            className="rounded font-semibold text-ws-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
          >
            {openInWorkstreamLabel(need)}
          </a>
          <button
            type="button"
            aria-label="Back to the list"
            title="Back to the list (Esc)"
            onClick={close}
            className="rounded px-1.5 text-ws-ink3 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
          >
            ×
          </button>
        </span>
      </header>
      <div data-needs-pane-body className="grid gap-2">
        <Decision need={need} />
      </div>
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
  const [frozen, setFrozen] = useState<BatchSnapshot | null>(() => (drafts.length >= 2 ? freezeBatch(drafts) : null));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; failed: boolean } | null>(null);
  const [title] = useState(() => group?.ticketKey ?? group?.title ?? "General");
  const root = useRef<HTMLElement>(null);
  const close = () => {
    usePipHome.getState().closeDecision();
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-pip-home-column="list"] [data-needs-you-group="${CSS.escape(gid)}"]`)?.focus());
  };
  const confirm = async (covered: BatchSnapshot) => {
    setFrozen(null);
    setBusy(true);
    const done = await confirmBatch(covered, drafts, (id) => useWorkspace.getState().approve(id));
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
      data-kind="batch"
      data-group="approve"
      onKeyDown={onKeyDown}
      className="grid max-h-[60%] min-h-0 shrink-0 content-start gap-2 overflow-y-auto border-b border-ws-sep bg-ws-bar px-3 py-2.5 outline-none"
    >
      <header className="flex items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-ws-ink3">
            <b data-needs-pane-head className="min-w-0 truncate font-semibold text-ws-ink">
              {title}
            </b>
            <GroupChip group="approve" />
            <span data-needs-pane-title className="min-w-0 truncate">
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
 * The Needs you decision, open inline above Pip home's conversation: the need chosen in the list (`deciding`), or a group's "Approve N safe drafts" preview (`batch`), with what
 * it asks and what waiting does, decided with the same components the cards and the run sheet use. Once it is dealt with
 * the next need opens in its place; with none left the pane closes and the list says "Nothing needs you."
 */
export function NeedsPane({ needs }: { needs: readonly Need[] }) {
  const deciding = usePipHome((s) => s.deciding);
  const paneRev = usePipHome((s) => s.paneRev);
  useAdvance(needs);
  const batch = usePipHome((s) => s.batch);
  const need = needs.find((n) => n.key === deciding);
  if (batch !== null) return <BatchDecision key={batch} gid={batch} needs={needs} />;
  return need ? <NeedDecision key={`${need.key}:${paneRev}`} need={need} /> : null;
}
