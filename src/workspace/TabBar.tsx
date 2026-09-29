import type { KeyboardEvent } from "react";
import { describeFilter } from "../lib/filter";
import { useLookup } from "./hooks";
import { useTabs, type Tab } from "./tabsStore";

export function TabStrip({
  tabs,
  activeId,
  labelOf,
  onActivate,
  onClose,
  onNew,
}: {
  tabs: Tab[];
  activeId: string;
  labelOf(tab: Tab): string;
  onActivate(id: string): void;
  onClose(id: string): void;
  onNew(): void;
}) {
  const onKeyDown = (ev: KeyboardEvent) => {
    const step = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const next = tabs[(tabs.findIndex((t) => t.id === activeId) + step + tabs.length) % tabs.length];
    onActivate(next.id);
    requestAnimationFrame(() => document.getElementById(`tab-${next.id}`)?.focus());
  };

  return (
    <div data-tauri-drag-region className="flex items-end gap-0.5 overflow-x-auto border-b border-ws-sep bg-ws-bar px-3 pt-3.5">
      <div role="tablist" aria-label="Workspace tabs" className="flex gap-0.5" onKeyDown={onKeyDown}>
        {tabs.map((t) => {
          const on = t.id === activeId;
          return (
            <div key={t.id} className={`-mb-px flex items-center border-b-2 ${on ? "border-ws-pip" : "border-transparent"}`}>
              <button
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                onClick={() => onActivate(t.id)}
                className={`max-w-[200px] truncate py-1.5 pr-1 pl-3 font-semibold ${on ? "text-ws-ink" : "text-ws-ink2 hover:text-ws-ink"}`}
              >
                {labelOf(t)}
              </button>
              <button
                type="button"
                aria-label={`Close tab ${labelOf(t)}`}
                onClick={() => onClose(t.id)}
                className="mr-1 rounded px-1 text-lg leading-none text-ws-ink3 hover:bg-ws-hover hover:text-ws-ink"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" aria-label="New tab" onClick={onNew} className="mb-1 ml-1 rounded px-2 text-lg leading-none text-ws-ink2 hover:bg-ws-hover">
        +
      </button>
    </div>
  );
}

export function TabBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const lookup = useLookup();
  const { activate, closeTab, openTab } = useTabs.getState();
  return (
    <TabStrip
      tabs={tabs}
      activeId={activeId}
      labelOf={(t) => t.title ?? describeFilter(t.filter, lookup)}
      onActivate={activate}
      onClose={closeTab}
      onNew={() => openTab()}
    />
  );
}
