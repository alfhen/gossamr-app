import { create } from "zustand";
import type { Backend } from "../backend/types";
import type { ContainerRef, FeedCursor, FeedEntry } from "../types";
import { queryFor, withRead, type ActivityChip } from "./activityLogic";
import { messageOf, useToasts } from "./toasts";

interface ActivityState {
  chip: ActivityChip;
  container: ContainerRef | null;
  entries: FeedEntry[];
  next: FeedCursor | null;
  status: "idle" | "loading" | "ready" | "error";
  loadingMore: boolean;
  error: string | null;
  /** Unread entries across the connection, for the rail badge. */
  unread: number;
  backend: Backend | null;
  init(backend: Backend): void;
  dispose(): void;
  setChip(chip: ActivityChip): void;
  /** Loads the feed for a project, or keeps what is shown when it is the one already loaded. */
  showProject(container: ContainerRef | null): void;
  reload(): Promise<void>;
  loadMore(): Promise<void>;
  /** Marks unread entries read. Resolves false when the backend refused. */
  markRead(ids: string[]): Promise<boolean>;
  /** Marks everything unread in the current project read, not only the entries loaded so far. */
  markAllRead(): Promise<void>;
}

const idle = { entries: [], next: null, status: "idle" as const, loadingMore: false, error: null, unread: 0 };

let stop: (() => void) | null = null;
let seq = 0;
const MARK_ALL_LIMIT = 200;

const sameContainer = (a: ContainerRef | null, b: ContainerRef | null) => (a && b ? a.connectionId === b.connectionId && a.externalId === b.externalId : a === b);

export const useActivity = create<ActivityState>((set, get) => ({
  chip: "all",
  container: null,
  backend: null,
  ...idle,

  init(backend) {
    get().dispose();
    set({ backend, ...idle });
    const refresh = () => {
      void get().reload();
      backend.cacheFeedUnread().then((unread) => get().backend === backend && set({ unread }), () => {});
    };
    const off = backend.onCacheChanged(refresh);
    stop = off;
    refresh();
  },

  dispose() {
    stop?.();
    stop = null;
    seq++;
    set({ backend: null, ...idle });
  },

  setChip(chip) {
    if (chip === get().chip) return;
    set({ chip });
    void get().reload();
  },

  showProject(container) {
    if (sameContainer(container, get().container) && get().status !== "idle") return;
    set({ container });
    void get().reload();
  },

  async reload() {
    const { backend, chip, container } = get();
    if (!backend || chip === "drafts") return;
    const mine = ++seq;
    set((s) => ({ status: s.entries.length ? s.status : "loading", error: null, loadingMore: false }));
    try {
      const page = await backend.cacheFeed(queryFor(chip, container));
      if (mine === seq) set({ entries: page.entries, next: page.next, status: "ready" });
    } catch (e) {
      if (mine === seq) set({ status: "error", error: messageOf(e) });
    }
  },

  async loadMore() {
    const { backend, chip, container, next, loadingMore } = get();
    if (!backend || !next || loadingMore || chip === "drafts") return;
    const mine = seq;
    set({ loadingMore: true });
    try {
      const page = await backend.cacheFeed({ ...queryFor(chip, container), before: next });
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
    const { backend, container } = get();
    if (!backend) return;
    let page;
    try {
      page = await backend.cacheFeed({ container, unreadOnly: true, limit: MARK_ALL_LIMIT });
    } catch (e) {
      useToasts.getState().push(`Couldn't mark read: ${messageOf(e)}`);
      return;
    }
    if (await get().markRead(page.entries.map((e) => e.id)) && page.next) await get().markAllRead();
  },
}));
