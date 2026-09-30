import type { KeyboardEvent } from "react";
import { ALL, describeFilter } from "../lib/filter";
import { useItemsByFilter } from "../workspaceStore";
import { projectOf, scopeTo, withProject } from "./filters";
import { useActiveTab, useFilterCounts, useLookup } from "./hooks";
import { buildTabItems, type TabItem } from "./tabItems";
import { useTabs } from "./tabsStore";

export function TabStrip({
  items,
  counts,
  shown,
  total,
  onActivate,
  onClose,
  onNew,
}: {
  items: TabItem[];
  counts: number[];
  shown: number;
  total: number;
  onActivate(item: TabItem): void;
  onClose(tabId: string): void;
  onNew(): void;
}) {
  const onKeyDown = (ev: KeyboardEvent) => {
    const step = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const at = Math.max(0, items.findIndex((i) => i.active));
    const next = items[(at + step + items.length) % items.length];
    onActivate(next);
    requestAnimationFrame(() => document.getElementById(`tab-${next.id}`)?.focus());
  };

  return (
    <div className="flex items-end gap-1 border-b border-ws-sep">
      <div role="tablist" aria-label="Views" className="flex min-w-0 items-end gap-0.5 overflow-x-auto overflow-y-hidden" onKeyDown={onKeyDown}>
        {items.map((item, i) => (
          <div key={item.id} className={`-mb-px flex shrink-0 items-center border-b-2 ${item.active ? "border-ws-pip" : "border-transparent"}`}>
            <button
              type="button"
              role="tab"
              id={`tab-${item.id}`}
              aria-selected={item.active}
              tabIndex={item.active ? 0 : -1}
              title={item.label}
              onClick={() => onActivate(item)}
              className={`flex max-w-[260px] items-center gap-1.5 py-1.5 pl-3 font-semibold whitespace-nowrap ${item.tabId ? "pr-1" : "pr-3"} ${item.active ? "text-ws-ink" : "text-ws-ink2 hover:text-ws-ink"}`}
            >
              <span className="truncate">{item.label}</span>
              <span className={`rounded-full px-1.5 text-xs font-semibold ${item.active ? "bg-ws-pip-soft text-ws-pip" : "bg-ws-sel text-ws-ink3"}`}>{counts[i]}</span>
            </button>
            {item.tabId && (
              <button
                type="button"
                aria-label={`Close tab ${item.label}`}
                onClick={() => onClose(item.tabId!)}
                className="mr-1 rounded px-1 text-lg leading-none text-ws-ink3 hover:bg-ws-hover hover:text-ws-ink"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      <button type="button" aria-label="New tab" title="New tab" onClick={onNew} className="mb-1 rounded px-2 text-lg leading-none text-ws-ink2 hover:bg-ws-hover">
        +
      </button>
      <span className="mb-2 ml-auto shrink-0 px-1 text-sm text-ws-ink3" aria-live="polite">
        {shown} of {total}
      </span>
    </div>
  );
}

export function TabBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const savedViews = useTabs((s) => s.savedViews);
  const tab = useActiveTab();
  const lookup = useLookup();
  const { showView, activate, closeTab, openTab } = useTabs.getState();
  const project = projectOf(tab.filter);
  const items = buildTabItems(tabs, activeId, savedViews, (t) => t.title ?? describeFilter(withProject(t.filter, null), lookup));
  const counts = useFilterCounts(items.map((i) => (i.tabId ? i.filter : scopeTo(i.filter, project))));
  const shown = useItemsByFilter(tab.filter).length;
  const total = useItemsByFilter(withProject(ALL, project)).length;
  return (
    <TabStrip
      items={items}
      counts={counts}
      shown={shown}
      total={total}
      onActivate={(i) => (i.tabId ? activate(i.tabId) : showView(i.filter))}
      onClose={closeTab}
      onNew={() => openTab({ title: "New tab" })}
    />
  );
}
