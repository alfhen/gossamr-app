import { showOf } from "../lib/keys";
import { useEffect, useState } from "react";
import { claude, type PipView } from "../backend/claude";
import { useClaude } from "../claudeStore";
import { isPaneConversation } from "../lib/conversations";
import { PipGlyph } from "../components/PipGlyph";
import { needsYouText, useNeedsYou } from "./useNeeds";
import { useActiveTab } from "./hooks";
import { PipAvatar } from "./PipAvatar";
import { PipWorkChip } from "./PipWork";
import { usePaneWidths } from "./PaneResizers";
import { isStillFiltered, usePip, type PipFiltered } from "./pipStore";
import { usePrefs } from "./prefs";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { focusedConversation } from "./workstreamsStore";
import { Button } from "../components/Button";

/** The line under the filter bar after Pip narrowed the view; hidden once the person edits the filter themselves. */
export function PipFilterNote({ filtered, onUndo, onDismiss }: { filtered: PipFiltered; onUndo(): void; onDismiss(): void }) {
  return (
    <div role="status" className="mx-6 mb-1 flex items-center gap-2 rounded-md bg-ws-pip-soft px-3 py-1 text-sm text-ws-pip">
      <PipGlyph />
      <span className="min-w-0 truncate">
        <b>Pip filtered this view</b>
        {filtered.note && <span className="text-ws-ink2"> · {filtered.note}</span>}
      </span>
      <Button variant="quiet" size="sm" className="ml-auto shrink-0" onClick={onUndo}>
        Undo
      </Button>
      <Button variant="quiet" size="sm" iconOnly className="shrink-0" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </Button>
    </div>
  );
}

/** While the pane is open the same Undo sits in the conversation, so the line only shows when the pane is closed. */
export function FilterNote() {
  const tab = useActiveTab();
  const filtered = usePip((s) => s.filtered);
  const paneOpen = usePrefs((s) => s.pipOpen);
  if (paneOpen || !isStillFiltered(filtered, tab)) return null;
  return <PipFilterNote filtered={filtered} onUndo={() => usePip.getState().undoFilter()} onDismiss={() => usePip.getState().clearFiltered()} />;
}

/**
 * Applies a filter Pip asked for, but only for a question asked in the focused conversation: the one the pane shows
 * (General or the focused workstream's). Other conversations don't get to change the
 * view, and a filter only ever changes the workspace tab's filter.
 */
export function handlePipView({ requestId, filter, note }: PipView) {
  const asked = useClaude.getState().byTicket[focusedConversation()]?.turns.some((t) => t.requestId === requestId);
  if (asked) usePip.getState().applyFilter(filter, note, requestId);
}

export function usePipView() {
  useEffect(() => claude.onPipView(handlePipView), []);
}

/**
 * How far the canvases' lists scroll on past their last row while the launcher floats over them, published on <main>
 * as `--ws-launcher-clear`: the launcher's height and a margin, so no row stays under it.
 */
export const LAUNCHER_CLEAR = 112;

/**
 * How far in from the canvas's right edge a screen whose cards fill its width keeps them while the launcher floats over it,
 * published on <main> as `--ws-launcher-gutter`: the launcher's width (74px), its right margin (20px) and a little air.
 * The Agents screen uses it, so a card or a lane's "Show" link never stands under the launcher.
 */
export const LAUNCHER_GUTTER = 104;

/** Keeps the launcher clear of the footer and, while the ticket peek is open, of the peek. */
export const launcherStyle = (clearRight = 0) => ({ right: `calc(${clearRight}px + 1.25rem)`, bottom: "calc(var(--ws-footer-h, 2rem) + 0.75rem)" });

