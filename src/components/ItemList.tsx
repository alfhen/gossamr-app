import { useEffect, useRef } from "react";
import { relativeTime, VIEWS, type ListItem } from "../lib/views";
import { currentItems, useStore } from "../store";
import type { InboxEvent, Snapshot } from "../types";
import { EVENT_ICON, Icon } from "./icons";
import { Avatar, StatusPill } from "./primitives";

const KIND_TONE: Record<InboxEvent["kind"], string> = {
  mention: "bg-progress-bg text-progress",
  comment: "bg-todo-bg text-todo",
  status: "bg-review-bg text-review",
  assigned: "bg-done-bg text-done",
  field: "bg-todo-bg text-todo",
};

const EMPTY: Partial<Record<string, [string, string]>> = {
  inbox: ["Inbox zero", "New mentions, assignments and changes on your tickets land here."],
  snoozed: ["Nothing snoozed", "Press s on an item to bring it back later."],
  done: ["Nothing done yet", "Press e to clear an item from your inbox."],
};

export function ItemList() {
  const state = useStore();
  const { snap, view, project, selectedId, select, openOverlay } = state;
  const items = currentItems(state);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  if (!snap) return null;
  const unread = items.filter((i) => i.event?.unread).length;
  const label = VIEWS.find((v) => v.id === view)?.label;

  return (
    <section className="flex min-h-0 flex-col border-r border-sep bg-win">
      <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center gap-2 border-b border-sep bg-bar px-3 max-[1040px]:pl-20">
        <div data-tauri-drag-region>
          <h2 className="text-sm font-semibold">{project ? `${project} · ${label}` : label}</h2>
          <div className="text-sm text-ink-3">
            {items.length ? (unread ? `${unread} unread · ${items.length} total` : `${items.length} items`) : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={() => openOverlay("palette")}
          className="ml-auto flex items-center gap-1.5 rounded-[7px] border border-field-border bg-field px-2 py-0.5 text-sm text-ink-3"
        >
          <Icon name="search" className="size-3" /> Search <kbd>⌘K</kbd>
        </button>
      </header>

      <div ref={listRef} role="listbox" aria-label={label} className="min-h-0 flex-1 overflow-auto p-1.5">
        {items.length === 0 ? (
          <div className="px-5 py-10 text-center text-ink-3">
            <b className="mb-1 block text-[14px] text-ink-2">{(EMPTY[view] ?? ["Nothing here", ""])[0]}</b>
            {(EMPTY[view] ?? ["", ""])[1]}
          </div>
        ) : (
          items.map((it, i) => (
            <Row
              key={it.id}
              item={it}
              snap={snap}
              groupStart={view === "mine" && snap.tickets[it.ticketKey].status.name !== snap.tickets[items[i - 1]?.ticketKey]?.status.name}
              selected={it.id === selectedId}
              onSelect={() => select(it.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function Row({
  item,
  snap,
  selected,
  groupStart,
  onSelect,
}: {
  item: ListItem;
  snap: Snapshot;
  selected: boolean;
  groupStart: boolean;
  onSelect: () => void;
}) {
  const now = useStore((s) => s.now);
  const t = snap.tickets[item.ticketKey];
  const e = item.event;
  const sub = selected ? "text-white/80" : "text-ink-2";
  const first = e?.actor.name.split(" ")[0];
  const what = e ? `${first}: ${e.text}` : [t.type, t.priority, t.sprint].filter(Boolean).join(" · ");

  return (
    <>
      {groupStart && (
        <div className="px-2.5 pt-3 pb-1">
          <StatusPill status={t.status} />
        </div>
      )}
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        className={`grid w-full grid-cols-[10px_26px_1fr] gap-2 rounded-lg py-2 pr-2.5 pl-1.5 text-left ${selected ? "bg-accent text-white" : "hover:bg-hover"}`}
      >
        <span className={`mt-[7px] size-2 rounded-full ${e?.unread ? (selected ? "bg-white" : "bg-accent") : ""}`} />
        {e ? (
          <span className={`mt-px grid size-[26px] place-items-center rounded-full ${KIND_TONE[e.kind]}`}>
            <Icon name={EVENT_ICON[e.kind]} className="size-3.5" />
          </span>
        ) : (
          <span className="mt-0.5">
            <Avatar person={t.assignee} size={22} />
          </span>
        )}
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={`shrink-0 font-mono text-[11.5px] font-semibold ${sub}`}>{t.key}</span>
            <span className="min-w-0 truncate font-semibold">{t.summary}</span>
            {e && (
              <span className={`ml-auto shrink-0 text-[11.5px] tabular-nums ${selected ? "text-white/80" : "text-ink-3"}`}>
                {relativeTime(e.at, now)}
              </span>
            )}
          </span>
          <span className={`mt-0.5 line-clamp-2 ${sub}`}>{what}</span>
        </span>
      </button>
    </>
  );
}
