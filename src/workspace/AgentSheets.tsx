import { useEffect, useMemo, useState } from "react";
import { useBackend } from "../backend/useBackend";
import { itemKey } from "../lib/filter";
import { useWorkspace } from "../workspaceStore";
import { AgentsSettingsView } from "./AgentsSettings";
import { agentTicketChoices } from "./commands";
import { PaletteView } from "./Palette";
import { RunSetup } from "./RunSetup";
import { RunSheet } from "./RunSheet";
import { useRunSetup } from "./runSetupStore";
import { stoppable } from "./agentsLogic";
import { sheetKey } from "./runSheetLogic";
import { useRuns } from "./runsStore";

/** Concurrency the backend enforces; shown, not changed, here. */
const CAP = 3;

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || !!t.closest("input, textarea, select, [contenteditable], [data-esc-local]"));

function Settings() {
  const backend = useBackend();
  const runs = useRuns((s) => s.runs);
  const stopping = useRuns((s) => s.stopping);
  const [keepRunning, setKeepRunning] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    backend?.runsKeepRunning().then((n) => live && setKeepRunning(n), () => {});
    return () => {
      live = false;
    };
  }, [backend, runs]);
  return <AgentsSettingsView runs={runs} stopping={stopping} keepRunning={keepRunning ?? (stoppable(runs).length || null)} cap={CAP} onStopAll={() => void useRuns.getState().stopAll()} onClose={() => useRuns.getState().closeSheet()} />;
}

/** Asks which ticket to start an agent on. Picking opens the setup sheet; nothing is drafted before that. */
export function AgentTicketPicker() {
  const items = useWorkspace((s) => s.items);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => void (opener?.isConnected && opener.focus()), [opener]);
  const results = useMemo(
    () =>
      agentTicketChoices(Object.values(items), query, (item) => {
        useRuns.getState().setPicking(false);
        void useRunSetup.getState().begin({ item: item?.item ?? null });
      }),
    [items, query],
  );
  const close = () => useRuns.getState().setPicking(false);
  return (
    <PaletteView
      query={query}
      results={results}
      active={Math.min(active, Math.max(0, results.length - 1))}
      placeholder="Which ticket should the agent work on?"
      empty="No ticket matches. Choose “No ticket” to describe a free-form task."
      hints={["↑↓ move", "↵ choose", "esc close"]}
      onQuery={(q) => (setQuery(q), setActive(0))}
      onActive={setActive}
      onRun={(c) => c.run()}
      onClose={close}
    />
  );
}

/** Whichever sheet the Agents feature has open over the screen, and the keys that go with it. */
export function AgentSheets() {
  const setupOpen = useRunSetup((s) => s.open);
  const setupItem = useRunSetup((s) => s.item);
  const sheet = useRuns((s) => s.sheet);
  const picking = useRuns((s) => s.picking);
  const ticketTitle = useWorkspace((s) => (setupItem ? (s.items[itemKey(setupItem)]?.title ?? null) : null));
  const runSheetOpen = !setupOpen && sheet !== null;

  useEffect(() => {
    if (!runSheetOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      const store = useRuns.getState();
      const action = sheetKey(ev.key, { typing: typing(ev.target), modifier: ev.metaKey || ev.ctrlKey || ev.altKey, pickerOpen: !!document.querySelector("[role=combobox]"), browsing: store.sheet?.type === "run" });
      if (!action) return;
      ev.preventDefault();
      if (action === "close") store.closeSheet();
      else store.browse(action === "next" ? 1 : -1);
    };
    // Captured so the ticket peek behind the sheet doesn't also close on the same key.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [runSheetOpen]);

  return (
    <>
      {setupOpen ? <RunSetup ticketTitle={ticketTitle} /> : sheet?.type === "run" ? <RunSheet key={sheet.id} id={sheet.id} /> : sheet?.type === "safety" ? <Settings /> : null}
      {picking && <AgentTicketPicker />}
    </>
  );
}
