import { itemKey } from "../lib/filter";
import type { ItemRef, Run } from "../types";
import { Icon } from "./AgentIcons";
import { StateChip } from "./AgentParts";
import { progressText, runTitle } from "./agentsLogic";
import { usePopover } from "./Popover";
import { useRunSetup } from "./runSetupStore";
import { useRuns } from "./runsStore";

export interface AgentMenuProps {
  ticketKey: string;
  open: boolean;
  onOpen(open: boolean): void;
  onInvestigate(): void;
}

/** The menu on a ticket for starting an agent. Only Investigate exists yet; choosing it opens a draft to read, not a run. */
export function AgentMenuView({ ticketKey, open, onOpen, onInvestigate }: AgentMenuProps) {
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
          <li role="none">
            <button type="button" role="menuitem" autoFocus onClick={onInvestigate} className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-ws-hover focus-visible:bg-ws-hover">
              <Icon name="search" className="mt-0.5 size-[15px] text-ws-ink3" />
              <span className="grid">
                <span>Investigate this ticket</span>
                <small className="text-xs text-ws-ink3">Reads the code and logs, changes nothing, reports back</small>
              </span>
            </button>
          </li>
          <li className="px-2 pt-1 pb-1.5 text-xs text-ws-ink3">You read the exact prompt and approve before anything starts.</li>
        </ul>
      )}
    </div>
  );
}

export function AgentMenu({ item }: { item: ItemRef }) {
  const { open, setOpen, root } = usePopover();
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
        onInvestigate={() => {
          setOpen(false);
          void useRunSetup.getState().begin({ item });
        }}
      />
    </div>
  );
}

export const runsOfTicket = (runs: readonly Run[], ref: ItemRef) => runs.filter((r) => r.item && itemKey(r.item) === itemKey(ref));

export function TicketAgentRows({ runs, now, title, onOpen }: { runs: readonly Run[]; now: number; title: string | null; onOpen(id: string): void }) {
  if (!runs.length) return <p className="m-0 text-ws-ink3">None yet. Starting one is a draft you approve first.</p>;
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0">
      {runs.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => onOpen(r.id)} data-state={r.state} className="grid w-full gap-1 rounded-[10px] border border-ws-sep bg-ws-win px-3 py-2 text-left hover:border-ws-sep2">
            <span className="flex min-w-0 items-center gap-2">
              <b className="min-w-0 truncate font-semibold">{runTitle(r, title)}</b>
              <span className="ml-auto shrink-0">
                <StateChip run={r} now={now} />
              </span>
            </span>
            <span className="truncate text-sm text-ws-ink2">{r.state === "working" || r.state === "launching" || r.state === "queued" ? progressText(r) : (r.needs ?? r.result ?? r.error ?? "").split("\n")[0]}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The runs on a ticket, for the peek. Opening one leaves the person on the board. */
export function TicketAgents({ item, title }: { item: ItemRef; title: string }) {
  const runs = useRuns((s) => s.runs);
  const mine = runsOfTicket(runs, item);
  return <TicketAgentRows runs={mine} now={Date.now()} title={title} onOpen={(id) => useRuns.getState().openRun(id, { stay: true })} />;
}
