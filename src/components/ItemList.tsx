import { useEffect, useRef, type ReactNode } from "react";
import { age, describeActions, INBOX_TABS, WITHER_DAYS, witherLevel, type WitherLevel, isInboxView, relativeTime, standupNotes, viewCounts, VIEWS, WORK_RANGES, type ListItem, type Waiting } from "../lib/views";
import { currentItems, useStore } from "../store";
import type { InboxEvent, Snapshot } from "../types";
import { EVENT_ICON, Icon } from "./icons";
import { Cobweb } from "./Cobweb";
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
  done: ["Archive is empty", "Press e to clear an item from your inbox."],
  waiting: ["Nobody is waiting on you", "Unanswered mentions, tickets you haven't started and reviews on tickets you reported show up here."],
  work: ["Nothing in this range", "Tickets assigned to you, and anything else you worked on, show up here."],
};

export function ItemList() {
  const state = useStore();
  const { snap, view, project, selectedId, select, openOverlay, setView, workDays, setWorkDays } = state;
  const items = currentItems(state);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  if (!snap) return null;
  const rows = items.filter((i) => !i.inStack);
  const unread = rows.filter((i) => (i.stack ?? (i.event ? [i.event] : [])).some((e) => e.unread)).length;
  const inbox = isInboxView(view);
  const label = inbox ? "Inbox" : VIEWS.find((v) => v.id === view)?.label;
  const counts = viewCounts(snap, state.now);
  const control = "rounded-[7px] border border-field-border bg-field px-2 py-0.5 text-sm whitespace-nowrap hover:bg-hover";

  return (
    <section className="flex min-h-0 flex-col border-r border-sep bg-win">
      <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center gap-2 border-b border-sep bg-bar px-3 max-[1040px]:pl-20">
        <div data-tauri-drag-region>
          <h2 className="text-sm font-semibold whitespace-nowrap">{project ? `${project} · ${label}` : label}</h2>
          <div className="text-sm text-ink-3">
            {rows.length ? (unread ? `${unread} unread · ${rows.length} total` : `${rows.length} items`) : ""}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => openOverlay("palette")}
          className="flex items-center gap-1.5 rounded-[7px] border border-field-border bg-field px-2 py-0.5 text-sm text-ink-3"
        >
          <Icon name="search" className="size-3" /> Search <kbd>⌘K</kbd>
        </button>
        </div>
      </header>

      {view === "work" && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-sep bg-bar px-2 py-1.5">
          <select aria-label="Date range" value={workDays} onChange={(e) => setWorkDays(Number(e.target.value))} className={control}>
            {WORK_RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            title="Copy what you did in this range as standup notes"
            onClick={() =>
              void navigator.clipboard
                .writeText(standupNotes(snap, state.now, workDays))
                .then(() => state.showToast("Copied standup notes"))
            }
            className={`ml-auto ${control}`}
          >
            Copy standup
          </button>
        </div>
      )}

      {inbox && (
        <nav role="tablist" aria-label="Inbox" className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-sep bg-bar px-2 py-1.5">
          {INBOX_TABS.map((t) => {
            const n = t.id === "done" ? 0 : counts[t.id];
            const current = view === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={current}
                onClick={() => setView(t.id, project)}
                className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-sm whitespace-nowrap ${
                  current ? "bg-win font-semibold shadow-[0_0_0_1px_var(--color-sep-strong)]" : "text-ink-2 hover:bg-hover"
                }`}
              >
                {t.label}
                {n > 0 && <span className={`tabular-nums ${t.id === "inbox" || t.id === "waiting" ? "text-accent" : "text-ink-3"}`}>{n}</span>}
              </button>
            );
          })}
        </nav>
      )}

      <div ref={listRef} role="listbox" aria-label={label} className="min-h-0 flex-1 overflow-auto p-1.5">
        {items.length === 0 ? (
          <div className="px-5 py-10 text-center text-ink-3">
            <b className="mb-1 block text-[14px] text-ink-2">{(EMPTY[view] ?? ["Nothing here", ""])[0]}</b>
            {(EMPTY[view] ?? ["", ""])[1]}
          </div>
        ) : (
          items.map((it, i) => {
            const selected = it.id === selectedId;
            const onSelect = () => select(it.id);
            if (it.stack) {
              return <StackRow key={it.id} item={it} stack={it.stack} snap={snap} selected={selected} onSelect={onSelect} />;
            }
            if (it.waiting) {
              return <WaitingRow key={it.id} item={it} waiting={it.waiting} snap={snap} selected={selected} onSelect={onSelect} />;
            }
            if (it.work) {
              const sectionStart = items[i - 1]?.work?.section !== it.work.section;
              const count = sectionStart ? items.filter((x) => x.work?.section === it.work!.section).length : 0;
              return <WorkRow key={it.id} item={it} snap={snap} sectionCount={count} selected={selected} onSelect={onSelect} />;
            }
            if (it.inStack && it.event) {
              const last = !items[i + 1]?.inStack;
              return <StackedUpdate key={it.id} event={it.event} last={last} selected={selected} onSelect={onSelect} />;
            }
            return (
              <Row key={it.id} item={it} snap={snap} selected={selected} onSelect={onSelect} />
            );
          })
        )}
      </div>
    </section>
  );
}

function Row({
  item,
  snap,
  selected,
  onSelect,
}: {
  item: ListItem;
  snap: Snapshot;
  selected: boolean;
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
          {e ? (
            <span className={`mt-0.5 line-clamp-2 ${sub}`}>{what}</span>
          ) : (
            <span className={`mt-0.5 flex min-w-0 items-center gap-1.5 ${sub}`}>
              <StatusPill status={t.status} />
              <span className="min-w-0 truncate">{what}</span>
            </span>
          )}
        </span>
      </button>
    </>
  );
}

const KIND_ORDER: InboxEvent["kind"][] = ["mention", "assigned", "comment", "status", "field"];
const KIND_LABEL: Record<InboxEvent["kind"], [string, string]> = {
  mention: ["mention", "mentions"],
  assigned: ["assignment", "assignments"],
  comment: ["comment", "comments"],
  status: ["status change", "status changes"],
  field: ["edit", "edits"],
};

function describeStack(stack: InboxEvent[]): string {
  return KIND_ORDER.flatMap((k) => {
    const n = stack.filter((e) => e.kind === k).length;
    return n ? [`${n} ${KIND_LABEL[k][n > 1 ? 1 : 0]}`] : [];
  }).join(", ");
}

function StackRow({
  item,
  stack,
  snap,
  selected,
  onSelect,
}: {
  item: ListItem;
  stack: InboxEvent[];
  snap: Snapshot;
  selected: boolean;
  onSelect: () => void;
}) {
  const now = useStore((s) => s.now);
  const open = useStore((s) => s.expanded.has(item.ticketKey));
  const toggle = () => {
    onSelect();
    useStore.getState().setStackOpen(!open);
  };
  const t = snap.tickets[item.ticketKey];
  const latest = stack[0];
  const unread = stack.filter((e) => e.unread).length;
  const actors = [...new Map(stack.map((e) => [e.actor.accountId, e.actor])).values()];
  const sub = selected ? "text-white/80" : "text-ink-2";
  const peek = selected ? ["bg-accent/45", "bg-accent/20"] : ["border border-t-0 border-sep-strong bg-bar", "border border-t-0 border-sep-strong bg-side"];

  return (
    <div className={`relative mx-0.5 mt-1 ${open ? "mb-0.5" : "mb-2"}`}>
      {!open && (
        <>
          <span aria-hidden className={`absolute inset-x-4 -bottom-[7px] h-3 rounded-b-lg ${peek[1]}`} />
          <span aria-hidden className={`absolute inset-x-2 -bottom-[4px] h-3 rounded-b-lg ${peek[0]}`} />
        </>
      )}
      <button
        type="button"
        role="option"
        aria-selected={selected}
        aria-expanded={open}
        aria-label={`${t.key}, ${stack.length} updates`}
        onClick={onSelect}
        onDoubleClick={toggle}
        className={`relative grid w-full grid-cols-[10px_26px_1fr] gap-2 rounded-lg border py-2 pr-2.5 pl-1.5 text-left ${
          selected ? "border-accent bg-accent text-white" : "border-sep-strong bg-win hover:bg-bar"
        }`}
      >
        <span className={`mt-[7px] size-2 rounded-full ${unread ? (selected ? "bg-white" : "bg-accent") : ""}`} />
        <span className={`relative mt-px grid size-[26px] place-items-center rounded-full ${KIND_TONE[latest.kind]}`}>
          <Icon name={EVENT_ICON[latest.kind]} className="size-3.5" />
          <span
            className={`absolute -right-1.5 -bottom-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold tabular-nums ring-2 ${
              selected ? "bg-white text-accent ring-accent" : "bg-ink text-win ring-win"
            }`}
          >
            {stack.length}
          </span>
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={`shrink-0 font-mono text-[11.5px] font-semibold ${sub}`}>{t.key}</span>
            <span className="min-w-0 truncate font-semibold">{t.summary}</span>
            <span className={`ml-auto shrink-0 text-[11.5px] tabular-nums ${selected ? "text-white/80" : "text-ink-3"}`}>
              {relativeTime(latest.at, now)}
            </span>
          </span>
          {!open && (
            <span className={`mt-0.5 line-clamp-1 ${sub}`}>
              {latest.actor.name.split(" ")[0]}: {latest.text}
            </span>
          )}
          <span className={`mt-1 flex items-center gap-1.5 pr-7 text-[11.5px] ${selected ? "text-white/80" : "text-ink-3"}`}>
            <span className="flex -space-x-1">
              {actors.slice(0, 3).map((p) => (
                <span key={p.accountId} className={`rounded-full ring-2 ${selected ? "ring-accent" : "ring-win"}`}>
                  <Avatar person={p} size={16} />
                </span>
              ))}
            </span>
            <span className="min-w-0 truncate">
              {unread ? <b className={selected ? "text-white" : "text-accent"}>{unread} new · </b> : null}
              {describeStack(stack)}
            </span>
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={toggle}
        title={open ? "Collapse (←)" : "Expand (→)"}
        aria-label={open ? `Collapse ${t.key}` : `Expand ${t.key}`}
        className={`absolute right-1.5 bottom-1.5 grid size-6 place-items-center rounded-md ${
          selected ? "text-white hover:bg-white/15" : "text-ink-3 hover:bg-hover hover:text-ink"
        }`}
      >
        <Icon name="chevron" className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
    </div>
  );
}

function StackedUpdate({
  event: e,
  last,
  selected,
  onSelect,
}: {
  event: InboxEvent;
  last: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const now = useStore((s) => s.now);
  return (
    <div className={`relative ml-[30px] pl-3 ${last ? "mb-2" : ""}`}>
      <span aria-hidden className={`absolute top-0 left-0 w-px bg-sep-strong ${last ? "h-1/2" : "h-full"}`} />
      <span aria-hidden className="absolute top-1/2 left-0 h-px w-2 bg-sep-strong" />
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        className={`grid w-full grid-cols-[8px_20px_1fr] items-start gap-2 rounded-lg py-1.5 pr-2.5 pl-1 text-left ${selected ? "bg-accent text-white" : "hover:bg-hover"}`}
      >
        <span className={`mt-[6px] size-1.5 rounded-full ${e.unread ? (selected ? "bg-white" : "bg-accent") : ""}`} />
        <span className={`grid size-5 place-items-center rounded-full ${KIND_TONE[e.kind]}`}>
          <Icon name={EVENT_ICON[e.kind]} className="size-3" />
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={`min-w-0 line-clamp-2 ${selected ? "text-white/90" : "text-ink-2"}`}>
            <b className={selected ? "text-white" : "text-ink"}>{e.actor.name.split(" ")[0]}</b> {e.text}
          </span>
          <span className={`ml-auto shrink-0 text-[11.5px] tabular-nums ${selected ? "text-white/80" : "text-ink-3"}`}>
            {relativeTime(e.at, now)}
          </span>
        </span>
      </button>
    </div>
  );
}

const WAITING_LABEL: Record<Waiting["reason"], (who: string) => string> = {
  question: (who) => `${who} asked you something`,
  review: (who) => `${who} sent your ticket to review`,
  unstarted: (who) => `${who} assigned it to you · not started`,
};

function WaitingRow({
  item,
  waiting: w,
  snap,
  selected,
  onSelect,
}: {
  item: ListItem;
  waiting: Waiting;
  snap: Snapshot;
  selected: boolean;
  onSelect: () => void;
}) {
  const now = useStore((s) => s.now);
  const t = snap.tickets[item.ticketKey];
  const level = witherLevel(w.since, now, WITHER_DAYS.waiting);
  const sub = selected ? "text-white/80" : "text-ink-2";
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={`grid w-full grid-cols-[26px_1fr] gap-2 rounded-lg py-2 pr-2.5 pl-2 text-left ${selected ? "bg-accent text-white" : "hover:bg-hover"} ${witherClass(level)}`}
    >
      <Cobweb level={level} />
      <span className="mt-0.5">
        <Avatar person={w.who} size={24} />
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={`shrink-0 font-mono text-[11.5px] font-semibold ${sub}`}>{t.key}</span>
          <span className="min-w-0 truncate font-semibold">{t.summary}</span>
        </span>
        <span className={`mt-0.5 flex items-center gap-1.5 ${sub}`}>
          <span className="min-w-0 truncate">{WAITING_LABEL[w.reason](w.who?.name.split(" ")[0] ?? "Someone")}</span>
          <Age level={level} selected={selected} title={`Waiting on you since ${new Date(w.since).toLocaleString()}`}>
            {age(w.since, now)}
          </Age>
        </span>
      </span>
    </button>
  );
}

function WorkRow({
  item,
  snap,
  sectionCount,
  selected,
  onSelect,
}: {
  item: ListItem;
  snap: Snapshot;
  /** Set on the first row of a section, which then shows the section heading. */
  sectionCount: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const now = useStore((s) => s.now);
  const t = snap.tickets[item.ticketKey];
  const { section, actions, latest } = item.work!;
  const sub = selected ? "text-white/80" : "text-ink-2";
  const did = describeActions(actions);
  const open = section === "In progress" || section === "To do";
  const level = open ? witherLevel(t.updated, now, WITHER_DAYS.ticket) : 0;
  return (
    <>
      {sectionCount > 0 && (
        <div className="flex items-baseline gap-1.5 px-2.5 pt-3 pb-1 text-xs font-semibold text-ink-3">
          {section} <span className="font-normal tabular-nums">{sectionCount}</span>
        </div>
      )}
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        className={`grid w-full grid-cols-[26px_1fr] gap-2 rounded-lg py-2 pr-2.5 pl-2 text-left ${selected ? "bg-accent text-white" : "hover:bg-hover"} ${witherClass(level)}`}
      >
        <Cobweb level={level} />
        <span className="mt-0.5">
          <Avatar person={t.assignee} size={22} />
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={`shrink-0 font-mono text-[11.5px] font-semibold ${sub}`}>{t.key}</span>
            <span className="min-w-0 truncate font-semibold">{t.summary}</span>
            {level === 0 && (
              <span className={`ml-auto shrink-0 text-[11.5px] tabular-nums ${selected ? "text-white/80" : "text-ink-3"}`}>
                {relativeTime(latest, now)}
              </span>
            )}
          </span>
          <span className={`mt-0.5 flex min-w-0 items-center gap-1.5 ${sub}`}>
            {section === "Also worked on" && <StatusPill status={t.status} />}
            <span className="min-w-0 truncate">
              {did ? did.replace(/^./, (c) => c.toUpperCase()) : [t.type, t.priority, t.sprint].filter(Boolean).join(" · ")}
            </span>
            {level > 0 && (
              <Age level={level} selected={selected} title={`No updates since ${new Date(t.updated).toLocaleString()}`}>
                {age(t.updated, now)}
              </Age>
            )}
          </span>
        </span>
      </button>
    </>
  );
}

const witherClass = (level: WitherLevel) => (level ? `wither wither-${Math.min(level, 3)}` : "");

/** How long something has waited, with a dried leaf once it has started to wither. */
function Age({ level, selected, title, children }: { level: WitherLevel; selected: boolean; title: string; children: ReactNode }) {
  const tone = selected ? "bg-white/20 text-white" : level ? "bg-wither-bg text-wither" : "bg-todo-bg text-todo";
  return (
    <span title={title} className={`ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-px text-[11px] font-semibold tabular-nums ${tone}`}>
      {level > 0 && <Icon name="leaf" className={`wither-leaf ${level > 2 ? "size-3.5" : "size-3"}`} />}
      {children}
    </span>
  );
}
