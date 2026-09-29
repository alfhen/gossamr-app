import { useMemo, type KeyboardEvent } from "react";
import { itemKey } from "../lib/filter";
import { relativeTime } from "../lib/views";
import type { StatusDef, WorkCategory } from "../types";
import { nameOf, useWorkspace } from "../workspaceStore";
import type { CanvasProps } from "./canvases";
import { useTabs } from "./tabsStore";

const CHIP: Record<WorkCategory, string> = {
  todo: "bg-ws-sel text-ws-ink2",
  active: "bg-ws-accent-soft text-ws-accent",
  done: "bg-ws-done-soft text-ws-done",
};

export function StatusChip({ status }: { status: StatusDef }) {
  return <span className={`inline-block max-w-full truncate rounded-full px-2 py-px text-xs font-semibold ${CHIP[status.category]}`}>{status.name}</span>;
}

const rowId = (key: string) => `row-${key}`;

export function ListView({ items }: CanvasProps) {
  const names = useWorkspace((s) => s.names);
  const selected = useTabs((s) => s.selected);
  const select = useTabs((s) => s.select);
  const now = useMemo(() => new Date(), [items]);

  const onKeyDown = (ev: KeyboardEvent) => {
    const step = ev.key === "ArrowDown" ? 1 : ev.key === "ArrowUp" ? -1 : 0;
    if (!step || !items.length) return;
    ev.preventDefault();
    const at = items.findIndex((i) => itemKey(i.item) === selected);
    const next = items[Math.max(0, Math.min(items.length - 1, at < 0 ? 0 : at + step))];
    select(itemKey(next.item));
    document.getElementById(rowId(itemKey(next.item)))?.scrollIntoView({ block: "nearest" });
  };

  if (!items.length) return <p className="p-10 text-center text-ws-ink3">Nothing matches this filter.</p>;

  return (
    <div className="@container h-full overflow-auto px-6 pb-6">
      <div
        role="listbox"
        tabIndex={0}
        aria-label="Items"
        aria-activedescendant={selected && items.some((i) => itemKey(i.item) === selected) ? rowId(selected) : undefined}
        onKeyDown={onKeyDown}
        className="rounded-md outline-offset-2"
      >
        {items.map((i) => {
          const key = itemKey(i.item);
          const on = key === selected;
          return (
            <div
              key={key}
              id={rowId(key)}
              role="option"
              aria-selected={on}
              onClick={() => select(key)}
              className={`grid cursor-pointer grid-cols-[72px_minmax(0,1fr)_104px_40px] @xl:grid-cols-[84px_minmax(0,1fr)_120px_130px_44px] items-center gap-3 border-b border-ws-sep px-2 py-2 hover:bg-ws-hover ${on ? "bg-ws-sel" : ""}`}
            >
              <span className="truncate font-mono text-sm font-semibold text-ws-ink2">{i.item.key}</span>
              <span className="truncate">{i.title}</span>
              <StatusChip status={i.status} />
              <span className="hidden truncate text-ws-ink2 @xl:block">{nameOf({ names }, i.assignee)}</span>
              <span className="text-right text-sm text-ws-ink3">{relativeTime(i.updated, now)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
