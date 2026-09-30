import { useEffect, useMemo } from "react";
import { listenToClaude } from "../claudeStore";
import type { Backend } from "../backend/types";
import { TicketLinksContext } from "../components/ticketLinks";
import { useItemsByFilter, useWorkspace } from "../workspaceStore";
import { ActivityView } from "./ActivityView";
import { useActivity } from "./activityStore";
import { CANVASES } from "./canvases";
import { useStepKeys } from "./browse";
import { itemKey } from "../lib/filter";
import { workspaceTicketLinks } from "./jump";
import { FilterBar } from "./FilterBar";
import { useActiveTab } from "./hooks";
import { MAIN_ID, Palette } from "./Palette";
import { PeekSheet } from "./PeekSheet";
import { FilterNote, PipLauncher, SelectionAsk, usePipView } from "./PipExtras";
import { PipPane } from "./PipPane";
import { applyTheme, usePrefs } from "./prefs";
import { Rail } from "./Rail";
import { Settings } from "./Settings";
import { ShortcutHint } from "./ShortcutHint";
import { TabBar } from "./TabBar";
import { ToastHost } from "./ToastHost";
import { useTabs } from "./tabsStore";

function Canvas() {
  const tab = useActiveTab();
  const items = useItemsByFilter(tab.filter);
  const anything = useWorkspace((s) => Object.keys(s.items).length > 0);
  const connection = useWorkspace((s) => s.connections[0]);
  const View = CANVASES[tab.view];
  const filterOrder = useMemo(() => items.map((i) => itemKey(i.item)), [items]);
  useStepKeys(filterOrder);
  if (!anything) {
    const waiting = !connection || connection.syncing || (!connection.lastSyncAt && !connection.error);
    return (
      <div role="status" className="grid h-full place-items-center p-10 text-center text-ws-ink3">
        <p>{waiting ? "Fetching your tickets for the first time. This can take a minute." : "No tickets are cached yet. Use Sync now in Settings to try again."}</p>
      </div>
    );
  }
  return <View tab={tab} items={items} />;
}

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey) return;
      const prefs = usePrefs.getState();
      if (ev.key === "k") {
        ev.preventDefault();
        prefs.setPaletteOpen(!prefs.paletteOpen);
      } else if (ev.key === "j") {
        ev.preventDefault();
        prefs.setPipOpen(!prefs.pipOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function Workspace({ backend }: { backend: Backend }) {
  const status = useWorkspace((s) => s.status);
  const error = useWorkspace((s) => s.error);
  const route = useTabs((s) => s.route);
  const theme = usePrefs((s) => s.theme);
  const view = useActiveTab().view;
  const pipOpen = usePrefs((s) => s.pipOpen);
  const paletteOpen = usePrefs((s) => s.paletteOpen);
  const setPipOpen = usePrefs((s) => s.setPipOpen);
  useGlobalKeys();
  usePipView();

  useEffect(() => listenToClaude(), []);

  useEffect(() => {
    applyTheme(theme);
    return () => applyTheme("auto");
  }, [theme]);

  useEffect(() => {
    useWorkspace.getState().init(backend).catch(() => {});
    useActivity.getState().init(backend);
    return () => {
      useActivity.getState().dispose();
      useWorkspace.getState().dispose();
    };
  }, [backend]);

  if (status === "error") {
    return (
      <div className="grid h-full place-items-center bg-ws-win px-6">
        <div className="grid max-w-[480px] justify-items-center gap-3 text-center">
          <p className="selectable m-0 text-ws-blocked">{error}</p>
          <button type="button" className="rounded-md bg-ws-pip px-3.5 py-1.5 font-semibold text-ws-on-pip" onClick={() => useWorkspace.getState().init(backend).catch(() => {})}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (status !== "ready") return <div className="grid h-full place-items-center bg-ws-win text-ws-ink3">Loading…</div>;

  return (
    <TicketLinksContext.Provider value={workspaceTicketLinks}>
      <div className="ws-root grid h-full overflow-hidden bg-ws-win text-ws-ink" style={{ gridTemplateColumns: `232px minmax(0,1fr)${pipOpen ? " 380px" : ""}` }}>
        <Rail />
        <main id={MAIN_ID} tabIndex={-1} className="relative flex min-h-0 min-w-0 flex-col outline-none">
          <TabBar />
          {route === "workspace" && <FilterBar />}
          {route === "workspace" && <FilterNote />}
          <div className="min-h-0 flex-1">
            {route === "workspace" && <Canvas />}
            {route === "activity" && <ActivityView />}
            {route === "settings" && <Settings />}
          </div>
          {route === "workspace" && <ShortcutHint view={view} />}
          <PeekSheet />
          {!pipOpen && <PipLauncher />}
          <SelectionAsk />
        </main>
        {pipOpen && <PipPane onClose={() => setPipOpen(false)} />}
        {paletteOpen && <Palette />}
      </div>
      <ToastHost />
    </TicketLinksContext.Provider>
  );
}