export function Launcher({ needs, onOpen, thinking = false, clearRight = 0 }: { needs: number; onOpen(): void; thinking?: boolean; clearRight?: number }) {
  return (
    <div data-pip-launcher style={launcherStyle(clearRight)} className="absolute z-30 flex max-w-[calc(100%-2.5rem)] items-center gap-2.5">
      {thinking && <PipWorkChip />}
      <div className="relative">
        <i aria-hidden className="pip-thread pointer-events-none absolute bottom-full left-1/2 h-[46px] w-[1.5px] -translate-x-1/2 opacity-60" />
        <button
          type="button"
          onClick={onOpen}
          aria-label={needs ? `Ask Pip, ${needsYouText(needs)}` : "Ask Pip"}
          title={`Ask Pip (${showOf("app", "pip")})`}
          className="pip-launch relative grid size-16 place-items-center [filter:drop-shadow(0_6px_8px_rgb(95_84_184/0.3))]"
        >
          <PipAvatar size={64} dangle thinking={thinking} />
          {needs > 0 && (
            <span className="absolute -top-0.5 -right-0.5 grid h-5 min-w-5 place-items-center rounded-full border-2 border-ws-win bg-(--prominent) px-1 text-xs font-bold text-white">{needs}</span>
          )}
        </button>
      </div>
    </div>
  );
}

/** The floating way in while the pane is closed. */
export function PipLauncher() {
  const thinking = useClaude((s) => Object.entries(s.byTicket).some(([id, c]) => isPaneConversation(id) && c.turns.some((t) => t.status === "running")));
  const needs = useNeedsYou().length;
  const peekOpen = useTabs((s) => !!s.selected && s.marked.length <= 1);
  const peekWidth = usePaneWidths().peek;
  // An agent sheet's own buttons sit where the launcher does: it steps aside while one is open.
  const runSheetOpen = useRuns((s) => s.sheet !== null);
  if (runSheetOpen) return null;
  return <Launcher clearRight={peekOpen ? peekWidth : 0} needs={needs} thinking={thinking} onOpen={() => usePrefs.getState().setPipOpen(true)} />;
}

const MIN_SELECTION = 4;
const ASK_WIDTH = 120;

/** Where the "Ask Pip" button goes for a selection: above its start, kept on screen. */
export const askPlacement = (rect: { left: number; top: number }, viewportWidth: number) => ({
  x: Math.max(8, Math.min(rect.left, viewportWidth - ASK_WIDTH)),
  y: Math.max(8, rect.top - 32),
});

export function AskPipButton({ x, y, onAsk }: { x: number; y: number; onAsk(): void }) {
  return (
    <button
      type="button"
      // Keeps the selection alive until the click has read it.
      onMouseDown={(ev) => {
        ev.preventDefault();
        onAsk();
      }}
      style={{ left: x, top: y }}
      className="ws-glass ws-glass-pip ws-glass-regular fixed z-40 rounded-[14px] px-2.5 py-0.5 text-sm font-semibold text-ws-ink"
    >
      <PipGlyph className="text-ws-pip" /> Ask Pip
    </button>
  );
}

const within = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest("#peek-sheet");

/** Selecting text in the peek sheet offers to ask Pip about it, while Pip follows the screen. */
export function SelectionAsk() {
  const following = usePip((s) => s.pinned === null);
  const [ask, setAsk] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    const read = () => {
      const sel = getSelection();
      const text = sel?.toString().trim() ?? "";
      if (!sel || sel.isCollapsed || text.length < MIN_SELECTION || !within(sel.anchorNode)) return setAsk(null);
      setAsk({ ...askPlacement(sel.getRangeAt(0).getBoundingClientRect(), innerWidth), text });
    };
    const onUp = () => setTimeout(read, 0);
    const onChange = () => getSelection()?.isCollapsed && setAsk(null);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);

  if (!ask || !following) return null;
  return (
    <AskPipButton
      x={ask.x}
      y={ask.y}
      onAsk={() => {
        usePip.getState().askAbout(ask.text);
        getSelection()?.removeAllRanges();
        setAsk(null);
      }}
    />
  );
}
