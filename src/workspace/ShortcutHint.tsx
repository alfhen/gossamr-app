import type { ViewMode } from "./tabsStore";

const LEAD: Partial<Record<ViewMode, string>> = {
  board: "Drag a card to draft a status change. ",
  map: "Scroll to zoom, drag to pan. ",
};

export function ShortcutHint({ view }: { view: ViewMode }) {
  const k = "font-sans text-[11px] rounded border border-ws-sep2 bg-ws-bar px-1";
  return (
    <p className="m-0 shrink-0 px-6 py-1.5 text-center text-xs text-ws-ink3">
      {LEAD[view]}
      <kbd className={k}>j</kbd> <kbd className={k}>k</kbd> move and peek · <kbd className={k}>Esc</kbd> close · <kbd className={k}>⌘J</kbd> Pip · <kbd className={k}>⌘K</kbd> jump
    </p>
  );
}
