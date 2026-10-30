import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { itemKey } from "../lib/filter";
import { pressed, stepOf } from "../lib/keys";
import { relativeTime } from "../lib/views";
import type { FeedEntry } from "../types";
import { nameOf, useWorkspace } from "../workspaceStore";
import { FILTER_LABEL, groupByDay, initials, stepIndex, verb, type InboxFilter } from "./activityLogic";
import { useActivity } from "./activityStore";
import { showMe } from "./jump";
import { useTabs } from "./tabsStore";
import { StrayNotices } from "./WatchNotices";
import { Button } from "../components/Button";
import { Segmented } from "../components/Segmented";

export const feedRowId = (id: string) => `feed-${id}`;

export interface FeedRowProps {
  entry: FeedEntry;
  actor: string;
  title: string;
  now: Date;
  selected: boolean;
  /** False when the item has left the cache and can't be opened. */
  openable: boolean;
  position: number;
  total: number;
  onOpen(): void;
  onMarkRead(): void;
  onShow(): void;
}


export function FeedRow({ entry: e, actor, title, now, selected, openable, position, total, onOpen, onMarkRead, onShow }: FeedRowProps) {
  const onKey = (ev: KeyboardEvent) => {
    if (ev.target !== ev.currentTarget || !openable) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      onOpen();
    }
  };
  return (
    <article
      id={feedRowId(e.id)}
      tabIndex={0}
      aria-posinset={position}
      aria-setsize={total}
      aria-current={selected ? "true" : undefined}
      data-unread={e.unread ? "true" : undefined}
      onKeyDown={onKey}
      className={`group flex gap-3 rounded-lg px-2 py-2.5 outline-offset-[-2px] hover:bg-ws-hover ${selected ? "bg-ws-sel" : ""}`}
    >
      <span aria-hidden className={`mt-2 size-2 shrink-0 rounded-full ${e.unread ? "bg-ws-accent" : "bg-transparent"}`} />
      <span aria-hidden className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-ws-accent-soft text-xs font-semibold text-ws-accent">
        {initials(actor)}
      </span>
      <div className="min-w-0 flex-1">
        <button type="button" disabled={!openable} onClick={onOpen} className="block w-full text-left disabled:cursor-default">
          <span className={e.unread ? "font-semibold" : ""}>
            {actor} <span className="font-normal text-ws-ink2">{verb(e)}</span>{" "}
            <span className="font-mono text-sm font-semibold text-ws-ink2">{e.item.key}</span>
            <span className="font-normal text-ws-ink2"> {title}</span>
          </span>
          {e.text && <span className="mt-0.5 line-clamp-2 block text-ws-ink2 [overflow-wrap:anywhere]">{e.text}</span>}
        </button>
        <div className="mt-1 flex items-center gap-1 text-sm text-ws-ink3">
          <time dateTime={e.at}>{relativeTime(e.at, now)}</time>
          <span className="ml-auto flex gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
            {openable && (
              <Button variant="plain" size="sm" onClick={onShow}>
                Show me
              </Button>
            )}
            {e.unread && (
              <Button variant="plain" size="sm" onClick={onMarkRead}>
                Mark read
              </Button>
            )}
          </span>
        </div>
      </div>
    </article>
  );
}

export function DayHeading({ label, level = 3 }: { label: string; level?: 2 | 3 }) {
  const H = `h${level}` as const;
  return <H className="sticky top-0 z-10 m-0 bg-ws-win px-2 pt-4 pb-1 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">{label}</H>;
}

/** The Inbox's one filter, a toggle: only what mentions you. */
export function MentionsFilter({ filter, onChange }: { filter: InboxFilter; onChange(filter: InboxFilter): void }) {
  const on = filter === "mentions";
  return (
    <Segmented label="Show" value={on ? "mentions" : null} onChange={() => onChange(on ? "all" : "mentions")} options={[{ value: "mentions", label: FILTER_LABEL.mentions, attrs: { "data-filter": "mentions" } }]} />
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="m-0 py-12 text-center text-ws-ink3">
      {children}
    </p>
  );
}

const EMPTY: Record<InboxFilter, string> = {
  all: "Nothing has happened on your tickets yet.",
  mentions: "Nobody has mentioned you.",
};

