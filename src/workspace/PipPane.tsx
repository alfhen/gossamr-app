import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Markdown } from "../components/Markdown";
import { draftsForTurn, targetOf } from "../lib/proposals";
import { itemKey } from "../lib/filter";
import { useClaude, type Turn } from "../claudeStore";
import type { Proposal } from "../types";
import { draftStatus } from "./boardLogic";
import { draftSummary, draftTitle, LiveDraftCard } from "./DraftCard";
import { useActiveTab } from "./hooks";
import { showMe } from "./jump";
import { PipAvatar } from "./PipAvatar";
import { buildScreenContext, screenLine } from "./screenContext";
import { useTabs } from "./tabsStore";
import { itemsByFilter, pendingDrafts, useItemsByFilter, useWorkspace, workflowOfItem } from "../workspaceStore";

export const PIP_INPUT_ID = "pip-input";
const CONVERSATION = "workspace";

/** The screen as Pip is told about it, read fresh so a question is asked about what is on screen now. */
function liveScreen() {
  const tabs = useTabs.getState();
  const ws = useWorkspace.getState();
  const tab = tabs.tabs.find((t) => t.id === tabs.activeId) ?? tabs.tabs[0];
  const shown = itemsByFilter(ws, tab.filter);
  return { tab, shown, items: ws.items, containers: ws.containers, selected: tabs.selected, marked: tabs.marked };
}

export function ContextChip({ line, open }: { line: string; open: string | null }) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-1.5 border-b border-ws-sep px-4 py-2 text-sm text-ws-ink3">
      <span>Pip sees</span>
      <span className="rounded-full bg-ws-pip-soft px-2 py-px font-semibold text-ws-pip">{line}</span>
      {open && <span className="rounded-full bg-ws-pip-soft px-2 py-px font-mono font-semibold text-ws-pip">{open}</span>}
    </p>
  );
}

export function DraftRow({ proposal: p, statusName, onShow, expanded }: { proposal: Proposal; statusName: string | null; onShow(): void; expanded?: ReactNode }) {
  return (
    <li className="grid gap-1.5">
      <div className="grid gap-0.5 rounded-lg border border-dashed border-ws-pip bg-ws-pip-soft px-2.5 py-1.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate font-semibold">{draftTitle(p)}</span>
          <button type="button" onClick={onShow} className="ml-auto shrink-0 text-sm text-ws-pip hover:underline">
            {targetOf(p.intent) ? "Show me" : "Review"}
          </button>
        </div>
        <p className="m-0 truncate text-sm text-ws-ink2">{draftSummary(p, statusName)}</p>
      </div>
      {expanded}
    </li>
  );
}

function Drafts() {
  const proposals = useWorkspace((s) => s.proposals);
  const items = useWorkspace((s) => s.items);
  const containers = useWorkspace((s) => s.containers);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const open = useMemo(() => pendingDrafts({ proposals }), [proposals]);
  if (!open.length) return null;
  return (
    <section aria-label="Drafts" className="grid gap-1.5">
      <h3 className="m-0 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">
        Drafts waiting <span className="font-normal">{open.length}</span>
      </h3>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {open.map((p) => {
          const target = targetOf(p.intent);
          const item = target ? items[itemKey(target)] : undefined;
          const status = item && p.intent.type === "transition" ? draftStatus(p, workflowOfItem({ containers }, item))?.name : null;
          return (
            <DraftRow
              key={p.id}
              proposal={p}
              statusName={status ?? null}
              onShow={() => (target ? showMe(target) : setReviewing(reviewing === p.id ? null : p.id))}
              expanded={reviewing === p.id ? <LiveDraftCard proposal={p} /> : undefined}
            />
          );
        })}
      </ul>
    </section>
  );
}

