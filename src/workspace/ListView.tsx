import { useMemo, useState, type KeyboardEvent } from "react";
import { itemKey } from "../lib/filter";
import { useWorkspace } from "../workspaceStore";
import { AgeChip, AttentionDot, Avatar, NeedsPill, StatusPill } from "./CanvasBits";
import { PrBadge } from "./DevBits";
import { CanvasFooter } from "./CanvasFooter";
import { daysQuiet } from "./boardLogic";
import type { CanvasProps } from "./canvases";
import { selectHow, showsAge } from "./canvasShared";
import type { ItemCardProps } from "./ItemCard";
import { listGroups, selectionAfterCollapse, visibleOrder, type ListGroup } from "./listLogic";
import { stepKey } from "./peekLogic";
import { useTabs } from "./tabsStore";
import { useCards } from "./useCards";

const rowId = (key: string) => `row-${key}`;

export function GroupHeader({ group, collapsed, onToggle }: { group: ListGroup; collapsed: boolean; onToggle(): void }) {
  const { done, total, percent } = group.progress;
  const hidden = group.items.length < total;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="flex w-full items-center gap-2.5 bg-ws-bar px-3 py-2 text-left hover:bg-ws-hover"
    >
      <span aria-hidden className="w-3 text-ws-ink3">
        {collapsed ? "▸" : "▾"}
      </span>
      <span className="font-mono text-sm font-semibold text-ws-ink2">{group.sub}</span>
      <b className="min-w-0 truncate">{group.label}</b>
      <span className="whitespace-nowrap text-xs text-ws-ink3">
        {group.parentKey ? `${done}/${total} done` : `${group.items.length} ${group.items.length === 1 ? "item" : "items"}`}
        {group.parentKey && hidden ? ` · ${group.items.length} shown` : ""}
      </span>
      {group.parentKey && (
        <span
          role="progressbar"
          aria-label={`${done} of ${total} done`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="ml-auto h-[5px] w-28 flex-none overflow-hidden rounded-[3px] bg-ws-sel"
        >
          <i className="block h-full bg-ws-done" style={{ width: `${percent}%` }} />
        </span>
      )}
    </button>
  );
}

type RowProps = Pick<ItemCardProps, "item" | "assignee" | "now" | "blocked" | "needsMe" | "unread" | "draft" | "moreDrafts" | "code" | "selected" | "marked" | "onSelect">;

export function ListRow(p: RowProps) {
  const { item } = p;
  const days = daysQuiet(item, p.now);
  const lit = p.marked ? "bg-ws-accent-soft shadow-[inset_3px_0_0_var(--color-ws-accent)]" : p.selected ? "bg-ws-pip-soft shadow-[inset_3px_0_0_var(--color-ws-pip)]" : "hover:bg-ws-hover";
  return (
    <div
      id={rowId(itemKey(item.item))}
      role="option"
      aria-selected={p.selected}
      data-marked={p.marked ? "true" : undefined}
      onClick={(ev) => p.onSelect(selectHow(ev))}
      className={`grid cursor-pointer grid-cols-[96px_minmax(0,1fr)_44px_40px_110px_22px] items-center gap-2.5 border-t border-ws-sep px-3 py-1.5 ${lit}`}
    >
      <span className="flex items-center gap-1.5">
        <AttentionDot needsMe={p.needsMe} unread={p.unread} />
        <span className="truncate font-mono text-sm font-semibold text-ws-ink2">{item.item.key}</span>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">{item.title}</span>
        {p.needsMe && <NeedsPill />}
        {p.draft && (
          <span className="flex-none rounded-full bg-ws-pip-soft px-2 py-px text-xs font-semibold text-ws-pip" title="A draft is waiting for approval">
            ✦ draft → {p.draft.to}
          </span>
        )}
        {p.moreDrafts > 0 && (
          <span className="flex-none text-xs text-ws-pip" title="Drafts waiting on this ticket">
            ✦ {p.moreDrafts}
          </span>
        )}
        {p.blocked && <span className="flex-none text-xs text-ws-blocked">⛓ blocked</span>}
      </span>
      <span className="flex justify-end">
        <PrBadge summary={p.code} />
      </span>
      <span className="text-right">{showsAge(item, days) && <AgeChip days={days} />}</span>
      <StatusPill status={item.status} />
      <Avatar name={p.assignee} />
      {p.marked && <span className="sr-only">Ticked for a bulk action</span>}
    </div>
  );
}

export function ListView({ items }: CanvasProps) {
  const all = useWorkspace((s) => s.items);
  const containers = useWorkspace((s) => s.containers);
  const selected = useTabs((s) => s.selected);
  const groups = useMemo(() => listGroups(items, all, containers), [items, all, containers]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const order = useMemo(() => visibleOrder(groups, collapsed), [groups, collapsed]);
  const cards = useCards(items, order);
  const shown = selected !== null && order.includes(selected);

  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
    const moved = selectionAfterCollapse(groups, next, selected);
    if (moved) useTabs.getState().select(moved);
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    const step = ev.key === "ArrowDown" ? 1 : ev.key === "ArrowUp" ? -1 : 0;
    if (step) {
      const next = stepKey(order, selected, step);
      if (!next) return;
      ev.preventDefault();
      useTabs.getState().select(next);
      document.getElementById(rowId(next))?.scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Escape" && cards.bulk.marked.length) useTabs.getState().clearMarks();
    else if ((ev.key === "ArrowLeft" || ev.key === "ArrowRight") && selected) {
      const group = groups.find((g) => g.items.some((i) => itemKey(i.item) === selected));
      if (group && collapsed.has(group.key) === (ev.key === "ArrowRight")) {
        ev.preventDefault();
        toggle(group.key);
      }
    }
  };

  if (!items.length) return <p className="p-10 text-center text-ws-ink3">Nothing matches this filter.</p>;

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <div
          role="listbox"
          tabIndex={0}
          aria-label="Items"
          aria-multiselectable="true"
          aria-activedescendant={shown ? rowId(selected) : undefined}
          onKeyDown={onKeyDown}
          className="rounded-md outline-offset-2"
        >
          {groups.map((group) => {
            const closed = collapsed.has(group.key);
            return (
              <div key={group.key} role="group" aria-label={`${group.label}, ${group.items.length}`} className="mt-3 overflow-hidden rounded-[10px] border border-ws-sep first:mt-0">
                <GroupHeader group={group} collapsed={closed} onToggle={() => toggle(group.key)} />
                {!closed && group.items.map((i) => <ListRow key={itemKey(i.item)} {...cards.cardProps(i)} />)}
              </div>
            );
          })}
        </div>
      </div>
      <CanvasFooter cards={cards} view="list" />
    </div>
  );
}
