import { create } from "zustand";
import type { Backend } from "../backend/types";
import { itemKey } from "../lib/filter";
import { summarize, type CodeSummary } from "../lib/devLinks";
import type { DevLink, ItemRef } from "../types";

/** Reads go to the local cache, but a screen full of items must not turn into one request each at once. */
const CONCURRENCY = 4;
const FLUSH_MS = 40;
/** The first items of a canvas; further ones are read when they are scrolled to or filtered on. */
export const VISIBLE_LIMIT = 200;
/** Filtering on code reads further than what is on screen. */
export const FILTER_LIMIT = 500;
const QUEUE_LIMIT = 600;

interface DevState {
  backend: Backend | null;
  enabled: boolean;
  /** What each item's linked code adds up to, by `itemKey`. An item that was read and has none has an entry with zeroes. */
  index: ReadonlyMap<string, CodeSummary>;
  /** The ticket each pull request read so far belongs to, by the pull request's id. */
  byChange: ReadonlyMap<string, ItemRef>;
  init(backend: Backend): void;
  dispose(): void;
  /** Code is only read while a code host is connected. */
  setEnabled(enabled: boolean): void;
  /** Reads the links of these items that aren't known yet, a few at a time, these ahead of any still waiting. */
  ensure(refs: readonly ItemRef[]): void;
  /** Reads one item again, as when its Development section learned something new. */
  refreshItem(ref: ItemRef): Promise<void>;
  /** Forgets everything and reads again what was asked for last. */
  invalidate(): void;
}

let stop: (() => void) | null = null;
let generation = 0;
let waiting: ItemRef[] = [];
let running = 0;
let asked: ItemRef[] = [];
let pending = new Map<string, CodeSummary>();
let pendingChanges = new Map<string, ItemRef>();

const changesOf = (links: readonly DevLink[], ref: ItemRef) => links.map((l) => [l.change.externalId, ref] as const);
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const inFlight = new Set<string>();

export const useDev = create<DevState>((set, get) => {
  const flush = () => {
    flushTimer = null;
    if (!pending.size) return;
    const add = pending;
    const changes = pendingChanges;
    pending = new Map();
    pendingChanges = new Map();
    set((s) => ({ index: new Map([...s.index, ...add]), byChange: new Map([...s.byChange, ...changes]) }));
  };

  const pump = () => {
    const { backend, enabled } = get();
    const mine = generation;
    // A read started before an invalidation may still be running; its key waits for it instead of being read twice.
    const blocked: ItemRef[] = [];
    while (backend && enabled && running < CONCURRENCY && waiting.length) {
      const ref = waiting.shift()!;
      const key = itemKey(ref);
      if (get().index.has(key) || pending.has(key)) continue;
      if (inFlight.has(key)) {
        blocked.push(ref);
        continue;
      }
      running++;
      inFlight.add(key);
      backend
        .devLinks(ref)
        .then(
          (links) => {
            if (mine !== generation) return;
            pending.set(key, summarize(links));
            for (const [id, r] of changesOf(links, ref)) pendingChanges.set(id, r);
          },
          () => {
            // A failed read leaves the item unknown, so a later ensure tries again.
          },
        )
        .finally(() => {
          running--;
          inFlight.delete(key);
          if (mine === generation && !flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
          pump();
        });
    }
    waiting = [...blocked, ...waiting];
  };

  return {
    backend: null,
    enabled: false,
    index: new Map(),
    byChange: new Map(),

    init(backend) {
      get().dispose();
      set({ backend });
      const offLinks = backend.onDevLinksChanged(() => get().invalidate());
      const offWatch = backend.onWatchChanged(() => get().invalidate());
      stop = () => {
        offLinks();
        offWatch();
      };
    },

    dispose() {
      stop?.();
      stop = null;
      generation++;
      waiting = [];
      asked = [];
      pending = new Map();
      pendingChanges = new Map();
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      set({ backend: null, enabled: false, index: new Map(), byChange: new Map() });
    },

    setEnabled(enabled) {
      if (enabled === get().enabled) return;
      set({ enabled });
      if (enabled) get().invalidate();
      else {
        generation++;
        waiting = [];
        pending = new Map();
        pendingChanges = new Map();
            set({ index: new Map(), byChange: new Map() });
      }
    },

    ensure(refs) {
      const { index } = get();
      const seen = new Set<string>();
      const fresh = [...refs, ...waiting].filter((r) => {
        const key = itemKey(r);
        if (index.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      waiting = fresh.slice(0, QUEUE_LIMIT);
      asked = [...new Map([...asked, ...refs].map((r) => [itemKey(r), r])).values()].slice(-QUEUE_LIMIT);
      pump();
    },

    async refreshItem(ref) {
      const { backend, enabled } = get();
      if (!backend || !enabled) return;
      const mine = generation;
      try {
        const links = await backend.devLinks(ref);
        if (mine === generation) set((s) => ({ index: new Map([...s.index, [itemKey(ref), summarize(links)]]), byChange: new Map([...s.byChange, ...changesOf(links, ref)]) }));
      } catch {
        // The Development section shows its own error; the badge keeps what it had.
      }
    },

    invalidate() {
      generation++;
      pending = new Map();
      pendingChanges = new Map();
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      set({ index: new Map(), byChange: new Map() });
      waiting = [...asked];
      pump();
    },
  };
});
