import { useMemo } from "react";
import { itemKey } from "../lib/filter";
import { BulkBar } from "./BulkBar";
import { ageColumns } from "./boardLogic";
import type { CanvasProps } from "./canvases";
import { ItemCard } from "./ItemCard";
import { NoticeLine } from "./Notice";
import { useTabs } from "./tabsStore";
import { useCards } from "./useCards";

export function AgeView({ items }: CanvasProps) {
  const now = useMemo(() => new Date(), [items]);
  const columns = useMemo(() => ageColumns(items, now), [items, now]);
  const order = useMemo(() => columns.flatMap((c) => c.items.map((i) => itemKey(i.item))), [columns]);
  const cards = useCards(items, order);

  if (!columns.some((c) => c.items.length)) return <p className="p-10 text-center text-ws-ink3">Nothing open matches this filter.</p>;

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={(ev) => {
        if (ev.key === "Escape" && cards.bulk.marked.length) useTabs.getState().clearMarks();
      }}
    >
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-4">
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
      </div>
      <NoticeLine notice={cards.notice} onDismiss={cards.dismissNotice} />
      {cards.bulk.marked.length > 1 && (
        <BulkBar
          count={cards.bulk.marked.length}
          targets={cards.bulk.targets}
          approvable={cards.bulk.approvable}
          confirming={cards.bulk.confirming}
          onMoveAll={(n) => void cards.bulk.move(n)}
          onAsk={cards.bulk.ask}
          onCancel={cards.bulk.cancel}
          onApprove={() => void cards.bulk.approve()}
          onClear={cards.bulk.clear}
        />
      )}
    </div>
  );
}
