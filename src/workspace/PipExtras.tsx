import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { claude, type PipView } from "../backend/claude";
import { useClaude } from "../claudeStore";
import { pendingDrafts, useWorkspace } from "../workspaceStore";
import { useActiveTab } from "./hooks";
import { nudgeCandidates, nudgeDelay, NUDGE_SHOWN_MS, pickNudge, type Nudge, type NudgeScene } from "./nudges";
import { WORKSPACE_CONVERSATION } from "./PipPane";
import { PipAvatar } from "./PipAvatar";
import { lookAt } from "./pipGaze";
import { chipCount, unassignedIn, useItemScene, useScreen } from "./pipHooks";
import { usePaneWidths } from "./PaneResizers";
import { isStillFiltered, usePip, type PipFiltered } from "./pipStore";
import { usePrefs } from "./prefs";
import { useTabs } from "./tabsStore";

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

/** While the pane is open the same Undo sits in the conversation, so the line only shows when the pane is closed. */
export function FilterNote() {
  const tab = useActiveTab();
  const filtered = usePip((s) => s.filtered);
  const paneOpen = usePrefs((s) => s.pipOpen);
  if (paneOpen || !isStillFiltered(filtered, tab)) return null;
  return <PipFilterNote filtered={filtered} onUndo={() => usePip.getState().undoFilter()} onDismiss={() => usePip.getState().clearFiltered()} />;
}

/** Applies a filter Pip asked for, but only for a question asked in this pane; other conversations don't get to change the view. */
export function handlePipView({ requestId, filter, note }: PipView) {
  const asked = useClaude.getState().byTicket[WORKSPACE_CONVERSATION]?.turns.some((t) => t.requestId === requestId);
  if (asked) usePip.getState().applyFilter(filter, note, requestId);
}

export function usePipView() {
  useEffect(() => claude.onPipView(handlePipView), []);
}

export function Nudge({ text, onOpen, onDismiss, onHold }: { text: string; onOpen(): void; onDismiss(): void; onHold?(held: boolean): void }) {
  return (
    <div
      className="pip-pop relative max-w-[250px] rounded-[14px_14px_4px_14px] border border-ws-sep2 bg-ws-win py-2 pr-7 pl-3 text-sm shadow-ws-pop hover:border-ws-pip"
      onPointerEnter={() => onHold?.(true)}
      onPointerLeave={() => onHold?.(false)}
      onFocus={() => onHold?.(true)}
      onBlur={() => onHold?.(false)}
    >
      <button type="button" onClick={onOpen} className="text-left">
        {text}
      </button>
      <button type="button" aria-label="Dismiss suggestion" onClick={onDismiss} className="absolute top-1 right-1.5 rounded px-1 text-lg leading-none text-ws-ink3 hover:bg-ws-hover">
        ×
      </button>
    </div>
  );
}

/** Keeps the launcher clear of the footer and, while the ticket peek is open, of the peek. */
export const launcherStyle = (clearRight = 0) => ({ right: `calc(${clearRight}px + 1.25rem)`, bottom: "calc(var(--ws-footer-h, 2rem) + 0.75rem)" });

export function Launcher({ drafts, onOpen, nudge, thinking = false, clearRight = 0 }: { drafts: number; onOpen(): void; nudge: ReactNode; thinking?: boolean; clearRight?: number }) {
  const bubble = useRef<HTMLDivElement>(null);
  const showing = !!nudge;
  useEffect(() => {
    if (showing) requestAnimationFrame(() => lookAt(bubble.current));
  }, [showing]);
  return (
    <div style={launcherStyle(clearRight)} className="absolute z-30 flex max-w-[calc(100%-2.5rem)] items-center gap-2.5">
      <div ref={bubble}>{nudge}</div>
      <div className="relative">
        <i aria-hidden className="pip-thread pointer-events-none absolute bottom-full left-1/2 h-[46px] w-[1.5px] -translate-x-1/2 opacity-60" />
        <button
          type="button"
          onClick={onOpen}
          aria-label={drafts ? `Ask Pip, ${drafts} draft${drafts === 1 ? "" : "s"} waiting` : "Ask Pip"}
          title="Ask Pip (⌘J)"
          className="relative grid size-16 place-items-center [filter:drop-shadow(0_6px_8px_rgb(91_75_209/0.35))] transition-transform duration-200 hover:scale-[1.08] hover:-rotate-3"
        >
          <PipAvatar size={64} dangle thinking={thinking} />
          {drafts > 0 && (
            <span className="absolute -top-0.5 -right-0.5 grid h-5 min-w-5 place-items-center rounded-full border-2 border-ws-win bg-ws-accent px-1 text-xs font-bold text-white">{drafts}</span>
          )}
        </button>
      </div>
    </div>
  );
}

