import { useEffect } from "react";
import { listenToClaude } from "../claudeStore";
import { useStore } from "../store";
import { useItemsByFilter, useWorkspace } from "../workspaceStore";
import { CANVASES } from "./canvases";
import { FilterBar } from "./FilterBar";
import { useActiveTab } from "./hooks";
import { MAIN_ID, Palette } from "./Palette";
import { PeekSheet } from "./PeekSheet";
import { FilterNote, PipLauncher, usePipView } from "./PipExtras";
import { PipPane } from "./PipPane";
import { applyTheme, usePrefs } from "./prefs";
import { Rail } from "./Rail";
import { Settings } from "./Settings";
import { TabBar } from "./TabBar";
import { useTabs } from "./tabsStore";

function Canvas() {
  const tab = useActiveTab();
  const items = useItemsByFilter(tab.filter);
  const View = CANVASES[tab.view];
  return <View tab={tab} items={items} />;
}

function Activity() {
  return (
    <div className="grid h-full place-items-center p-10 text-center text-ws-ink3">
      <p>Activity will show what happened on your tickets, including drafts waiting for you.</p>
    </div>
  );
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

export function Workspace() {
  const backend = useStore((s) => s.backend);
  const status = useWorkspace((s) => s.status);
  const error = useWorkspace((s) => s.error);
  const route = useTabs((s) => s.route);
  const theme = usePrefs((s) => s.theme);
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
    if (!backend) return;
    useWorkspace.getState().init(backend).catch(() => {});
    return () => useWorkspace.getState().dispose();
  }, [backend]);

  if (status === "error") return <div className="grid h-full place-items-center bg-ws-win text-ws-blocked">{error}</div>;
  if (status !== "ready") return <div className="grid h-full place-items-center bg-ws-win text-ws-ink3">Loading…</div>;

  return (
    <div className="grid h-full overflow-hidden bg-ws-win text-ws-ink" style={{ gridTemplateColumns: `232px minmax(0,1fr)${pipOpen ? " 380px" : ""}` }}>
      <Rail />
      <main id={MAIN_ID} tabIndex={-1} className="relative flex min-h-0 min-w-0 flex-col outline-none">
        <TabBar />
        {route === "workspace" && <FilterBar />}
        {route === "workspace" && <FilterNote />}
        <div className="min-h-0 flex-1">
          {route === "workspace" && <Canvas />}
          {route === "activity" && <Activity />}
          {route === "settings" && <Settings />}
        </div>
        <PeekSheet />
        {!pipOpen && <PipLauncher />}
      </main>
      {pipOpen && <PipPane onClose={() => setPipOpen(false)} />}
      {paletteOpen && <Palette />}
    </div>
  );
}