function TurnView({ turn, proposals }: { turn: Turn; proposals: Proposal[] }) {
  const drafts = draftsForTurn(proposals, turn.requestId);
  return (
    <div className="grid gap-2">
      <div className="max-w-[85%] justify-self-end rounded-[14px_14px_4px_14px] bg-ws-accent px-3 py-1.5 whitespace-pre-wrap text-white [overflow-wrap:anywhere]">{turn.prompt}</div>
      {(turn.steps.length > 0 || (turn.status === "running" && !turn.text)) && (
        <ul className="m-0 grid list-none gap-1 p-0 text-sm text-ws-ink2">
          {turn.steps.map((s, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-ws-done" />
              {s}
            </li>
          ))}
          {turn.status === "running" && !turn.text && <li className="animate-pulse text-ws-ink3">Working…</li>}
        </ul>
      )}
      {turn.text && (
        <div className="ws-legacy">
          <Markdown text={turn.text} />
        </div>
      )}
      {drafts.map((p) => (
        <LiveDraftCard key={p.id} proposal={p} />
      ))}
      {turn.status === "failed" && (
        <p role="alert" className="m-0 rounded-md bg-ws-blocked-soft px-3 py-2 text-ws-blocked">
          {turn.error ?? "Pip stopped"}
        </p>
      )}
    </div>
  );
}

const suggestions = (hasItem: boolean) => ["Show stale tickets", "What is blocked?", ...(hasItem ? ["Draft a comment on this one"] : ["Show my tickets"])];

/** Docked to the right of the canvas: the conversation with Pip, and every draft waiting on a decision. */
export function PipPane({ onClose }: { onClose(): void }) {
  const tab = useActiveTab();
  const shown = useItemsByFilter(tab.filter);
  const items = useWorkspace((s) => s.items);
  const containers = useWorkspace((s) => s.containers);
  const selected = useTabs((s) => s.selected);
  const conv = useClaude((s) => s.byTicket[CONVERSATION]);
  const proposals = useWorkspace((s) => s.proposals);
  const turns = conv?.turns ?? [];
  const running = turns.some((t) => t.status === "running");
  const [input, setInput] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const proposalList = useMemo(() => Object.values(proposals), [proposals]);
  const line = screenLine({ tab, shown, containers });
  const open = selected && items[selected] ? items[selected].item.key : null;

  useEffect(() => {
    document.getElementById(PIP_INPUT_ID)?.focus();
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [turns, proposals]);

  const ask = (prompt: string) => {
    const text = prompt.trim();
    if (!text || running) return;
    setInput("");
    void useClaude.getState().ask(CONVERSATION, text, conv?.sessionId ?? null, conv?.cwd ?? null, buildScreenContext(liveScreen()));
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    ask(input);
  };

  return (
    <aside aria-label="Pip" className="ws-legacy flex min-h-0 flex-col border-l border-ws-sep bg-ws-bar">
      <header data-tauri-drag-region className="flex items-center gap-2 border-b border-ws-sep px-4 pt-[14px] pb-2.5">
        <PipAvatar size={26} />
        <div className="grid leading-tight">
          <h2 className="m-0 text-base font-semibold">Pip</h2>
          <span className="text-xs text-ws-ink3">powered by Claude</span>
        </div>
        <button type="button" aria-label="Close Pip" onClick={onClose} className="ml-auto rounded px-1.5 text-lg leading-none text-ws-ink3 hover:bg-ws-hover">
          ×
        </button>
      </header>
      <ContextChip line={line} open={open} />
      <div ref={bodyRef} className="grid min-h-0 flex-1 content-start gap-4 overflow-auto px-4 py-3">
        <Drafts />
        {turns.length === 0 && (
          <div className="grid gap-2">
            <p className="m-0 text-ws-ink2">Ask about what is on screen. I can filter this view and draft comments, moves and subtasks. Nothing changes until you approve.</p>
            <div className="flex flex-wrap gap-1.5">
              {suggestions(!!open).map((s) => (
                <button key={s} type="button" onClick={() => ask(s)} className="rounded-full border border-ws-sep2 px-2.5 py-1 text-sm hover:bg-ws-hover">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t) => (
          <TurnView key={t.requestId} turn={t} proposals={proposalList} />
        ))}
      </div>
      <form onSubmit={submit} className="flex gap-2 border-t border-ws-sep p-3">
        <input
          id={PIP_INPUT_ID}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="Ask Pip"
          placeholder="Ask about what you're looking at…"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-ws-sep2 bg-ws-win px-2.5 py-1.5"
        />
        {running ? (
          <button type="button" onClick={() => useClaude.getState().cancel(CONVERSATION)} className="rounded-md border border-ws-sep2 px-3 font-semibold">
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()} className="rounded-md bg-ws-pip px-3 font-semibold text-ws-on-pip disabled:opacity-45">
            Ask
          </button>
        )}
      </form>
    </aside>
  );
}
