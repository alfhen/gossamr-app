import { useEffect, useMemo, useRef } from "react";
import { listenToClaude, useClaude } from "../claudeStore";
import type { Backend } from "../backend/types";
import { TicketLinksContext } from "../components/ticketLinks";
import type { WorkFilter } from "../types";
import { useItemsByFilter, useWorkspace } from "../workspaceStore";
import { ActivityView } from "./ActivityView";
import { JiraSentView } from "./JiraSentView";
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
import { PullView } from "./PullView";
import { FilterNote, LAUNCHER_CLEAR, LAUNCHER_GUTTER, PipLauncher, SelectionAsk, usePipView } from "./PipExtras";
import { GENERAL_CONVERSATION, PIP_INPUT_ID, PipPane } from "./PipPane";
import { usePaneWidths } from "./PaneResizers";
import { applyTheme, usePrefs } from "./prefs";
import { useRuns } from "./runsStore";
import { togglePip, useWorkstreams } from "./workstreamsStore";
import { Rail } from "./Rail";
import { TABBABLE, nextRegion, regionStep, wrapTab, type WorkspaceRegion } from "./workKeys";
import { Settings } from "./Settings";
import { Header } from "./Header";
import { ConnectGithubDialog } from "./ConnectGithub";
import { useGithubUi } from "./githubUi";
import { FILTER_LIMIT, useDev } from "./devStore";
import { ChooseWatch } from "./WatchPicker";
import { ReauthBanner } from "./ReauthBanner";
import { ToastHost, focusToast, toastPlacement } from "./ToastHost";
import { useTabs, type Route } from "./tabsStore";
import { ROUTE_NAME, routeHeading, routeTitle } from "./routeTitle";

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

/**
 * How much of the main area's right side the workspace leaves to the open peek, so the canvas reflows beside it
 * instead of running under it. Other screens keep the peek as an overlay; an expanded peek covers everything anyway.
 */
export const canvasRoom = (route: Route, peekOpen: boolean, peekWidth: number) => (route === "workspace" && peekOpen ? peekWidth : 0);

/** The app opens on Agents only once per load, so coming back to the workspace later doesn't send the person away again. */
let landed = false;

/** Opens on Agents once the workspace is ready. */
function useStartOnAgents(ready: boolean) {
  useEffect(() => {
    if (!ready || landed) return;
    landed = true;
    useTabs.getState().setRoute("agents");
  }, [ready]);
}

/** The region of the workspace layout `el` is in: the peek, Pip's pane, or the main area around them. */
function regionOf(el: Element | null): WorkspaceRegion {
  if (el?.closest("[data-toast]")) return "toast";
  if (el?.closest("#peek-sheet")) return "peek";
  if (el?.closest("aside[data-pip-root]")) return "pip";
  return "main";
}

/** Where the keyboard goes in `region`: the peek's title, or the peek itself when it has none (a draft's peek, whose title is a field), Pip's input, or the main area. */
export function regionTarget(region: WorkspaceRegion, doc: Pick<Document, "querySelector" | "getElementById">): HTMLElement | null {
  if (region === "toast") return doc.querySelector<HTMLElement>("[data-toast]");
  if (region === "peek") return doc.querySelector<HTMLElement>("#peek-sheet h2") ?? doc.getElementById("peek-sheet");
  return doc.getElementById(region === "pip" ? PIP_INPUT_ID : MAIN_ID);
}

/** Puts the keyboard in `region`, from where Tab goes on into it. */
function enterRegion(region: WorkspaceRegion) {
  if (region === "toast") return void focusToast();
  const el = regionTarget(region, document);
  if (!el) return;
  if (!el.hasAttribute("tabindex") && region === "peek") el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: region !== "peek" });
}

/** The page's Tab stops in order: enabled, shown and not taken out of the order. */
const tabStops = () =>
  Array.from(document.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest("[hidden], [inert]") && el.getClientRects().length > 0);

/**
 * The workspace layout's regions by keyboard (D29): F6 and Shift+F6 step between the main area, the peek and Pip's pane,
 * from Pip's composer too; and Tab from the page's last stop (the pane's last button) goes on to the next region rather
 * than to the page itself.
 */
