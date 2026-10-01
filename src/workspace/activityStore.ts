import { create } from "zustand";
import type { Backend } from "../backend/types";
import type { ContainerRef, FeedCursor, FeedEntry, WorkEvent } from "../types";
import { codeEventUnread, isCodeUnread, queryFor, withRead, type ActivityChip, type ActivitySource } from "./activityLogic";
import { readStored, writeStored } from "./storage";
import { messageOf, useToasts } from "./toasts";

const READ_KEY = "gossamr-code-read";
const RUN_READ_KEY = "gossamr-runs-activity-read";
const READ_KEPT = 500;
const CODE_EVENTS = 100;

const loadRead = (key = READ_KEY): Set<string> => {
  const raw = readStored(key);
  return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
};

interface ActivityState {
  chip: ActivityChip;
  source: ActivitySource;
  /** GitHub events, newest first; the feed merges them with `entries`. */
  codeEvents: WorkEvent[];
  /** Ids of GitHub events the person has opened or marked read. */
  codeRead: ReadonlySet<string>;
  /** Ids of agent entries (`run:<id>:<what>`) the person has opened or marked read. */
  runRead: ReadonlySet<string>;
  /** GitHub events that want attention and haven't been dealt with. */
  codeUnread: number;
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
  setSource(source: ActivitySource): void;
  markCodeRead(ids: string[]): void;
  markRunRead(ids: string[]): void;
  /** Loads the feed for a project, or keeps what is shown when it is the one already loaded. */
  showProject(container: ContainerRef | null): void;
  reload(): Promise<void>;
  loadMore(): Promise<void>;
  /** Marks unread entries read. Resolves false when the backend refused. */
  markRead(ids: string[]): Promise<boolean>;
  /** Marks everything unread in the current project read, not only the entries loaded so far. */
  markAllRead(codeIds?: string[]): Promise<void>;
}

const idle = { entries: [], codeEvents: [] as WorkEvent[], codeUnread: 0, next: null, status: "idle" as const, loadingMore: false, error: null, unread: 0 };

let stop: (() => void) | null = null;
let seq = 0;
const MARK_ALL_LIMIT = 200;

const sameContainer = (a: ContainerRef | null, b: ContainerRef | null) => (a && b ? a.connectionId === b.connectionId && a.externalId === b.externalId : a === b);

export const useActivity = create<ActivityState>((set, get) => ({
  chip: "all",
  source: "all",
  container: null,
  backend: null,
  codeRead: loadRead(),
  runRead: loadRead(RUN_READ_KEY),
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

  setSource(source) {
    if (source === get().source) return;
    set({ source });
    void get().reload();
  },

  markCodeRead(ids) {
    const fresh = ids.filter((id) => !get().codeRead.has(id));
    if (!fresh.length) return;
    const read = new Set([...get().codeRead, ...fresh]);
    const kept = new Set([...read].slice(-READ_KEPT));
    writeStored(READ_KEY, [...kept]);
    set((s) => ({ codeRead: kept, codeUnread: codeEventUnread(s.codeEvents, kept, Date.now()) }));
  },

  markRunRead(ids) {
    const fresh = ids.filter((id) => !get().runRead.has(id));
    if (!fresh.length) return;
    const kept = new Set([...get().runRead, ...fresh].slice(-READ_KEPT));
    writeStored(RUN_READ_KEY, [...kept]);
    set({ runRead: kept });
  },

  showProject(container) {
    if (sameContainer(container, get().container) && get().status !== "idle") return;
    set({ container });
    void get().reload();
  },

  async reload() {
    const { backend, chip, container, source } = get();
    if (!backend || chip === "drafts") return;
    const mine = ++seq;
    set((s) => ({ status: s.entries.length || s.codeEvents.length ? s.status : "loading", error: null, loadingMore: false }));
    try {
      const [page, code] = await Promise.all([
        source === "github" || source === "agents" ? Promise.resolve({ entries: [], next: null }) : backend.cacheFeed(queryFor(chip, container)),
        // A host that can't be reached doesn't stop the tracker's feed from showing.
        source === "agents" ? Promise.resolve([]) : backend.codeEvents(CODE_EVENTS).catch((e) => (source === "github" ? Promise.reject(e) : [])),
      ]);
      if (mine === seq) set((s) => ({ entries: page.entries, next: page.next, codeEvents: code, codeUnread: codeEventUnread(code, s.codeRead, Date.now()), status: "ready" }));
    } catch (e) {
      if (mine === seq) set({ status: "error", error: messageOf(e) });
    }
  },

  async loadMore() {
    const { backend, chip, container, next, loadingMore, source } = get();
    if (!backend || !next || loadingMore || chip === "drafts" || source === "github" || source === "agents") return;
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

  async markAllRead(codeIds?: string[]) {
    const { backend, container, codeEvents, codeRead, source } = get();
    if (!backend) return;
    // GitHub events only know their project through their ticket, which the page resolves; without a project they are all in scope.
    const scoped = codeIds ?? (container ? [] : codeEvents.filter((e) => isCodeUnread(e, codeRead, Date.now())).map((e) => e.id));
    if (source === "all" || source === "github") get().markCodeRead(scoped);
    if (source === "github" || source === "agents") return;
    let page;
    try {
      page = await backend.cacheFeed({ container, unreadOnly: true, limit: MARK_ALL_LIMIT });
    } catch (e) {
      useToasts.getState().push(`Couldn't mark read: ${messageOf(e)}`);
      return;
    }
    if (await get().markRead(page.entries.map((e) => e.id)) && page.next) await get().markAllRead([]);
  },
}));
