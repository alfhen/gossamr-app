import { useEffect, type ReactNode } from "react";
import { filterChips } from "../lib/filter";
import { claude, type PipView } from "../backend/claude";
import { useClaude } from "../claudeStore";
import { pendingDrafts, useItemsByFilter, useWorkspace } from "../workspaceStore";
import { useActiveTab } from "./hooks";
import { PIP_INPUT_ID, WORKSPACE_CONVERSATION } from "./PipPane";
import { PipAvatar } from "./PipAvatar";
import { isStillFiltered, nudgeFor, usePip, type PipFiltered } from "./pipStore";
import { usePrefs } from "./prefs";

/** The line under the filter bar after Pip narrowed the view; hidden once the person edits the filter themselves. */
export function PipFilterNote({ filtered, onUndo, onDismiss }: { filtered: PipFiltered; onUndo(): void; onDismiss(): void }) {
  return (
    <div role="status" className="mx-6 mb-1 flex items-center gap-2 rounded-md bg-ws-pip-soft px-3 py-1 text-sm text-ws-pip">
      <span aria-hidden>✦</span>
      <span className="min-w-0 truncate">
        <b>Pip filtered this view</b>
        {filtered.note && <span className="text-ws-ink2"> · {filtered.note}</span>}
      </span>
      <button type="button" onClick={onUndo} className="ml-auto shrink-0 font-semibold underline">
        Undo
      </button>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="shrink-0 rounded px-1 text-lg leading-none opacity-70 hover:opacity-100">
        ×
      </button>
    </div>
  );
}

export function FilterNote() {
  const tab = useActiveTab();
  const filtered = usePip((s) => s.filtered);
  if (!isStillFiltered(filtered, tab)) return null;
  return <PipFilterNote filtered={filtered} onUndo={() => usePip.getState().undoFilter()} onDismiss={() => usePip.getState().clearFiltered()} />;
}

/** Applies a filter Pip asked for, but only for a question asked in this pane; other conversations don't get to change the view. */
export function handlePipView({ requestId, filter, note }: PipView) {
  const asked = useClaude.getState().byTicket[WORKSPACE_CONVERSATION]?.turns.some((t) => t.requestId === requestId);
  if (asked) usePip.getState().applyFilter(filter, note);
}

export function usePipView() {
  useEffect(() => claude.onPipView(handlePipView), []);
}

export function Nudge({ text, onOpen, onDismiss }: { text: string; onOpen(): void; onDismiss(): void }) {
  return (
    <div className="relative max-w-64 rounded-[14px_14px_4px_14px] border border-ws-sep2 bg-ws-win py-2 pr-7 pl-3 text-sm shadow-ws-pop">
      <button type="button" onClick={onOpen} className="text-left hover:text-ws-pip">
        {text}
      </button>
      <button type="button" aria-label="Dismiss suggestion" onClick={onDismiss} className="absolute top-1 right-1.5 rounded px-1 text-lg leading-none text-ws-ink3 hover:bg-ws-hover">
        ×
      </button>
    </div>
  );
}

export function Launcher({ drafts, onOpen, nudge }: { drafts: number; onOpen(): void; nudge: ReactNode }) {
  return (
    <div className="absolute right-4 bottom-4 z-30 flex flex-col items-end gap-2">
      {nudge}
      <button
        type="button"
        onClick={onOpen}
        aria-label={drafts ? `Ask Pip, ${drafts} draft${drafts === 1 ? "" : "s"} waiting` : "Ask Pip"}
        title="Ask Pip (⌘J)"
        className="relative grid size-12 place-items-center rounded-full border border-ws-sep2 bg-ws-win shadow-ws-pop hover:border-ws-pip"
      >
        <PipAvatar size={34} />
        {drafts > 0 && (
          <span className="absolute -top-1 -right-1 grid min-w-5 place-items-center rounded-full bg-ws-pip px-1 text-xs font-bold text-ws-on-pip">{drafts}</span>
        )}
      </button>
    </div>
  );
}

/** The floating way in while the pane is closed, with a suggestion when the view could use a filter. */
export function PipLauncher() {
  const tab = useActiveTab();
  const shown = useItemsByFilter(tab.filter);
  const proposals = useWorkspace((s) => s.proposals);
  const dismissed = usePip((s) => s.dismissed);
  const drafts = pendingDrafts({ proposals }).length;
  const chips = tab.filter.type === "and" && !tab.filter.filters.length ? 0 : filterChips(tab.filter).length;
  const nudge = nudgeFor(shown.length, chips, dismissed);
  const open = () => {
    usePrefs.getState().setPipOpen(true);
    requestAnimationFrame(() => document.getElementById(PIP_INPUT_ID)?.focus());
  };
  return (
    <Launcher
      drafts={drafts}
      onOpen={open}
      nudge={nudge && <Nudge text={nudge.text} onOpen={open} onDismiss={() => usePip.getState().dismiss(nudge.kind)} />}
    />
  );
}
