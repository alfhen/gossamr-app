import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { itemKey } from "../lib/filter";
import { inWorkstreamPane } from "../lib/proposals";
import type { CodeChange, Proposal, ReviewView, Run, WorkstreamEvent, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { RunLabel } from "./AgentCard";
import { TONE } from "./AgentParts";
import { Btn } from "./AgentSheet";
import { draftTitle } from "./DraftCard";
import { LiveDraftPreview } from "./DraftPreview";
import { PipRunCard } from "./PipRunCard";
import { batchable, batchToApprove, freezeBatch, retiredStepDrafts, stepChips, stepDrafts, type BatchSnapshot, type StepChip, type StepGroup } from "./pipHomeLogic";
import { usePipHome } from "./pipHomeStore";
import { openOnGithub } from "./githubUi";
import { openPullView } from "./pullViewStore";
import { useBuildChanges, useReviewVerdicts } from "./reviewVerdicts";
import { useRuns } from "./runsStore";
import { approveEach } from "./useCards";
import { WorkstreamControls } from "./WorkstreamControls";
import { useWorkstreams } from "./workstreamsStore";

const NO_CHANGES: Readonly<Record<string, CodeChange | null>> = {};

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "Approved 2.", or "Approved 1. Failed: Comment on CA-401: …" naming each draft that didn't go through. */
export async function approveBatch(drafts: readonly Proposal[], approve: (id: string) => Promise<{ error?: string | null }>): Promise<{ text: string; failed: boolean }> {
  const titles = new Map(drafts.map((p) => [p.id, draftTitle(p)]));
  // A refusal that throws is a failure of that one draft; the rest still go.
  const done = await approveEach(
    drafts.map((p) => p.id),
    (id) => approve(id).catch((e: unknown) => ({ error: messageOf(e) })),
  );
  if (!done.failed.length) return { text: `Approved ${done.ok}.`, failed: false };
  return { text: `Approved ${done.ok}. Failed: ${done.failed.map((f) => `${titles.get(f.id)}: ${f.error}`).join("; ")}`, failed: true };
}

/** Asks before approving a step's drafts together; Esc keeps them as they are. */
export function BatchConfirm({ count, onConfirm, onCancel }: { count: number; onConfirm(): void; onCancel(): void }) {
  return (
    <div
      role="group"
      aria-label={`Approve ${count} drafts`}
      data-esc-local
      className="flex flex-wrap items-center gap-2 rounded-lg border border-ws-sep2 bg-ws-win px-2.5 py-2 text-sm"
      onKeyDown={(ev: KeyboardEvent<HTMLDivElement>) => {
        if (ev.key === "Escape") (ev.stopPropagation(), ev.preventDefault(), onCancel());
      }}
    >
      <span className="text-ws-ink2">Approve all {count}? Each is written to Jira as its card shows it.</span>
      <Btn tone="primary" autoFocus onClick={onConfirm} className="px-2 py-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip">
        Yes, approve {count}
      </Btn>
      <Btn tone="ghost" onClick={onCancel} className="px-2 py-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip">
        Cancel
      </Btn>
    </div>
  );
}

/** Said when a draft a confirm covered was decided or revised before Yes: nothing goes. */
export const BATCH_CHANGED = "These drafts changed while you were deciding, so nothing was approved. Look again.";

/**
 * Approves what a confirm covered (`frozen`) out of the step's drafts now, as `batchToApprove` picks them: never a
 * description rewrite or a run, never one that came in after the confirm opened.
 */
export async function confirmBatch(frozen: BatchSnapshot, drafts: readonly Proposal[], approve: (id: string) => Promise<{ error?: string | null }>): Promise<{ text: string; failed: boolean }> {
  try {
    const picked = batchToApprove(frozen, drafts);
    return picked ? await approveBatch(picked, approve) : { text: BATCH_CHANGED, failed: true };
  } catch (e) {
    // Nothing above should throw, but if it does the person is told rather than left with no outcome.
    return { text: `Couldn't approve these drafts: ${messageOf(e)}`, failed: true };
  }
}

/** A step's drafts, each as its card in the conversation, with "Approve these N" over two or more that may go together. */
export function StepDrafts({ step, drafts, approve, initialConfirming = false }: { step: StepGroup; drafts: readonly Proposal[]; approve(id: string): Promise<{ error?: string | null }>; initialConfirming?: boolean }) {
  /** The drafts the open confirm covers, fixed when it opened; null while it is closed. */
  const [frozen, setFrozen] = useState<BatchSnapshot | null>(() => (initialConfirming ? freezeBatch(drafts) : null));
  const [outcome, setOutcome] = useState<{ text: string; failed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = useRef<HTMLButtonElement>(null);
  const said = useRef<HTMLParagraphElement>(null);
  /** Set by a confirm: the confirmation and the drafts go, so the keyboard lands on what came of them. */
  const refocus = useRef(false);
  const together = batchable(drafts);
  useEffect(() => {
    if (!outcome || !refocus.current) return;
    refocus.current = false;
    if (!document.activeElement || document.activeElement === document.body) said.current?.focus();
  }, [outcome]);
  const cancel = () => {
    setFrozen(null);
    requestAnimationFrame(() => ask.current?.focus());
  };
  const confirm = async (covered: BatchSnapshot) => {
    refocus.current = true;
    setFrozen(null);
    setBusy(true);
    try {
      setOutcome(await confirmBatch(covered, drafts, approve));
    } catch (e) {
      setOutcome({ text: `Couldn't approve these drafts: ${messageOf(e)}`, failed: true });
    } finally {
      setBusy(false);
    }
  };
  if (!drafts.length && !outcome) return null;
  return (
    <div data-step-drafts={step} className="grid gap-2">
      {frozen ? (
        <BatchConfirm count={frozen.length} onConfirm={() => void confirm(frozen)} onCancel={cancel} />
      ) : (
        together.length >= 2 && (
          <div>
            <button
              ref={ask}
              type="button"
              disabled={busy}
              onClick={() => (setOutcome(null), setFrozen(freezeBatch(drafts)))}
              className="rounded-md border border-ws-sep2 px-2.5 py-px text-sm font-semibold text-ws-ink hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip disabled:opacity-45"
            >
              {busy ? "Approving…" : `Approve these ${together.length}`}
            </button>
          </div>
        ))}
      {outcome && (
        <p ref={said} role="status" tabIndex={-1} data-batch-outcome className={`m-0 rounded text-sm [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip ${outcome.failed ? "text-ws-blocked" : "text-ws-ink2"}`}>
          {outcome.text}
        </p>
      )}
      {drafts.map((p) => (
        <LiveDraftPreview key={p.id} proposal={p} />
      ))}
    </div>
  );
}

/** A step's retired drafts, collapsed to "N earlier drafts"; open, each says what it was and why it went. */
export function EarlierStepDrafts({ step, drafts, initialOpen = false }: { step: StepGroup; drafts: readonly Proposal[]; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  if (!drafts.length) return null;
  const list = `earlier-drafts-${step}`;
  return (
    <div data-earlier-drafts={step} className="grid gap-1 text-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={list}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 justify-self-start rounded text-ws-ink3 hover:text-ws-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
      >
        <span aria-hidden className="text-xs">
          {open ? "▾" : "▸"}
        </span>
        {drafts.length} earlier draft{drafts.length === 1 ? "" : "s"}
      </button>
      <ul id={list} hidden={!open} className="m-0 grid list-none gap-0.5 p-0 pl-4 text-ws-ink3">
        {drafts.map((p) => (
          <li key={p.id} data-earlier-draft={p.id} className="[overflow-wrap:anywhere]">
            <span className="font-semibold text-ws-ink2">{draftTitle(p)}</span> · {p.state.type === "retired" ? p.state.reason : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The chip's one line: the newest run's label and state, then what else is worth a glance. */
function ChipLine({ chip, label }: { chip: StepChip; label?: string }) {
  if (!chip.newest) return <span className="text-xs text-ws-ink3">Not started</span>;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-ws-ink3">
      <RunLabel label={label} />
      <span data-step-state className={`font-semibold ${chip.tone ? TONE[chip.tone].text : ""}`}>
        {chip.state}
      </span>
      {chip.runs.length > 1 && <span>· {chip.runs.length} runs</span>}
      {chip.auto && <span data-step-auto>· started automatically</span>}
      {chip.verdict && <span data-step-verdict>· {chip.verdict}</span>}
      {chip.fixRound && <span data-step-fix-round>· {chip.fixRound}</span>}
    </span>
  );
}

/** The build's pull request under the Build chip, as a link to it on GitHub: "Draft PR #301 CA-401: …". */
function StepPullRequest({ pr, onOpen }: { pr: NonNullable<StepChip["pr"]>; onOpen(url: string): void }) {
  return (
    <p data-step-pr className="m-0 flex min-w-0 items-baseline gap-1.5 px-2.5 text-xs text-ws-ink3">
      <span className="shrink-0">{pr.state === "draft" ? "Draft PR" : "PR"}</span>
      <button
        type="button"
        onClick={() => onOpen(pr.url)}
        title="Open on GitHub"
        className="min-w-0 truncate rounded text-left font-semibold text-ws-pip hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
      >
        #{pr.number} {pr.title}
      </button>
    </p>
  );
}

/** The pull request the Review step read, with a button that shows it in Gossamr. */
function ReviewedPull({ repo, number, onOpen }: { repo: string; number: number; onOpen(): void }) {
  return (
    <p data-step-review-pr className="m-0 flex min-w-0 items-baseline gap-1.5 px-2.5 text-xs text-ws-ink3">
      <span className="min-w-0 truncate">
        Reviewed {repo}#{number}
      </span>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`PR view of ${repo}#${number}`}
        className="shrink-0 rounded border border-ws-sep2 px-1.5 font-semibold text-ws-pip hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
      >
        PR view
      </button>
    </p>
  );
}

export interface StepRailViewProps {
  view: WorkstreamView;
  /** The workstream's own runs. */
  runs: readonly Run[];
  events: readonly WorkstreamEvent[];
  verdicts: Readonly<Record<string, ReviewView | null>>;
  /** What each finished build produced, by run id, as far as a sync has seen it. */
  changes?: Readonly<Record<string, CodeChange | null>>;
  /** The drafts the workstream's conversation shows. */
  proposals: readonly Proposal[];
  now: number;
  titleOf(run: Run): string | null;
  onOpenRun(run: Run): void;
  approve(id: string): Promise<{ error?: string | null }>;
  /** Opens the build's pull request on GitHub. */
  onOpenPr?(url: string): void;
  /** Opens the pull request a review read in the in-app view, with its pending review draft when there is one. */
  onPullView?(repo: string, number: number): void;
  /** Steps shown open at first; a test passes its own. */
  initialOpen?: readonly StepGroup[];
  /** A run to show: the step it is in opens, as when a wake turn's header names it. */
  reveal?: string | null;
}

/**
 * The step rail of a workstream: Pip's notes, the workstream's controls, Pip's own drafts, then a chip for each step of
 * the chain. A chip opens to its runs and the drafts about it, where a draft is decided as in the conversation.
 */
export function StepRailView({ view, runs, events, verdicts, changes = NO_CHANGES, proposals, now, titleOf, onOpenRun, approve, onOpenPr = (url) => void openOnGithub(url), onPullView = (repo, number) => openPullView({ repo, number }), initialOpen = [], reveal = null }: StepRailViewProps) {
  const [open, setOpen] = useState<ReadonlySet<StepGroup>>(() => new Set(initialOpen));
  const chips = useMemo(() => stepChips([...runs], events, verdicts, proposals, { now, waitingForPr: view.waitingForPr, changes }), [runs, events, verdicts, proposals, now, view.waitingForPr, changes]);
  const revealIn = reveal ? (runs.find((r) => r.id === reveal)?.spec.kind ?? null) : null;
  useEffect(() => {
    if (revealIn) setOpen((was) => (was.has(revealIn) ? was : new Set([...was, revealIn])));
  }, [reveal, revealIn]);
  const drafts = useMemo(() => stepDrafts(proposals, runs), [proposals, runs]);
  const retired = useMemo(() => retiredStepDrafts(proposals, runs), [proposals, runs]);
  const labels = useMemo(() => new Map(view.labels), [view.labels]);
  const id = view.workstream.id;
  const toggle = (step: StepGroup) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(step)) next.add(step);
      return next;
    });
  return (
    <div data-step-rail={id} className="grid content-start gap-3">
      <section aria-label="Pip's notes" className="grid gap-1">
        <h3 className="m-0 text-sm font-semibold">Pip&apos;s notes</h3>
        <p className="selectable m-0 text-sm whitespace-pre-wrap text-ws-ink2 [overflow-wrap:anywhere]">{view.workstream.notes?.trim() || "No notes yet."}</p>
      </section>
      <WorkstreamControls key={id} view={view} />
      {(drafts.pip || retired.pip) && (
        <section aria-label="Pip's drafts" className="grid gap-1.5">
          <h3 className="m-0 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">Pip&apos;s drafts</h3>
          <StepDrafts step="pip" drafts={drafts.pip ?? []} approve={approve} />
          <EarlierStepDrafts step="pip" drafts={retired.pip ?? []} />
        </section>
      )}
      <ol aria-label="Steps of the workstream" className="m-0 grid list-none gap-1.5 p-0">
        {chips.map((chip) => {
          const shown = open.has(chip.kind);
          const panel = `step-${id}-${chip.kind}`;
          return (
            <li key={chip.kind} data-step={chip.kind} data-state={chip.newest?.state ?? "none"} className="grid gap-1.5">
              <button
                type="button"
                data-step-chip={chip.kind}
                aria-expanded={shown}
                aria-controls={panel}
                onClick={() => toggle(chip.kind)}
                className={`grid w-full gap-0.5 rounded-lg border px-2.5 py-1.5 text-left outline-none hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ws-pip ${shown ? "border-ws-sep2 bg-ws-win" : "border-ws-sep"}`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span aria-hidden className="text-xs text-ws-ink3">
                    {shown ? "▾" : "▸"}
                  </span>
                  <b className="text-sm font-semibold">{chip.label}</b>
                  {chip.needsYou > 0 && (
                    <span data-step-needs-you className="ml-auto shrink-0 rounded-full bg-ws-pip px-1.5 text-[10px] leading-4 font-semibold text-ws-on-pip">
                      {chip.needsYou} {chip.needsYou === 1 ? "needs" : "need"} you
                    </span>
                  )}
                </span>
                <ChipLine chip={chip} label={chip.newest ? labels.get(chip.newest.id) : undefined} />
              </button>
              {chip.pr && <StepPullRequest pr={chip.pr} onOpen={onOpenPr} />}
              {chip.kind === "review" && chip.newest?.spec.pr && <ReviewedPull repo={chip.newest.spec.repo} number={chip.newest.spec.pr} onOpen={() => onPullView(chip.newest!.spec.repo, chip.newest!.spec.pr!)} />}
              {shown && (
                <div id={panel} className="grid gap-1.5 pl-2">
                  {chip.runs.map((run) => (
                    <PipRunCard key={run.id} run={run} now={now} ticketTitle={titleOf(run)} label={labels.get(run.id)} onOpen={() => onOpenRun(run)} focusable />
                  ))}
                  <StepDrafts step={chip.kind} drafts={drafts[chip.kind] ?? []} approve={approve} />
                  <EarlierStepDrafts step={chip.kind} drafts={retired[chip.kind] ?? []} />
                  {!chip.runs.length && !drafts[chip.kind] && !retired[chip.kind] && <p className="m-0 text-sm text-ws-ink3">Nothing here yet.</p>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const NO_EVENTS: readonly WorkstreamEvent[] = [];

/** The step rail of `view`, from the live stores; its audit is read again as the workstream and its runs move. */
export function StepRail({ view }: { view: WorkstreamView }) {
  const id = view.workstream.id;
  const allRuns = useRuns((s) => s.runs);
  const runs = useMemo(() => allRuns.filter((r) => view.runs.includes(r.id) || r.spec.workstream === id), [allRuns, view.runs, id]);
  const events = useWorkstreams((s) => s.events[id]) ?? NO_EVENTS;
  const verdicts = useReviewVerdicts(runs);
  // Asked again as soon as the workstream stops waiting for its build's pull request: a sync found it.
  const changes = useBuildChanges(runs, view.waitingForPr ?? null);
  const allProposals = useWorkspace((s) => s.proposals);
  const proposals = useMemo(() => Object.values(allProposals).filter((p) => inWorkstreamPane(p, view.workstream)), [allProposals, view.workstream]);
  const items = useWorkspace((s) => s.items);
  const reveal = usePipHome((s) => (s.focusTarget?.type === "run" && s.focusTarget.where === "rail" ? s.focusTarget.id : null));
  useEffect(() => {
    void useWorkstreams.getState().loadEvents(id);
  }, [id]);
  return (
    <StepRailView
      view={view}
      runs={runs}
      events={events}
      verdicts={verdicts}
      changes={changes}
      proposals={proposals}
      now={Date.now()}
      titleOf={(run) => (run.item ? (items[itemKey(run.item)]?.title ?? null) : null)}
      onOpenRun={(run) => useRuns.getState().openRun(run.id, { stay: true })}
      approve={(draft) => useWorkspace.getState().approve(draft)}
      reveal={reveal}
    />
  );
}
