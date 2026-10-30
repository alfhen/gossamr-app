import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { PipGlyph } from "../components/PipGlyph";
import { itemKey, YOUR_TURN, YOUR_TURN_WHY } from "../lib/filter";
import { useWorkspace } from "../workspaceStore";
import { AgeChip, AttentionDot, Avatar, StatusPill, TurnPill } from "./CanvasBits";
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

/**
 * A row's columns: key, title and badges, PR, age, status, assignee. As the list narrows (the peek and Pip both open)
 * the PR and age columns go first, then the status, so the title keeps room to be read.
 */
const ROW_COLUMNS =
  "grid-cols-[96px_minmax(0,1fr)_44px_40px_110px_22px] @max-[640px]:grid-cols-[96px_minmax(0,1fr)_110px_22px] @max-[500px]:grid-cols-[96px_minmax(0,1fr)_22px]";

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
      <span className="shrink-0 font-mono text-sm font-semibold whitespace-nowrap text-ws-ink2">{group.sub}</span>
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

/** A row's badges and status in words, for the title's tooltip: a narrow row may have no room to show them all. */
export function badgeWords(p: Pick<RowProps, "needsMe" | "blocked" | "draft" | "moreDrafts">, status: string): string[] {
  return [
    ...(p.needsMe ? [YOUR_TURN] : []),
    ...(p.blocked ? ["blocked"] : []),
    ...(p.draft ? [`draft → ${p.draft.to}`] : []),
    ...(p.moreDrafts > 0 ? [`${p.moreDrafts} more ${p.moreDrafts === 1 ? "draft" : "drafts"}`] : []),
    status,
  ];
}

/** The room a row's title keeps before its badges turn into icons: about ten letters. */
const TITLE_ROOM = 96;

/**
 * Whether the badges of a row, side by side, would leave its title less than `TITLE_ROOM`: then they show as icons. The
 * full set's width is measured while it is on screen and kept; `content` changing shows the full set again to measure it.
 */
function useCompactBadges(cell: RefObject<HTMLElement | null>, badges: RefObject<HTMLElement | null>, content: string): boolean {
  const [compact, setCompact] = useState(false);
  const full = useRef<{ content: string; width: number } | null>(null);
  useLayoutEffect(() => {
    const c = cell.current;
    const b = badges.current;
    if (!c || !b) return;
    const check = () => {
      if (!compact) full.current = { content, width: b.scrollWidth };
      else if (full.current?.content !== content) return setCompact(false);
      const width = full.current?.width ?? 0;
      setCompact(width > 0 && width > c.clientWidth - TITLE_ROOM - 8);
    };
    check();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(check);
    watch.observe(c);
    return () => watch.disconnect();
  }, [cell, badges, compact, content]);
  return compact;
}

/**
 * A row's badges: Your turn, blocked, the waiting draft and how many more. `compact`, for a row too narrow to show them
 * in words, gives each as an icon with its name and a tooltip instead, so none of them is lost.
 */
export function RowBadges(p: Pick<RowProps, "needsMe" | "blocked" | "draft" | "moreDrafts"> & { compact: boolean }) {
  const more = p.moreDrafts > 0 ? `${p.moreDrafts} more ${p.moreDrafts === 1 ? "draft" : "drafts"} waiting` : "";
  if (p.compact) {
    const icon = (label: string, className: string, glyph: ReactNode, tip = label) => (
      <span role="img" aria-label={label} title={tip} className={`grid h-4 min-w-4 place-items-center rounded-full px-0.5 text-[11px] leading-none font-semibold ${className}`}>
        {glyph}
      </span>
    );
    return (
      <>
        {p.needsMe && icon(YOUR_TURN, "bg-ws-pip-soft text-ws-pip", "!", YOUR_TURN_WHY)}
        {p.blocked && icon("Blocked", "bg-ws-blocked-soft text-ws-blocked", "⛓")}
        {p.draft && icon(`A draft waits for approval: ${p.draft.to}`, "bg-ws-pip-soft text-ws-pip", <PipGlyph />)}
        {more && icon(more, "text-ws-pip", `+${p.moreDrafts}`)}
      </>
    );
  }
  return (
    <>
      {p.needsMe && <TurnPill />}
      {p.blocked && <span className="text-xs text-ws-blocked">⛓ blocked</span>}
      {p.draft && (
        <span className="rounded-full bg-ws-pip-soft px-2 py-px text-xs font-semibold text-ws-pip" title="A draft is waiting for approval">
          <PipGlyph /> draft → {p.draft.to}
        </span>
      )}
      {more && (
        <span className="text-xs text-ws-pip" title={more}>
          <PipGlyph /> {p.moreDrafts}
        </span>
      )}
    </>
  );
}

export function ListRow(p: RowProps) {
  const { item } = p;
  const cell = useRef<HTMLSpanElement>(null);
  const badges = useRef<HTMLSpanElement>(null);
  const compact = useCompactBadges(cell, badges, `${p.needsMe}|${p.blocked}|${p.draft?.to ?? ""}|${p.moreDrafts}`);
  const days = daysQuiet(item, p.now);
  const lit = p.marked ? "bg-ws-accent-soft shadow-[inset_3px_0_0_var(--color-ws-accent)]" : p.selected ? "ws-lens-row border-t-transparent" : "hover:bg-ws-hover";
  return (
    <div
      id={rowId(itemKey(item.item))}
      role="option"
      aria-selected={p.selected}
      data-marked={p.marked ? "true" : undefined}
      onClick={(ev) => p.onSelect(selectHow(ev))}
      className={`grid cursor-pointer items-center gap-2.5 overflow-hidden border-t border-ws-sep px-3 py-1.5 ${ROW_COLUMNS} ${lit}`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <AttentionDot needsMe={p.needsMe} unread={p.unread} />
        <span className="truncate font-mono text-sm font-semibold text-ws-ink2">{item.item.key}</span>
      </span>
      <span ref={cell} className="flex min-w-0 items-center gap-2">
        {/* The title gives way first, down to a few letters; past that the badges turn into icons, each named and with a
            tooltip, so a narrow row loses none of them. The title's tooltip names them all too. */}
        <span data-row-title title={[item.title, ...badgeWords(p, item.status.name)].join(" · ")} className="min-w-[6ch] shrink-[100] truncate">
          {item.title}
        </span>
        <span ref={badges} data-row-badges={compact ? "compact" : "full"} className="flex min-w-0 shrink-[0.01] items-center gap-x-2 overflow-hidden whitespace-nowrap [&>*]:shrink-0">
          <RowBadges {...p} compact={compact} />
        </span>
      </span>
      <span className="flex justify-end @max-[640px]:hidden">
        <PrBadge summary={p.code} />
      </span>
      <span className="text-right @max-[640px]:hidden">{showsAge(item, days) && <AgeChip days={days} />}</span>
      <span className="min-w-0 @max-[500px]:hidden">
        <StatusPill status={item.status} />
      </span>
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
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-[calc(var(--ws-launcher-clear,0px)+24px)]">
        <div
          role="listbox"
          tabIndex={0}
          aria-label="Items"
          aria-multiselectable="true"
          aria-activedescendant={shown ? rowId(selected) : undefined}
          onKeyDown={onKeyDown}
          className="@container rounded-md outline-offset-2"
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
      <CanvasFooter cards={cards} />
    </div>
  );
}
