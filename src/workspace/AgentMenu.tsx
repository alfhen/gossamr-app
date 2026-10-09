import { useEffect, useState } from "react";
import { itemKey } from "../lib/filter";
import { STAGE_LABEL } from "../lib/workstreamStage";
import type { CodeChange, ItemRef, Run, RunKind, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { RunLabel } from "./AgentCard";
import { Icon, KIND_ICON } from "./AgentIcons";
import { StateChip } from "./AgentParts";
import { progressText, runTitle } from "./agentsLogic";
import { usePopover } from "./Popover";
import { useRunSetup } from "./runSetupStore";
import { reviewablePr } from "./runSheetLogic";
import { useRuns } from "./runsStore";

export interface AgentMenuProps {
  ticketKey: string;
  open: boolean;
  onOpen(open: boolean): void;
  onStart(kind: RunKind): void;
  /** An open pull request linked to the ticket that a review could take; the Review entry is offered only with one. */
  reviewPr?: Pick<CodeChange, "number" | "title"> | null;
}

const ENTRIES: { kind: RunKind; label: string; note: string }[] = [
  { kind: "investigate", label: "Investigate this ticket", note: "Reads the code and logs, changes nothing, reports back" },
  { kind: "triage", label: "Triage this ticket", note: "Sizes it, finds likely owners and duplicates, changes nothing" },
  { kind: "plan", label: "Plan this ticket", note: "Writes an implementation plan for you to read, edit and approve, changes nothing" },
  { kind: "build", label: "Build this", note: "Makes the change on its own branch; pushing is off unless you allow it" },
  { kind: "review", label: "Review the PR", note: "Reads the linked pull request, comments to you, changes nothing" },
  { kind: "verify", label: "Verify the change", note: "Checks the change works by reading code and running read-only commands" },
];

/** The menu on a ticket for starting an agent. Choosing a kind opens a draft to read, not a run. */
export function AgentMenuView({ ticketKey, open, onOpen, onStart, reviewPr = null }: AgentMenuProps) {
  return (
    <div className="relative">
      <button
        type="button"
        data-popover-trigger
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-md border border-ws-pip px-2.5 py-0.5 text-sm font-semibold text-ws-pip hover:bg-ws-pip-soft"
      >
        <Icon name="spark" />
        Agent
        <span aria-hidden className="text-[11px] opacity-70">
          ▾
        </span>
      </button>
      {open && (
        <ul role="menu" aria-label={`Start an agent on ${ticketKey}`} className="absolute top-full left-0 z-30 m-0 mt-1 grid min-w-64 list-none gap-px rounded-lg border border-ws-sep2 bg-ws-win p-1 shadow-ws-pop">
          <li className="px-2 py-1 text-xs text-ws-ink3">Draft an agent for {ticketKey}</li>
          {ENTRIES.filter((e) => e.kind !== "review" || reviewPr).map((e, i) => (
            <li key={e.kind} role="none">
              <button type="button" role="menuitem" autoFocus={i === 0} onClick={() => onStart(e.kind)} className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-ws-hover focus-visible:bg-ws-hover">
                <Icon name={KIND_ICON[e.kind]} className="mt-0.5 size-[15px] text-ws-ink3" />
                <span className="grid">
                  <span>{e.label}</span>
                  <small className="text-xs text-ws-ink3">{e.kind === "review" && reviewPr ? `#${reviewPr.number} ${reviewPr.title}` : e.note}</small>
                </span>
              </button>
            </li>
          ))}
          <li className="px-2 pt-1 pb-1.5 text-xs text-ws-ink3">You read the exact prompt and approve before anything starts.</li>
        </ul>
      )}
    </div>
  );
}

export function AgentMenu({ item }: { item: ItemRef }) {
  const { open, setOpen, root } = usePopover();
  const backend = useWorkspace((w) => w.backend);
  const [reviewPr, setReviewPr] = useState<CodeChange | null>(null);
  const id = itemKey(item);
  useEffect(() => {
    if (!open || !backend) return;
    let live = true;
    backend
      .devLinks(item)
      .then((links) => live && setReviewPr(reviewablePr(links)))
      .catch(() => live && setReviewPr(null));
    return () => void (live = false);
  }, [open, backend, id]);
  return (
    <div
      ref={root}
      onKeyDown={(ev) => {
        // Stopped here so the peek behind the menu doesn't close on the same key.
        if (ev.key !== "Escape" || !open) return;
        ev.stopPropagation();
        setOpen(false);
        root.current?.querySelector<HTMLElement>("[data-popover-trigger]")?.focus();
      }}
    >
      <AgentMenuView
        ticketKey={item.key}
        open={open}
        onOpen={setOpen}
        reviewPr={reviewPr?.number ? { number: reviewPr.number, title: reviewPr.title } : null}
        onStart={(kind) => {
          setOpen(false);
          void useRunSetup.getState().begin({ item, kind, ...(kind === "review" && reviewPr?.number ? { pr: reviewPr.number, repo: reviewPr.repo } : {}) });
        }}
      />
    </div>
  );
}

export const runsOfTicket = (runs: readonly Run[], ref: ItemRef) => runs.filter((r) => r.item && itemKey(r.item) === itemKey(ref));

/** The workstream line at the head of "Agents on this ticket": its title and the stage its runs give it. */
export function WorkstreamLine({ workstream }: { workstream: WorkstreamView }) {
  return (
    <p data-workstream={workstream.workstream.id} className="m-0 mb-1.5 flex min-w-0 items-center gap-1.5 text-sm text-ws-ink2">
      <span aria-hidden className="text-ws-pip">
        ◆
      </span>
      <span className="min-w-0 truncate">Workstream: {workstream.workstream.title}</span>
      <span className="shrink-0 rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip" data-stage={workstream.stage}>
        {STAGE_LABEL[workstream.stage]}
      </span>
    </p>
  );
}

/** A ticket's runs, each with its short name (`R1`) when `labels` has one. */
export function TicketAgentRows({ runs, now, title, labels = {}, onOpen }: { runs: readonly Run[]; now: number; title: string | null; labels?: Readonly<Record<string, string>>; onOpen(id: string): void }) {
  if (!runs.length) return <p className="m-0 text-ws-ink3">None yet. Starting one is a draft you approve first.</p>;
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0">
      {runs.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => onOpen(r.id)} data-state={r.state} className="grid w-full gap-1 rounded-[10px] border border-ws-sep bg-ws-win px-3 py-2 text-left hover:border-ws-sep2">
            <span className="flex min-w-0 items-center gap-2">
              <RunLabel label={labels[r.id]} />
              <b className="min-w-0 truncate font-semibold">{runTitle(r, title)}</b>
              <span className="ml-auto shrink-0">
                <StateChip run={r} now={now} />
              </span>
            </span>
            <span className="truncate text-sm text-ws-ink2">{r.state === "working" || r.state === "launching" || r.state === "queued" ? progressText(r) : (r.needs ?? r.summary ?? r.result ?? r.error ?? "").split("\n")[0]}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "Agents on this ticket": the ticket's open workstream, if it has one, with its stage, then its runs labelled R1, R2 within it. */
export function TicketAgentsView({ runs, now, title, workstream, onOpen }: { runs: readonly Run[]; now: number; title: string | null; workstream: WorkstreamView | null; onOpen(id: string): void }) {
  const labels = workstream ? Object.fromEntries(workstream.labels) : undefined;
  return (
    <>
      {workstream && <WorkstreamLine workstream={workstream} />}
      <TicketAgentRows runs={runs} now={now} title={title} labels={labels} onOpen={onOpen} />
    </>
  );
}

export function TicketAgents({ item, title, workstream = null }: { item: ItemRef; title: string; workstream?: WorkstreamView | null }) {
  const runs = useRuns((s) => s.runs);
  const mine = runsOfTicket(runs, item);
  return <TicketAgentsView runs={mine} now={Date.now()} title={title} workstream={workstream} onOpen={(id) => useRuns.getState().openRun(id, { stay: true })} />;
}
