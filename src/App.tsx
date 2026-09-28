import { useEffect } from "react";
import { ItemList } from "./components/ItemList";
import { CommandPalette, ShortcutHelp, ToastHost } from "./components/Overlays";
import { Sidebar } from "./components/Sidebar";
import { TicketDetail } from "./components/TicketDetail";
import { commandFor, isTypingTarget } from "./lib/keyboard";
import { currentItems, selectedTicket, useStore } from "./store";

export default function App() {
  const snap = useStore((s) => s.snap);
  const overlay = useStore((s) => s.overlay);
  useKeyboard();
  useClock();
  useSelectionFallback();

  if (!snap) {
    return <div className="grid h-full place-items-center text-ink-3">Loading…</div>;
  }

  return (
    <div className="grid h-full grid-cols-[210px_370px_1fr] overflow-hidden max-[1040px]:grid-cols-[320px_1fr]">
      <Sidebar />
      <ItemList />
      <TicketDetail />
      {overlay === "palette" && <CommandPalette />}
      {overlay === "help" && <ShortcutHelp />}
      <ToastHost />
    </div>
  );
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const s = useStore.getState();
      const typing = isTypingTarget(ev.target);
      const cmd = commandFor({ key: ev.key, metaKey: ev.metaKey, ctrlKey: ev.ctrlKey, altKey: ev.altKey, typing });
      if (!cmd) return;
      if (cmd === "escape") {
        if (s.overlay) s.openOverlay(null);
        else if (typing) (ev.target as HTMLElement).blur();
        return;
      }
      if (s.overlay && cmd !== "palette") return;
      ev.preventDefault();
      switch (cmd) {
        case "next":
          return s.move(1);
        case "prev":
          return s.move(-1);
        case "transition":
          return s.openOverlay("transition");
        case "snooze":
          return s.openOverlay("snooze");
        case "done":
          return void s.markDone();
        case "toggleUnread":
          return void s.toggleUnread();
        case "comment":
          return document.getElementById("composer")?.focus();
        case "open": {
          const t = selectedTicket(s);
          return t && void s.backend?.openUrl(t.url);
        }
        case "palette":
          return s.openOverlay(s.overlay === "palette" ? null : "palette");
        case "help":
          return s.openOverlay("help");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Keeps relative times and snooze expiry current. */
function useClock() {
  const tick = useStore((s) => s.tick);
  useEffect(() => {
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [tick]);
}

/**
 * Selects the first item when nothing is selected yet (e.g. the first sync just arrived), or when the selected
 * inbox item leaves the list (done, snoozed, filtered out).
 */
function useSelectionFallback() {
  const state = useStore();
  const items = currentItems(state);
  const { selectedId, select } = state;
  const missing = (!selectedId || selectedId.startsWith("e:")) && !items.some((i) => i.id === selectedId);
  const first = items[0]?.id ?? null;
  useEffect(() => {
    if (missing) select(first);
  }, [missing, first, select]);
}
