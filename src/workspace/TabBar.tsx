import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ALL, describeFilter } from "../lib/filter";
import { useItemsByFilter } from "../workspaceStore";
import { projectOf, sameProject, scopeTo, withProject } from "./filters";
import { useActiveTab, useFilterCounts, useLookup } from "./hooks";
import { buildTabItems, type TabItem } from "./tabItems";
import { useTabs } from "./tabsStore";

/** A tab's place in the strip: its left edge from the first tab's, and its width. */
export interface TabSpan {
  left: number;
  size: number;
}

/**
 * Which tabs the strip shows: `start` to `end`, whole, `width` wide, scrolled `offset` in. No `width` when every tab fits.
 * `squeeze` is set when even the one tab shown is wider than the room: that tab is drawn that narrow, its label cut short,
 * so its count and close button stay in view.
 */
export interface TabWindow {
  start: number;
  end: number;
  offset: number;
  width?: number;
  squeeze?: number;
}

/** Room each 'more tabs' button and the gap beside it takes, when the tabs don't all fit. */
export const MORE_BUTTON = 34;

/**
 * The run of whole tabs a strip `room` wide shows, starting from `from`. With `active` set, that tab is always in it, moving
 * as little as it can; a run that reaches the last tab takes in as many earlier ones as still fit. A tab is never cut: the
 * strip ends where the last whole one does, and buttons either side say how many more there are.
 */
/** Whether two windows show the same thing, so the strip keeps the one it has. */
export const sameWindow = (a: TabWindow, b: TabWindow) => a.start === b.start && a.end === b.end && a.offset === b.offset && a.width === b.width && a.squeeze === b.squeeze;