function useRegionKeys() {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || usePrefs.getState().paletteOpen || document.querySelector('[aria-modal="true"]')) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const present: WorkspaceRegion[] = ["main", ...(document.getElementById("peek-sheet") ? (["peek"] as const) : []), ...(document.querySelector("aside[data-pip-root]") ? (["pip"] as const) : []), ...(document.querySelector("[data-toast]") ? (["toast"] as const) : [])];
      // A KeyboardEvent's fields are getters on its prototype, so they are named, not spread.
      const by = regionStep({ key: ev.key, metaKey: ev.metaKey, ctrlKey: ev.ctrlKey, altKey: ev.altKey, shiftKey: ev.shiftKey, target: active });
      if (by) {
        ev.preventDefault();
        return enterRegion(nextRegion(present, regionOf(active), by));
      }
      if (wrapTab(ev, tabStops(), active, true)) {
        ev.preventDefault();
        enterRegion(nextRegion(present, regionOf(active), 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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
        togglePip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * The browser tab says which screen is open, and when the person moves to another one from the rail or the palette its heading
 * takes the keyboard, so a screen reader hears where it is. The keyboard is left alone where the person already put it.
 */
function useRouteAnnounce(screen: Route) {
  useEffect(() => {
    document.title = routeTitle(screen);
  }, [screen]);
  const before = useRef(screen);
  useEffect(() => {
    if (before.current === screen) return;
    before.current = screen;
    const sel = routeHeading(screen);
    if (!sel) return;
    const frame = requestAnimationFrame(() => {
      const at = document.activeElement;
      if (at && at !== document.body && at.id !== MAIN_ID && !at.closest("[data-rail]")) return;
      const heading = document.querySelector<HTMLElement>(sel);
      if (!heading) return;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [screen]);
}

export function Workspace({ backend }: { backend: Backend }) {
  const status = useWorkspace((s) => s.status);
  const error = useWorkspace((s) => s.error);
  const route = useTabs((s) => s.route);
  const theme = usePrefs((s) => s.theme);
  const pipOpen = usePrefs((s) => s.pipOpen);
  const { pip: pipWidth, peek: peekWidth } = usePaneWidths();
  const peekOpen = useTabs((s) => !!s.selected && s.marked.length <= 1);
  const paletteOpen = usePrefs((s) => s.paletteOpen);
  const setPipOpen = usePrefs((s) => s.setPipOpen);
  const choice = useWorkspace((s) => s.watch.find((w) => w.needsChoice));
  const choiceConnection = useWorkspace((s) => s.connections.find((c) => c.id === choice?.connectionId));
  const hasGithub = useWorkspace((s) => s.connections.some((c) => c.kind === "github"));
  useGlobalKeys();
  useRegionKeys();
  usePipView();
  useRouteAnnounce(route);
  const paneShown = pipOpen;
  const launcherShown = !pipOpen;
  const room = canvasRoom(route, peekOpen, peekWidth);

  useEffect(() => listenToClaude(), []);

  // Once the backend answers, Pip's conversation comes back from where it is kept, so it outlives a reload.
  const ready = status === "ready";
  useStartOnAgents(ready);
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
    useRuns.getState().init(backend);
    useWorkstreams.getState().init(backend);
    return () => {
      useWorkstreams.getState().dispose();
      useRuns.getState().dispose();
    };
  }, [backend]);

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
        <main
          id={MAIN_ID}
          aria-label={ROUTE_NAME[route]}
          tabIndex={-1}
          style={{ ["--ws-launcher-clear" as string]: `${launcherShown ? LAUNCHER_CLEAR : 0}px`, ["--ws-launcher-gutter" as string]: `${launcherShown ? LAUNCHER_GUTTER : 0}px` }}
          className="relative flex min-h-0 min-w-0 flex-col outline-none"
        >
          <div data-canvas-column style={{ paddingRight: room }} className="flex min-h-0 min-w-0 flex-1 flex-col motion-safe:transition-[padding] motion-safe:duration-200">
            <ReauthBanner />
            {route === "workspace" ? <Header /> : <div data-tauri-drag-region className="h-[34px] shrink-0" />}
            {route === "workspace" && <FilterBar />}
            {route === "workspace" && <FilterNote />}
            <div className="min-h-0 flex-1">
              {route === "workspace" && <Canvas />}
              {route === "activity" && <ActivityView />}
              {route === "sent" && <JiraSentView />}
              {route === "agents" && <AgentsView />}
              {route === "settings" && <Settings />}
            </div>
          </div>
          <PeekSheet />
          <AgentSheets />
          {launcherShown && <PipLauncher />}
          <SelectionAsk />
          <ToastHost placement={toastPlacement(room)} />
        </main>
        {paneShown && <PipPane onClose={() => setPipOpen(false)} />}
        {paletteOpen && <Palette />}
      </div>
      <ConnectGithubDialog />
      <PullView />
    </TicketLinksContext.Provider>
  );
}