export function ActivityView() {
  const items = useWorkspace((s) => s.items);
  const names = useWorkspace((s) => s.names);
  const selected = useTabs((s) => s.selected);
  const { filter, entries, next, status, error, loadingMore, unread } = useActivity();
  const [now, setNow] = useState(() => new Date());
  const sentinel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => groupByDay(entries, now), [entries, now]);

  useEffect(() => setNow(new Date()), [entries]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !next || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && void useActivity.getState().loadMore());
    io.observe(el);
    return () => io.disconnect();
  }, [next, entries.length]);

  const open = (e: FeedEntry) => {
    useTabs.getState().select(itemKey(e.item));
    void useActivity.getState().markRead(e.unread ? [e.id] : []);
  };

  const shownRef = useRef(entries);
  shownRef.current = entries;

  useEffect(() => {
    const onKey = (ev: globalThis.KeyboardEvent) => {
      const target = ev.target as HTMLElement;
      if (target.closest?.("[role=dialog], #peek-sheet")) return;
      const delta = stepOf(ev, "inbox");
      if (delta) {
        const articles = [...(list.current?.querySelectorAll<HTMLElement>("article[id^='feed-']") ?? [])];
        if (!articles.length) return;
        ev.preventDefault();
        const to = articles[stepIndex(articles.indexOf(target.closest("article") as HTMLElement), delta, articles.length)];
        to?.focus();
        to?.scrollIntoView({ block: "nearest" });
      } else if (pressed(ev, "inbox", "markRead")) {
        const id = target.closest?.("article")?.id.replace(/^feed-/, "");
        const entry = shownRef.current.find((e) => e.id === id);
        if (entry?.unread) {
          ev.preventDefault();
          void useActivity.getState().markRead([entry.id]);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  let position = 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ws-sep px-6 py-2.5">
        <h1 className="m-0 text-base font-semibold">Inbox</h1>
        <MentionsFilter filter={filter} onChange={(f) => useActivity.getState().setFilter(f)} />
        <button type="button" disabled={unread === 0} onClick={() => void useActivity.getState().markAllRead()} className="ml-auto text-sm text-ws-ink3 underline disabled:no-underline disabled:opacity-45">
          Mark all read
        </button>
      </header>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(32px,var(--ws-launcher-clear,0px))]">
        <div className="mx-auto max-w-[780px]">
          <StrayNotices />
          {status === "error" ? (
            <div role="alert" className="grid justify-items-center gap-2 py-12 text-ws-blocked">
              <p className="m-0">{error}</p>
              <button type="button" className="rounded-md border border-ws-sep2 px-3 py-1 text-ws-ink" onClick={() => void useActivity.getState().reload()}>
                Try again
              </button>
            </div>
          ) : status !== "ready" ? (
            <EmptyNote>Loading your inbox…</EmptyNote>
          ) : groups.length === 0 ? (
            <EmptyNote>{EMPTY[filter]}</EmptyNote>
          ) : (
            <div role="feed" aria-label="Inbox" aria-busy={loadingMore}>
              {groups.map((g) => (
                <section key={g.day} aria-label={g.label}>
                  <DayHeading label={g.label} />
                  {g.entries.map((e) => {
                    const key = itemKey(e.item);
                    const item = items[key];
                    return (
                      <FeedRow
                        key={e.id}
                        entry={e}
                        actor={e.actorName ?? nameOf({ names }, e.actor).replace("Unassigned", "Someone")}
                        title={e.itemTitle ?? item?.title ?? ""}
                        now={now}
                        selected={selected === key}
                        openable={!!item}
                        position={++position}
                        total={entries.length}
                        onOpen={() => open(e)}
                        onMarkRead={() => void useActivity.getState().markRead([e.id])}
                        onShow={() => (open(e), showMe(e.item))}
                      />
                    );
                  })}
                </section>
              ))}
              <div ref={sentinel} className="grid place-items-center py-4">
                {next && (
                  <button type="button" disabled={loadingMore} onClick={() => void useActivity.getState().loadMore()} className="rounded-md border border-ws-sep2 px-3 py-1 text-sm text-ws-ink2 hover:bg-ws-hover disabled:opacity-45">
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