export function tabWindow(spans: TabSpan[], room: number, from: number, active: number): TabWindow {
  const last = spans.length - 1;
  const right = (i: number) => spans[i].left + spans[i].size;
  if (last < 0 || right(last) - spans[0].left <= room) return { start: 0, end: Math.max(0, last), offset: 0 };
  const fits = Math.max(0, room - 2 * MORE_BUTTON);
  const endFrom = (s: number) => {
    let e = s;
    while (e < last && right(e + 1) - spans[s].left <= fits) e++;
    return e;
  };
  let start = Math.min(Math.max(0, from), last);
  if (active >= 0 && active < start) start = active;
  let end = endFrom(start);
  if (active > end) {
    start = active;
    while (start > 0 && right(active) - spans[start - 1].left <= fits) start--;
    end = endFrom(start);
  }
  while (end === last && start > 0 && right(end) - spans[start - 1].left <= fits) start--;
  const offset = spans[start].left - spans[0].left;
  const whole = right(end) - spans[start].left;
  return whole > fits ? { start, end, offset, width: fits, squeeze: fits } : { start, end, offset, width: whole };
}

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

  // One line of whole tabs: when the canvas is narrow (the peek and Pip both open) the strip shows as many as fit, always
  // the active one among them, and says how many more lie either side, never a tab cut mid-word.
  const room = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const newTab = useRef<HTMLButtonElement>(null);
  const active = items.findIndex((i) => i.active);
  const [view, setView] = useState<TabWindow>({ start: 0, end: Math.max(0, items.length - 1), offset: 0 });
  const from = useRef(0);
  /** Works out the run of tabs that fits from `start`, keeping the active tab in it when `follow`. */
  const fit = (follow: boolean, start = from.current) => {
    const el = list.current;
    const box = room.current;
    if (!el || !box) return;
    const tabs = [...el.children].map((t) => t.getBoundingClientRect());
    const spans = tabs.map((r) => ({ left: r.left - (tabs[0]?.left ?? 0), size: r.width }));
    const next = tabWindow(spans, box.clientWidth - (newTab.current?.offsetWidth ?? 0) - 4, start, follow ? active : -1);
    from.current = next.start;
    setView((v) => (sameWindow(v, next) ? v : next));
  };
  const refit = useRef(fit);
  // Only a committed render's `fit` may answer the observer: a discarded render could hold a different active tab.
  useLayoutEffect(() => {
    refit.current = fit;
  });
  // The canvas narrowing as the peek or the Pip pane opens, or a tab's count growing, refits the strip around the active tab.
  useLayoutEffect(() => {
    const box = room.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => refit.current(true));
    watch.observe(box);
    return () => watch.disconnect();
  }, []);
  useLayoutEffect(() => fit(true), [active, items.length, counts.join()]);
  // Scrolling is the strip's own doing: put it back if focus or the browser moves it.
  const pin = () => {
    if (list.current && Math.abs(list.current.scrollLeft - view.offset) > 0.5) list.current.scrollLeft = view.offset;
  };
  useLayoutEffect(pin, [view]);
  const before = view.width === undefined ? 0 : view.start;
  const after = view.width === undefined ? 0 : items.length - 1 - view.end;
  const page = (ahead: boolean) => fit(false, ahead ? view.end + 1 : Math.max(0, view.start - (view.end - view.start + 1)));
  const moreButton = "w-[30px] shrink-0 mb-1 rounded text-xs font-semibold text-ws-ink2 hover:bg-ws-hover disabled:invisible";

  return (
    <div className="flex items-end gap-1 border-b border-ws-sep">
      <div ref={room} className="flex min-w-0 flex-1 items-end gap-1">
        {view.width !== undefined && (
          <button type="button" aria-label={`Show ${before} earlier ${before === 1 ? "tab" : "tabs"}`} title={`${before} more`} disabled={!before} onClick={() => page(false)} className={moreButton}>
            ‹ {before}
          </button>
        )}
        <div
          ref={list}
          role="tablist"
          aria-label="Views"
          data-more={before || after ? `${before} ${after}` : undefined}
          onScroll={pin}
          style={{ width: view.width }}
          className="relative flex min-w-0 shrink-0 items-end gap-0.5 overflow-hidden"
          onKeyDown={onKeyDown}
        >
          {items.map((item, i) => (
            <div
              key={item.id}
              style={view.squeeze !== undefined && i === view.start ? { maxWidth: view.squeeze } : undefined}
              className={`-mb-px flex shrink-0 items-center border-b-2 ${item.active ? "border-ws-pip" : "border-transparent"}`}
            >
              <button
                type="button"
                role="tab"
                id={`tab-${item.id}`}
                aria-selected={item.active}
                tabIndex={item.active ? 0 : -1}
                title={item.label}
                onClick={() => onActivate(item)}
                className={`flex min-w-0 max-w-[260px] items-center gap-1.5 py-1.5 pl-3 font-semibold whitespace-nowrap ${item.tabId ? "pr-1" : "pr-3"} ${item.active ? "text-ws-ink" : "text-ws-ink2 hover:text-ws-ink"}`}
              >
                <span className="truncate">{item.label}</span>
                <span className={`shrink-0 rounded-full px-1.5 text-xs font-semibold ${item.active ? "bg-ws-pip-soft text-ws-pip" : "bg-ws-sel text-ws-ink3"}`}>{counts[i]}</span>
              </button>
              {item.tabId && (
                <button
                  type="button"
                  aria-label={`Close tab ${item.label}`}
                  onClick={() => onClose(item.tabId!)}
                  className="mr-1 shrink-0 rounded px-1 text-lg leading-none text-ws-ink3 hover:bg-ws-hover hover:text-ws-ink"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
        {view.width !== undefined && (
          <button type="button" aria-label={`Show ${after} more ${after === 1 ? "tab" : "tabs"}`} title={`${after} more`} disabled={!after} onClick={() => page(true)} className={moreButton}>
            {after} ›
          </button>
        )}
        <button ref={newTab} type="button" aria-label="New tab" title="New tab" onClick={onNew} className="mb-1 shrink-0 rounded px-2 text-lg leading-none text-ws-ink2 hover:bg-ws-hover">
          +
        </button>
      </div>
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
  const items = buildTabItems(tabs, activeId, savedViews, (t) => t.title ?? describeFilter(sameProject(projectOf(t.filter), project) ? withProject(t.filter, null) : t.filter, lookup));
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
