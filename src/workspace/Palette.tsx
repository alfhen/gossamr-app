import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ALL, containerKey, itemKey } from "../lib/filter";
import type { WorkItem } from "../types";
import { itemsByFilter, useWorkspace } from "../workspaceStore";
import { buildCommands, rankCommands, ticketCommands, type Command, type CommandActions } from "./commands";
import { withProject } from "./filters";
import { usePrefs } from "./prefs";
import { activeTab, allSavedViews, useTabs } from "./tabsStore";

export function PaletteView({
  query,
  results,
  active,
  onQuery,
  onActive,
  onRun,
  onClose,
}: {
  query: string;
  results: Command[];
  active: number;
  onQuery(q: string): void;
  onActive(i: number): void;
  onRun(c: Command): void;
  onClose(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const onKeyDown = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case "ArrowDown":
      case "ArrowUp": {
        ev.preventDefault();
        if (results.length) onActive((active + (ev.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
        return;
      }
      case "Enter":
        ev.preventDefault();
        if (results[active]) onRun(results[active]);
        return;
      case "Escape":
        ev.preventDefault();
        onClose();
        return;
      case "Tab":
        // The input is the only stop, so focus can't leave the dialog.
        ev.preventDefault();
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/30 pt-[14vh]" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown} className="w-[560px] max-w-[92vw] overflow-hidden rounded-xl border border-ws-sep2 bg-ws-win shadow-ws-pop">
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[active] ? `palette-${results[active].id}` : undefined}
          aria-label="Search commands and tickets"
          placeholder="Jump to a project or ticket, or run a command"
          value={query}
          onChange={(ev) => onQuery(ev.target.value)}
          className="w-full border-b border-ws-sep bg-transparent px-4 py-3 text-lg outline-none placeholder:text-ws-ink3"
        />
        <ul id="palette-list" role="listbox" aria-label="Results" className="m-0 max-h-[50vh] list-none overflow-auto p-1.5">
          {results.map((c, i) => (
            <li
              key={c.id}
              id={`palette-${c.id}`}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => i !== active && onActive(i)}
              onClick={() => onRun(c)}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 ${i === active ? "bg-ws-sel" : ""}`}
            >
              <span className="w-14 shrink-0 text-xs text-ws-ink3">{c.group}</span>
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              {c.hint && <span className="shrink-0 font-mono text-xs text-ws-ink3">{c.hint}</span>}
            </li>
          ))}
          {!results.length && <li className="px-3 py-3 text-ws-ink3">Nothing matches “{query}”.</li>}
        </ul>
      </div>
    </div>
  );
}

/** Narrows the active tab to the item's project unless its filter already shows the item, then selects it. */
export function jumpToItem(item: WorkItem) {
  const tabs = useTabs.getState();
  const tab = activeTab(tabs);
  const shown = itemsByFilter(useWorkspace.getState(), tab.filter).some((i) => itemKey(i.item) === itemKey(item.item));
  if (!shown) tabs.setFilter(withProject(ALL, item.container));
  tabs.select(itemKey(item.item));
  tabs.setRoute("workspace");
}

export function appActions(): CommandActions {
  const tabs = useTabs.getState();
  const prefs = usePrefs.getState();
  return {
    goToProject: tabs.setProject,
    openSavedView: tabs.openSavedView,
    setView: tabs.setView,
    addFilter: (f) => (tabs.setRoute("workspace"), tabs.addFilter(f)),
    clearFilters: () => tabs.setFilter({ type: "and", filters: [] }),
    setTheme: prefs.setTheme,
    openSettings: () => tabs.setRoute("settings"),
    openActivity: () => tabs.setRoute("activity"),
    newTab: () => void tabs.openTab(),
    togglePip: () => prefs.setPipOpen(!usePrefs.getState().pipOpen),
    jumpToItem,
  };
}

export function Palette() {
  const close = usePrefs((s) => s.setPaletteOpen);
  const containers = useWorkspace((s) => s.containers);
  const items = useWorkspace((s) => s.items);
  const savedViews = useTabs((s) => s.savedViews);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);

  const results = useMemo(() => {
    const actions = appActions();
    const commands = buildCommands(
      Object.values(containers).sort((a, b) => containerKey(a.ref).localeCompare(containerKey(b.ref))),
      allSavedViews({ savedViews }),
      actions,
    );
    return [...ticketCommands(Object.values(items), query, actions.jumpToItem), ...rankCommands(commands, query)];
  }, [containers, items, savedViews, query]);

  return (
    <PaletteView
      query={query}
      results={results}
      active={Math.min(active, Math.max(0, results.length - 1))}
      onQuery={(q) => (setQuery(q), setActive(0))}
      onActive={setActive}
      onRun={(c) => (close(false), c.run())}
      onClose={() => close(false)}
    />
  );
}
