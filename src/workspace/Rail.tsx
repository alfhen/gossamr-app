import type { ReactNode } from "react";
import { containerKey } from "../lib/filter";
import { allContainers, useWorkspace } from "../workspaceStore";
import { BUILT_IN_VIEWS, projectOf, sameProject } from "./filters";
import { useActiveTab } from "./hooks";
import { usePrefs } from "./prefs";
import { useTabs, VIEW_LABEL, VIEW_MODES } from "./tabsStore";

const PROJECT_COLOURS = ["#e5883a", "#3aa87a", "#5b7cf0", "#c4508f", "#8a6d3b"];

function RailButton({ current, onClick, children, label }: { current?: boolean; onClick(): void; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      aria-label={label}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left hover:bg-ws-hover ${current ? "bg-ws-sel font-semibold" : "text-ws-ink2"}`}
    >
      {children}
    </button>
  );
}

const Heading = ({ children }: { children: ReactNode }) => <h2 className="m-0 px-2 pt-3.5 pb-1 text-xs font-semibold text-ws-ink3">{children}</h2>;

export function Rail() {
  const tab = useActiveTab();
  const route = useTabs((s) => s.route);
  const savedViews = useTabs((s) => s.savedViews);
  const { setRoute, setView, setProject, openSavedView, removeSavedView } = useTabs.getState();
  const containers = useWorkspace((s) => s.containers);
  const needsMe = useWorkspace((s) => s.needsMe.size);
  const pipOpen = usePrefs((s) => s.pipOpen);
  const setPipOpen = usePrefs((s) => s.setPipOpen);
  const project = projectOf(tab.filter);
  const inWorkspace = route === "workspace";

  return (
    <aside className="flex min-h-0 flex-col border-r border-ws-sep bg-ws-side">
      <div data-tauri-drag-region className="h-[44px] shrink-0" />
      <nav aria-label="Workspace" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <RailButton current={inWorkspace} onClick={() => setRoute("workspace")}>
          Workspace
        </RailButton>
        <div role="group" aria-label="View" className="mt-0.5 mb-1 ml-4 grid grid-cols-2 gap-0.5">
          {VIEW_MODES.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={inWorkspace && tab.view === v}
              onClick={() => setView(v)}
              className={`rounded-md px-2 py-[3px] text-left text-sm hover:bg-ws-hover ${inWorkspace && tab.view === v ? "bg-ws-sel font-semibold text-ws-ink" : "text-ws-ink2"}`}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        <RailButton current={route === "activity"} onClick={() => setRoute("activity")}>
          Activity
        </RailButton>

        <Heading>Views</Heading>
        {[...BUILT_IN_VIEWS, ...savedViews].map((v) => {
          const saved = savedViews.some((s) => s.id === v.id);
          return (
            <div key={v.id} className="group flex items-center">
              <RailButton onClick={() => openSavedView(v)}>
                {v.name}
                {v.id === "needs-me" && needsMe > 0 && (
                  <span className="ml-auto rounded-full bg-ws-pip px-1.5 text-xs text-ws-on-pip">{needsMe}</span>
                )}
              </RailButton>
              {saved && (
                <button
                  type="button"
                  aria-label={`Remove saved view ${v.name}`}
                  onClick={() => removeSavedView(v.id)}
                  className="rounded px-1.5 text-lg leading-none text-ws-ink3 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}

        <Heading>Projects</Heading>
        <RailButton current={inWorkspace && !project} onClick={() => setProject(null)}>
          <span className="size-2.5 rounded-[3px] bg-ws-ink3" aria-hidden />
          All projects
        </RailButton>
        {allContainers({ containers }).map((c, i) => (
          <RailButton key={containerKey(c.ref)} current={inWorkspace && sameProject(project, c.ref)} onClick={() => setProject(c.ref)}>
            <span className="size-2.5 rounded-[3px]" style={{ background: PROJECT_COLOURS[i % PROJECT_COLOURS.length] }} aria-hidden />
            {c.name}
          </RailButton>
        ))}
      </nav>
      <div className="grid gap-0.5 border-t border-ws-sep p-2">
        <RailButton current={pipOpen} onClick={() => setPipOpen(!pipOpen)}>
          Pip
          <kbd className="ml-auto rounded border border-ws-sep2 px-1 font-mono text-xs text-ws-ink3">⌘J</kbd>
        </RailButton>
        <RailButton current={route === "settings"} onClick={() => setRoute("settings")}>
          Settings
        </RailButton>
      </div>
    </aside>
  );
}
