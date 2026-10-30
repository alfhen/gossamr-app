import { showOf } from "../lib/keys";
import { containerKey } from "../lib/filter";
import type { ContainerRef, WorkContainer } from "../types";
import { allContainers, useWorkspace } from "../workspaceStore";
import { projectOf, sameProject } from "./filters";
import { useActiveTab } from "./hooks";
import { usePopover } from "./Popover";
import { projectColour } from "./projects";
import { TabBar } from "./TabBar";
import { useTabs, VIEW_LABEL, type ViewMode } from "./tabsStore";
import { Segmented } from "../components/Segmented";

/** The order the prototype shows the canvases in. */
export const SEGMENT_ORDER: readonly ViewMode[] = ["board", "list"];

export function ViewSegment({ view, onChange }: { view: ViewMode; onChange(view: ViewMode): void }) {
  return (
    <Segmented label="View" className="ml-auto shrink-0" value={view} onChange={onChange} options={SEGMENT_ORDER.map((v) => ({ value: v, label: VIEW_LABEL[v] }))} />
  );
}

export function ProjectMenu({ containers, value, onChange }: { containers: WorkContainer[]; value: ContainerRef | null; onChange(project: ContainerRef | null): void }) {
  const { open, setOpen, root } = usePopover();
  const current = containers.find((c) => sameProject(c.ref, value));
  const pick = (project: ContainerRef | null) => {
    onChange(project);
    setOpen(false);
  };
  const row = "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ws-glass-item";
  const selected = "[background:linear-gradient(var(--color-ws-sel),var(--color-ws-sel)),var(--glass-lens)] font-semibold";
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-popover-trigger
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Project: ${current?.name ?? "All projects"}`}
        title={`Switch project (${showOf("app", "jump")})`}
        onClick={() => setOpen(!open)}
        className="-ml-1.5 flex items-center gap-2 rounded-md px-1.5 text-[22px] leading-tight font-bold hover:bg-ws-hover"
      >
        {current?.name ?? "All projects"}
        <span aria-hidden className="text-xs font-normal text-ws-ink3">
          ▾
        </span>
      </button>
      {open && (
        <ul role="listbox" aria-label="Projects" className="absolute top-full left-0 z-40 mt-1 m-0 w-[240px] list-none ws-glass ws-glass-regular rounded-xl text-ws-ink p-1.5 text-sm font-medium">
          <li role="option" aria-selected={!value}>
            <button type="button" className={`${row} ${!value ? selected : ""}`} onClick={() => pick(null)}>
              <span className="size-2.5 rounded-[3px] bg-ws-ink3" aria-hidden />
              All projects
            </button>
          </li>
          {containers.map((c) => (
            <li key={containerKey(c.ref)} role="option" aria-selected={sameProject(c.ref, value)}>
              <button type="button" className={`${row} ${sameProject(c.ref, value) ? selected : ""}`} onClick={() => pick(c.ref)}>
                <span className="size-2.5 rounded-[3px]" style={{ background: projectColour(containers, c.ref) }} aria-hidden />
                {c.name}
                <span className="ml-auto font-mono text-xs text-ws-ink">{c.key}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Title row and tabs of the workspace route. The strip above leaves room for the traffic lights and drags the window. */
export function Header() {
  const tab = useActiveTab();
  const containers = useWorkspace((s) => s.containers);
  const { setView, setProject } = useTabs.getState();
  return (
    <header className="px-6 pb-0">
      <div data-tauri-drag-region className="h-[34px]" />
      <div data-tauri-drag-region className="mb-3 flex items-center gap-3.5">
        <ProjectMenu containers={allContainers({ containers })} value={projectOf(tab.filter)} onChange={setProject} />
        <ViewSegment view={tab.view} onChange={setView} />
      </div>
      <TabBar />
    </header>
  );
}
