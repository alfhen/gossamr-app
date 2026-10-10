import { useEffect, useMemo } from "react";
import { listenToClaude, useClaude } from "../claudeStore";
import type { Backend } from "../backend/types";
import { TicketLinksContext } from "../components/ticketLinks";
import type { WorkFilter } from "../types";
import { useItemsByFilter, useWorkspace } from "../workspaceStore";
import { ActivityView } from "./ActivityView";
import { AgentSheets } from "./AgentSheets";
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
import { GENERAL_CONVERSATION, PipPane } from "./PipPane";
import { usePaneWidths } from "./PaneResizers";
import { useAgentsEnabled, useAgentsFlag } from "./agentsFlag";
import { applyTheme, usePrefs } from "./prefs";
import { useRuns } from "./runsStore";
import { togglePip, useWorkstreams } from "./workstreamsStore";
import { PipHome } from "./PipHome";
import { Rail } from "./Rail";
import { isHoldAllKey, isPipHomeKey } from "./commands";
import { Settings } from "./Settings";
import { Header } from "./Header";
import { ConnectGithubDialog } from "./ConnectGithub";
import { useGithubUi } from "./githubUi";
import { FILTER_LIMIT, useDev } from "./devStore";
import { ChooseWatch } from "./WatchPicker";
import { ToastHost } from "./ToastHost";
import { useTabs, type Route } from "./tabsStore";

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

/** What the main area shows on `route`. Agents and Pip home are there only while Agents are on; until the route moves on, nothing is. */
export function mainScreen(route: Route, agentsEnabled: boolean): Route | null {
  return (route === "agents" || route === "pip") && !agentsEnabled ? null : route;
}

/** Whether the docked Pip pane is in the window: as the person left it, except on Pip home, whose own conversation takes its place. */
export const showsPipPane = (route: Route, agentsEnabled: boolean, pipOpen: boolean) => pipOpen && mainScreen(route, agentsEnabled) !== "pip";

/** Pip home is where the app opens only once per load, so coming back to the workspace later doesn't send the person away again. */
let landed = false;

/**
 * Opens on Pip home once the workspace is ready and the backend said Agents are on, when the person chose to start
 * there. Otherwise, and with Agents off, the app opens where it always has.
 */
function useStartOnPipHome(ready: boolean) {
  const known = useAgentsFlag((s) => s.known);
  const enabled = useAgentsFlag((s) => s.enabled);
  useEffect(() => {
    if (!ready || !known || landed) return;
    landed = true;
    if (enabled && usePrefs.getState().startOnPipHome) useTabs.getState().setRoute("pip");
  }, [ready, known, enabled]);
}

function useGlobalKeys(agentsEnabled: boolean) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (agentsEnabled && isHoldAllKey(ev)) {
        ev.preventDefault();
        void useWorkstreams.getState().holdAll();
        return;
      }
      if (agentsEnabled && isPipHomeKey(ev)) {
        ev.preventDefault();
        useTabs.getState().setRoute("pip");
        return;
      }
      if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey) return;
      const prefs = usePrefs.getState();
      if (ev.key === "k") {
        ev.preventDefault();
        prefs.setPaletteOpen(!prefs.paletteOpen);
      } else if (ev.key === "j") {
        ev.preventDefault();
        // On Pip home this goes to its composer; elsewhere it opens or closes the pane.
        togglePip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agentsEnabled]);
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
  useGlobalKeys(agentsEnabled);
  usePipView();
  const screen = mainScreen(route, agentsEnabled);
  const paneShown = showsPipPane(route, agentsEnabled, pipOpen);

  useEffect(() => listenToClaude(), []);

  // Once the backend answers, Pip's conversation comes back from where it is kept, so it outlives a reload.
  const ready = status === "ready";
  useStartOnPipHome(ready);
  useEffect(() => {
    if (!ready) return;
    listenToClaude();
    void useClaude.getState().load(GENERAL_CONVERSATION);
  }, [ready, backend]);

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
    useAgentsFlag.getState().init(backend);
  }, [backend]);

  useEffect(() => {
    if (!agentsEnabled) {
      const now = useTabs.getState().route;
      if (now === "agents" || now === "pip") useTabs.getState().setRoute("workspace");
      return;
    }
    useRuns.getState().init(backend);
    useWorkstreams.getState().init(backend);
    return () => {
      useWorkstreams.getState().dispose();
      useRuns.getState().dispose();
    };
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
        <div className="ws-root relative h-full overflow-clip bg-ws-win text-ws-ink">
          <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-10" />
          <ChooseWatch key={choice.connectionId} backend={backend} state={choice} connection={choiceConnection} />
        </div>
        <ToastHost />
      </>
    );
  }

  return (
    <TicketLinksContext.Provider value={workspaceTicketLinks}>
      {/* Clipped, not hidden: an overflow-hidden root is still a scroll container, and a scrollIntoView or focus() deep inside
          (a card in the peek, say) would scroll the whole app up under the person. A clipped one never scrolls. */}
      <div className="ws-root grid h-full overflow-clip bg-ws-win text-ws-ink" style={{ gridTemplateColumns: `58px minmax(0,1fr)${paneShown ? ` ${pipWidth}px` : ""}` }}>
        <Rail />
        <main id={MAIN_ID} tabIndex={-1} className="relative flex min-h-0 min-w-0 flex-col outline-none">
          {route === "workspace" ? <Header /> : <div data-tauri-drag-region className="h-[34px] shrink-0" />}
          {route === "workspace" && <FilterBar />}
          {route === "workspace" && <FilterNote />}
          <div className="min-h-0 flex-1">
            {screen === "workspace" && <Canvas />}
            {screen === "activity" && <ActivityView />}
            {screen === "agents" && <AgentsView />}
            {screen === "pip" && <PipHome />}
            {screen === "settings" && <Settings />}
          </div>
          <PeekSheet />
          {agentsEnabled && <AgentSheets />}
          {!pipOpen && screen !== "pip" && <PipLauncher />}
          <SelectionAsk />
        </main>
        {paneShown && <PipPane onClose={() => setPipOpen(false)} />}
        {paletteOpen && <Palette />}
      </div>
      <ConnectGithubDialog />
      <ToastHost />
    </TicketLinksContext.Provider>
  );
}
