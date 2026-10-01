import { useEffect, useMemo } from "react";
import { listenToClaude } from "../claudeStore";
import type { Backend } from "../backend/types";
import { TicketLinksContext } from "../components/ticketLinks";
import type { WorkFilter } from "../types";
import { useItemsByFilter, useWorkspace } from "../workspaceStore";
import { ActivityView } from "./ActivityView";
import { AgentsView } from "./AgentsView";
import { useActivity } from "./activityStore";
import { CANVASES } from "./canvases";
import { useStepKeys } from "./browse";
import { itemKey, usesCode, withoutCode } from "../lib/filter";
import { workspaceTicketLinks } from "./jump";
import { workConnections } from "./domains";
import { FilterBar } from "./FilterBar";
import { useActiveTab } from "./hooks";
import { MAIN_ID, Palette } from "./Palette";
import { PeekSheet } from "./PeekSheet";
import { FilterNote, PipLauncher, SelectionAsk, usePipView } from "./PipExtras";
import { PipPane } from "./PipPane";
import { usePaneWidths } from "./PaneResizers";
import { applyTheme, useAgentsEnabled, usePrefs } from "./prefs";
import { useRuns } from "./runsStore";
import { Rail } from "./Rail";
import { Settings } from "./Settings";
import { Header } from "./Header";
import { ConnectGithubDialog } from "./ConnectGithub";
import { useGithubUi } from "./githubUi";
import { FILTER_LIMIT, useDev } from "./devStore";
import { ChooseWatch } from "./WatchPicker";
import { ToastHost } from "./ToastHost";
import { useTabs } from "./tabsStore";

/** Matches no item, for a filter that has nothing to read. */
const NOTHING: WorkFilter = { type: "items", items: [] };

function Canvas() {
  const tab = useActiveTab();
  const items = useItemsByFilter(tab.filter);
  const wantsCode = usesCode(tab.filter);
  const candidates = useItemsByFilter(wantsCode ? withoutCode(tab.filter) : NOTHING);
  useEffect(() => {
    if (wantsCode) useDev.getState().ensure(candidates.slice(0, FILTER_LIMIT).map((i) => i.item));
  }, [wantsCode, candidates]);
  const anything = useWorkspace((s) => Object.keys(s.items).length > 0);
  const connection = useWorkspace((s) => workConnections(s.connections)[0]);
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
  const pipOpen = usePrefs((s) => s.pipOpen);
  const pipWidth = usePaneWidths().pip;
  const paletteOpen = usePrefs((s) => s.paletteOpen);
  const setPipOpen = usePrefs((s) => s.setPipOpen);
  const choice = useWorkspace((s) => s.watch.find((w) => w.needsChoice));
  const choiceConnection = useWorkspace((s) => s.connections.find((c) => c.id === choice?.connectionId));
  const hasGithub = useWorkspace((s) => s.connections.some((c) => c.kind === "github"));
  const agentsEnabled = useAgentsEnabled();
  useGlobalKeys();
  usePipView();

  useEffect(() => listenToClaude(), []);

  const missingConnection = !!choice && !choiceConnection;
  useEffect(() => {
    if (missingConnection) void useWorkspace.getState().refreshConnections();
  }, [missingConnection]);

  useEffect(() => {
    applyTheme(theme);
    return () => applyTheme("auto");
  }, [theme]);

  useEffect(() => {
    useWorkspace.getState().init(backend).catch(() => {});
    useActivity.getState().init(backend);
    useDev.getState().init(backend);
    return () => {
      useDev.getState().dispose();
      useActivity.getState().dispose();
      useWorkspace.getState().dispose();
    };
  }, [backend]);

  useEffect(() => {
    if (!agentsEnabled) return;
    useRuns.getState().init(backend);
    return () => useRuns.getState().dispose();
  }, [backend, agentsEnabled]);

  useEffect(() => {
    useDev.getState().setEnabled(hasGithub);
  }, [hasGithub, backend]);

  // The forced picker replaces the whole window, so a connect dialog left open would come back after it.
  const choosing = !!choice;
  useEffect(() => {
    if (choosing) useGithubUi.getState().closeConnect();
  }, [choosing]);

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

  if (choice) {
    return (
      <>
        <div className="ws-root relative h-full overflow-hidden bg-ws-win text-ws-ink">
          <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-10" />
          <ChooseWatch key={choice.connectionId} backend={backend} state={choice} connection={choiceConnection} />
        </div>
        <ToastHost />
      </>
    );
  }

  return (
    <TicketLinksContext.Provider value={workspaceTicketLinks}>
      <div className="ws-root grid h-full overflow-hidden bg-ws-win text-ws-ink" style={{ gridTemplateColumns: `58px minmax(0,1fr)${pipOpen ? ` ${pipWidth}px` : ""}` }}>
        <Rail />
        <main id={MAIN_ID} tabIndex={-1} className="relative flex min-h-0 min-w-0 flex-col outline-none">
          {route === "workspace" ? <Header /> : <div data-tauri-drag-region className="h-[34px] shrink-0" />}
          {route === "workspace" && <FilterBar />}
          {route === "workspace" && <FilterNote />}
          <div className="min-h-0 flex-1">
            {route === "workspace" && <Canvas />}
            {route === "activity" && <ActivityView />}
            {route === "agents" && agentsEnabled && <AgentsView />}
            {route === "settings" && <Settings />}
          </div>
          <PeekSheet />
          {!pipOpen && <PipLauncher />}
          <SelectionAsk />
        </main>
        {pipOpen && <PipPane onClose={() => setPipOpen(false)} />}
        {paletteOpen && <Palette />}
      </div>
      <ConnectGithubDialog />
      <ToastHost />
    </TicketLinksContext.Provider>
  );
}
