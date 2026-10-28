import { create } from "zustand";
import type { Backend } from "../backend/types";
import type { FeedCursor, FeedEntry } from "../types";
import { INBOX_KINDS, queryFor, withRead, type InboxFilter } from "./activityLogic";
import { messageOf, useToasts } from "./toasts";

interface ActivityState {
  filter: InboxFilter;
  entries: FeedEntry[];
  next: FeedCursor | null;
  status: "idle" | "loading" | "ready" | "error";
  loadingMore: boolean;
  error: string | null;
  /** Unread entries across the connection, for the palette. */
  unread: number;
  backend: Backend | null;
  init(backend: Backend): void;
  dispose(): void;
  setFilter(filter: InboxFilter): void;
  reload(): Promise<void>;
  loadMore(): Promise<void>;
  /** Marks unread entries read. Resolves false when the backend refused. */
  markRead(ids: string[]): Promise<boolean>;
  /** Marks everything unread read, not only the entries loaded so far. */
  markAllRead(): Promise<void>;
}

const idle = { entries: [], next: null, status: "idle" as const, loadingMore: false, error: null, unread: 0 };

let stop: (() => void) | null = null;
let seq = 0;
const MARK_ALL_LIMIT = 200;

export const useActivity = create<ActivityState>((set, get) => ({
  filter: "all",
  backend: null,
  ...idle,

  init(backend) {
    get().dispose();
    set({ backend, ...idle });
    const refresh = () => {
      void get().reload();
      backend.cacheFeedUnread(INBOX_KINDS).then((unread) => get().backend === backend && set({ unread }), () => {});
    };
    stop = backend.onCacheChanged(refresh);
    refresh();
  },

  dispose() {
    stop?.();
    stop = null;
    seq++;
    set({ backend: null, ...idle });
  },

  setFilter(filter) {
    if (filter === get().filter) return;
    set({ filter });
    void get().reload();
  },

  async reload() {
    const { backend, filter } = get();
    if (!backend) return;
    const mine = ++seq;
    set((s) => ({ status: s.entries.length ? s.status : "loading", error: null, loadingMore: false }));
    try {
      const page = await backend.cacheFeed(queryFor(filter));
      if (mine === seq) set({ entries: page.entries, next: page.next, status: "ready" });
    } catch (e) {
      if (mine === seq) set({ status: "error", error: messageOf(e) });
    }
  },

  async loadMore() {
    const { backend, filter, next, loadingMore } = get();
    if (!backend || !next || loadingMore) return;
    const mine = seq;
    set({ loadingMore: true });
    try {
      const page = await backend.cacheFeed({ ...queryFor(filter), before: next });
      if (mine !== seq) return;
      const seen = new Set(get().entries.map((e) => e.id));
      set((s) => ({ entries: [...s.entries, ...page.entries.filter((e) => !seen.has(e.id))], next: page.next, loadingMore: false }));
    } catch (e) {
      if (mine === seq) set({ loadingMore: false });
      useToasts.getState().push(`Couldn't load more: ${messageOf(e)}`);
    }
  },

  async markRead(ids) {
    const { backend } = get();
    if (!backend || !ids.length) return true;
    set((s) => ({ entries: withRead(s.entries, new Set(ids), false), unread: Math.max(0, s.unread - ids.length) }));
    try {
      await Promise.all(ids.map((id) => backend.setUnread(id, false)));
      return true;
    } catch (e) {
      useToasts.getState().push(`Couldn't mark read: ${messageOf(e)}`);
      void get().reload();
      return false;
    }
  },

  async markAllRead() {
    const { backend } = get();
    if (!backend) return;
    let page;
    try {
      page = await backend.cacheFeed({ kinds: INBOX_KINDS, unreadOnly: true, limit: MARK_ALL_LIMIT });
    } catch (e) {
      useToasts.getState().push(`Couldn't mark read: ${messageOf(e)}`);
      return;
    }
    if (await get().markRead(page.entries.map((e) => e.id)) && page.next) await get().markAllRead();
  },
}));
