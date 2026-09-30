import { useMemo, useState } from "react";
import { itemKey } from "../lib/filter";
import { ageBars, ageColumns, type AgeBar } from "./boardLogic";
import { AttentionDot } from "./CanvasBits";
import { CanvasFooter } from "./CanvasFooter";
import type { CanvasProps } from "./canvases";
import { AGE_FILL, ageLevel, selectHow } from "./canvasShared";
import { ItemCard, type ItemCardProps } from "./ItemCard";
import { readStored, writeStored } from "./storage";
import { useTabs } from "./tabsStore";
import { useCards } from "./useCards";

export type AgeLayout = "ranked" | "columns";

const LAYOUTS: { id: AgeLayout; label: string }[] = [
  { id: "ranked", label: "Ranked" },
  { id: "columns", label: "Columns" },
];
const KEY = "gossamr-age-layout";

type RowProps = Pick<ItemCardProps, "needsMe" | "unread" | "selected" | "marked" | "onSelect"> & { bar: AgeBar };

/** One ticket as a bar as long as it has been quiet, coloured by how worrying that is. */
export function AgeRow({ bar, ...p }: RowProps) {
  const { item, days, width } = bar;
  const lit = p.marked ? "bg-ws-accent-soft shadow-[inset_3px_0_0_var(--color-ws-accent)]" : p.selected ? "bg-ws-pip-soft shadow-[inset_3px_0_0_var(--color-ws-pip)]" : "hover:bg-ws-hover";
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={p.selected ? "true" : undefined}
      aria-label={`${item.item.key} ${item.title}, quiet for ${days} days`}
      data-marked={p.marked ? "true" : undefined}
      onClick={(ev) => p.onSelect(selectHow(ev))}
      onKeyDown={(ev) => {
        if (ev.target !== ev.currentTarget || (ev.key !== "Enter" && ev.key !== " ")) return;
        ev.preventDefault();
        p.onSelect(selectHow(ev));
      }}
      className={`grid cursor-pointer grid-cols-[96px_minmax(0,1.3fr)_2fr_40px] items-center gap-2.5 border-b border-ws-sep px-2 py-1.5 outline-offset-[-2px] ${lit}`}
    >
      <span className="flex items-center gap-1.5">
        <AttentionDot needsMe={p.needsMe} unread={p.unread} />
        <span className="truncate font-mono text-sm font-semibold text-ws-ink2">{item.item.key}</span>
      </span>
      <span className="truncate">{item.title}</span>
      <span aria-hidden className="h-2 overflow-hidden rounded bg-ws-sel">
        <i className={`block h-full rounded ${AGE_FILL[ageLevel(days)]}`} style={{ width: `${width}%` }} />
      </span>
      <span className="text-right text-xs text-ws-ink3">{days}d</span>
    </div>
  );
}

export function AgeLayoutToggle({ layout, onChange }: { layout: AgeLayout; onChange(next: AgeLayout): void }) {
  return (
    <div role="group" aria-label="Age layout" className="flex gap-0.5 rounded-lg bg-ws-sel p-0.5">
      {LAYOUTS.map((l) => (
        <button
          key={l.id}
          type="button"
          aria-pressed={layout === l.id}
          onClick={() => onChange(l.id)}
          className={`rounded-md px-2.5 py-0.5 text-sm font-semibold ${layout === l.id ? "bg-ws-win text-ws-ink shadow-sm" : "text-ws-ink3 hover:text-ws-ink2"}`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

export function AgeView({ items }: CanvasProps) {
  const [layout, setLayout] = useState<AgeLayout>(() => (readStored(KEY) === "columns" ? "columns" : "ranked"));
  const now = useMemo(() => new Date(), [items]);
  const columns = useMemo(() => ageColumns(items, now), [items, now]);
  const bars = useMemo(() => ageBars(items, now), [items, now]);
  const order = useMemo(() => (layout === "ranked" ? bars.map((b) => itemKey(b.item.item)) : columns.flatMap((c) => c.items.map((i) => itemKey(i.item)))), [layout, bars, columns]);
  const cards = useCards(items, order);

  const change = (next: AgeLayout) => {
    setLayout(next);
    writeStored(KEY, next);
  };

  if (!bars.length) return <p className="p-10 text-center text-ws-ink3">Nothing open matches this filter.</p>;

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={(ev) => {
        if (ev.key === "Escape" && cards.bulk.marked.length) useTabs.getState().clearMarks();
      }}
    >
      <div className="flex items-center px-6 pb-2">
        <AgeLayoutToggle layout={layout} onChange={change} />
        <span className="ml-3 text-xs text-ws-ink3">{layout === "ranked" ? "Longest quiet first, bars scaled to the longest." : "Open tickets by how long they have been quiet."}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-4">
        {layout === "ranked" ? (
          <div role="list" aria-label="Open tickets by days quiet">
            {bars.map((bar) => (
              <div role="listitem" key={itemKey(bar.item.item)}>
                <AgeRow bar={bar} {...cards.cardProps(bar.item)} />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid h-full min-h-60 auto-cols-[minmax(230px,1fr)] grid-flow-col gap-2.5">
            {columns.map(({ bucket, items: inside }) => (
              <div key={bucket.id} role="group" aria-label={`${bucket.label}, ${inside.length}`} className="flex flex-col gap-2 rounded-xl bg-ws-bar p-2">
                <div className="flex items-baseline text-sm font-bold text-ws-ink2">
                  {bucket.label}
                  <span className="ml-2 font-normal text-ws-ink3">{bucket.hint}</span>
                  <span className="ml-auto font-semibold text-ws-ink3">{inside.length}</span>
                </div>
                {inside.map((item) => (
                  <ItemCard key={itemKey(item.item)} {...cards.cardProps(item)} showStatus draggable={false} />
                ))}
                {!inside.length && <p className="rounded-lg border border-dashed border-ws-sep2 p-3 text-center text-sm text-ws-ink3">Nothing here</p>}
              </div>
            ))}
          </div>
        )}
      </div>
      <CanvasFooter cards={cards} view="age" />
    </div>
  );
}