function act(n: Nudge) {
  const pip = usePip.getState();
  pip.dismiss(n.id);
  switch (n.action.type) {
    case "ask":
      pip.openWith(n.action.prompt);
      break;
    case "filter":
      pip.applyFilter(n.action.filter, n.action.note);
      break;
    case "open":
      usePrefs.getState().setPipOpen(true);
      break;
  }
}

function NudgeBubble({ nudge }: { nudge: Nudge }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const t = setTimeout(() => usePip.getState().hideNudge(), NUDGE_SHOWN_MS);
    return () => clearTimeout(t);
  }, [held, nudge.id]);
  return <Nudge text={nudge.text} onOpen={() => act(nudge)} onDismiss={() => usePip.getState().dismiss(nudge.id)} onHold={setHeld} />;
}

/** Shows the first suggestion that is still allowed, unless one is up already or the page is hidden. */
export function fireNudge(candidates: readonly Nudge[], now: number, hidden: boolean) {
  const pip = usePip.getState();
  const next = pip.nudge || hidden ? null : pickNudge(candidates, pip.dismissed, pip.seen);
  if (next) pip.showNudge(next, now);
}

/** Picks suggestions for what is on screen: once the person has stayed put a moment, never one they closed, each only once a session and not too soon after the last. */
function useNudges() {
  const screen = useScreen();
  const item = useItemScene(screen);
  const scene: NudgeScene = useMemo(
    () => ({ route: screen.route, filter: screen.tab.filter, count: screen.shown.length, chips: chipCount(screen), item, unassignedInView: unassignedIn(screen.shown) }),
    [screen, item],
  );
  const candidates = useMemo(() => nudgeCandidates(scene), [scene]);
  const key = candidates.map((c) => c.id).join("|");
  // The timer fires up to a gap after `key` changed; the text or filter behind an unchanged id may have moved on since.
  const latest = useRef(candidates);
  latest.current = candidates;

  useEffect(() => {
    const pip = usePip.getState();
    if (pip.nudge && !candidates.some((c) => c.id === pip.nudge!.id)) pip.hideNudge();
    const timer = setTimeout(() => fireNudge(latest.current, Date.now(), document.hidden), nudgeDelay(Date.now(), pip.lastNudgeAt));
    return () => clearTimeout(timer);
  }, [key]);

  useEffect(() => () => usePip.getState().hideNudge(), []);
}

/** The floating way in while the pane is closed, with a suggestion when something on screen calls for one. */
export function PipLauncher() {
  const proposals = useWorkspace((s) => s.proposals);
  const nudge = usePip((s) => s.nudge);
  const thinking = useClaude((s) => !!s.byTicket[WORKSPACE_CONVERSATION]?.turns.some((t) => t.status === "running"));
  const drafts = pendingDrafts({ proposals }).length;
  const peekOpen = useTabs((s) => !!s.selected && s.marked.length <= 1);
  const peekWidth = usePaneWidths().peek;
  useNudges();
  return <Launcher clearRight={peekOpen ? peekWidth : 0} drafts={drafts} thinking={thinking} onOpen={() => usePrefs.getState().setPipOpen(true)} nudge={nudge && <NudgeBubble nudge={nudge} />} />;
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
      className="fixed z-40 rounded-[14px] bg-gradient-to-br from-ws-pip to-ws-pip2 px-2.5 py-0.5 text-sm font-semibold text-ws-on-pip shadow-ws-pop"
    >
      ✦ Ask Pip
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
