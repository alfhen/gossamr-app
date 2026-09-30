import { useMemo } from "react";
import { create } from "zustand";
import type { Backend } from "./backend/types";
import { ALL, compileFilter, containerKey, itemKey, type FilterContext, type QueryLookup } from "./lib/filter";
import { targetOf } from "./lib/proposals";
import { movesAreOpaque } from "./workspace/boardLogic";
import { messageOf, useToasts } from "./workspace/toasts";
import type {
  ConnectionInfo,
  ContainerRef,
  ItemRef,
  PersonRef,
  Proposal,
  ProposalStateKind,
  StatusDef,
  WorkComment,
  WorkContainer,
  WorkEvent,
  WorkFilter,
  WorkItem,
  Workflow,
} from "./types";

interface WorkspaceState {
  backend: Backend | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** Every cached item, by `itemKey`. */
  items: Record<string, WorkItem>;
  /** Projects and teams with their workflows, by `containerKey`. */
  containers: Record<string, WorkContainer>;
  /** Events per item, newest first, for the items whose events something asked for. */
  events: Record<string, WorkEvent[]>;
  /** Every draft, by id. */
  proposals: Record<string, Proposal>;
  /** Keys of the items waiting on the user, as the backend computes them. */
  needsMe: ReadonlySet<string>;
  /** Comments per item, oldest first, for the items something asked for. */
  comments: Record<string, WorkComment[]>;
  /** Where each item can move, as the tracker said when the item had the status in `statusId`. */
  moves: Record<string, { statusId: string; to: StatusDef[] }>;
  /** The signed-in connections and how their sync is going. */
  connections: ConnectionInfo[];
  /** The user's accounts across connections. */
  me: PersonRef[];
  /** Display names by account id. */
  names: Record<string, string>;
  /** Loads everything and keeps it current until `dispose` or the next `init`. */
  init(backend: Backend): Promise<void>;
  refresh(): Promise<void>;
  refreshProposals(): Promise<void>;
  loadEvents(ref: ItemRef): Promise<void>;
  /** Shows the cached comments at once, then the tracker's. */
  loadComments(ref: ItemRef): Promise<void>;
  /** The statuses `item` can move to now, or null when the tracker couldn't say. Answers are kept while the status holds. */
  loadMoves(item: WorkItem): Promise<StatusDef[] | null>;
  refreshConnections(): Promise<void>;
  syncNow(): Promise<void>;
  /** Shows a failure without blocking anything. */
  report(what: string, e: unknown): void;
  approve(id: string): Promise<Proposal>;
  skip(id: string): Promise<Proposal>;
  /** Drafts moving an item to a status, replacing any transition draft still pending for it. Nothing is written until approval. */
  draftTransition(item: ItemRef, to: StatusDef): Promise<Proposal>;
  dispose(): void;
}

const empty = {
  backend: null,
  status: "idle" as const,
  error: null,
  items: {},
  containers: {},
  events: {},
  proposals: {},
  needsMe: new Set<string>(),
  comments: {},
  moves: {},
  connections: [],
  me: [],
  names: {},
};

const byKey = <T,>(list: T[], key: (t: T) => string): Record<string, T> => Object.fromEntries(list.map((t) => [key(t), t]));

let stop: (() => void) | null = null;
let generation = 0;
let refreshSeq = 0;
const SYNC_FLAG_MS = 20_000;
let proposalSeq = 0;
const commentSeq = new Map<string, number>();
const moving = new Map<string, Promise<StatusDef[] | null>>();
let lastSyncError: string | null = null;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  ...empty,

  async init(backend) {
    get().dispose();
    lastSyncError = null;
    commentSeq.clear();
    const mine = ++generation;
    set({ ...empty, backend, status: "loading" });
    const offCache = backend.onCacheChanged(() => {
      get().refresh().catch((e) => get().report("Couldn't refresh", e));
      void get().refreshConnections();
    });
    const offProposals = backend.onProposalsChanged(() => get().refreshProposals().catch((e) => get().report("Couldn't load drafts", e)));
    const offSnapshot = backend.subscribe(() => void get().refreshConnections());
    stop = () => {
      offCache();
      offProposals();
      offSnapshot();
    };
    try {
      const [identity] = await Promise.all([backend.cacheMe(), get().refresh(), get().refreshProposals()]);
      if (mine !== generation) return;
      const names = Object.fromEntries(identity.accounts.map((a) => [a.accountId, identity.displayName]));
      set((s) => ({ me: identity.accounts, names: { ...s.names, ...names }, status: "ready" }));
      void get().refreshConnections();
    } catch (e) {
      if (mine === generation) set({ status: "error", error: String(e) });
      throw e;
    }
  },

  async refresh() {
    const backend = get().backend;
    if (!backend) return;
    const mine = ++refreshSeq;
    const before = get().items;
    const [items, containers, needsMe, people] = await Promise.all([
      backend.cacheSearch(ALL),
      backend.cacheContainers(),
      backend.cacheSearch({ type: "needsMe" }),
      backend.cachePeople(),
    ]);
    const loaded = Object.keys(get().events);
    const events = await Promise.all(
      loaded.map(async (k) => [k, await backend.cacheEvents(get().items[k]?.item ?? keyToRef(k))] as const),
    );
    if (backend !== get().backend || mine !== refreshSeq) return;
    const containerMap = byKey(containers, (c) => containerKey(c.ref));
    const itemMap = byKey(items, (i) => itemKey(i.item));
    set((s) => ({
      items: itemMap,
      containers: containerMap,
      needsMe: new Set(needsMe.map((i) => itemKey(i.item))),
      names: { ...s.names, ...Object.fromEntries(people.map((p) => [p.accountId, p.name])) },
      events: { ...s.events, ...Object.fromEntries(events) },
    }));
    for (const k of Object.keys(get().comments)) {
      if (itemMap[k] && itemMap[k].commentCount !== before[k]?.commentCount) void get().loadComments(itemMap[k].item);
    }
  },

  async refreshProposals() {
    const backend = get().backend;
    if (!backend) return;
    const mine = ++proposalSeq;
    const list = await backend.proposalsList();
    if (backend === get().backend && mine === proposalSeq) set({ proposals: byKey(list, (p) => p.id) });
  },

  async loadEvents(ref) {
    const backend = get().backend;
    if (!backend) return;
    const events = await backend.cacheEvents(ref);
    if (backend === get().backend) set((s) => ({ events: { ...s.events, [itemKey(ref)]: events } }));
  },

  async loadComments(ref) {
    const backend = get().backend;
    if (!backend) return;
    const mine = generation;
    const key = itemKey(ref);
    const seq = (commentSeq.get(key) ?? 0) + 1;
    commentSeq.set(key, seq);
    const put = (list: WorkComment[]) =>
      backend === get().backend && mine === generation && commentSeq.get(key) === seq && set((s) => ({ comments: { ...s.comments, [key]: list } }));
    try {
      put(await backend.cacheComments(ref, false));
      put(await backend.cacheComments(ref, true));
    } catch (e) {
      get().report(`Couldn't load the comments on ${ref.key}`, e);
    }
  },

  loadMoves(item) {
    const backend = get().backend;
    const key = itemKey(item.item);
    const known = get().moves[key];
    if (!backend) return Promise.resolve(null);
    if (known?.statusId === item.status.id) return Promise.resolve(known.to);
    const flight = `${key}|${item.status.id}`;
    const running = moving.get(flight);
    if (running) return running;
    const mine = generation;
    const job = backend
      .cacheTransitions(item.item)
      .then((offered) => {
        const to = offered.map((m) => m.to);
        if (backend === get().backend && mine === generation) set((s) => ({ moves: { ...s.moves, [key]: { statusId: item.status.id, to } } }));
        return to;
      })
      .catch((e) => {
        get().report(`Couldn't check where ${item.item.key} can move`, e);
        return null;
      })
      .finally(() => moving.delete(flight));
    moving.set(flight, job);
    return job;
  },

  async refreshConnections() {
    const backend = get().backend;
    if (!backend) return;
    try {
      const connections = await backend.connectionsList();
      if (backend !== get().backend) return;
      set({ connections });
      const error = connections.find((c) => c.error)?.error ?? null;
      if (error && error !== lastSyncError) useToasts.getState().push(`Couldn't sync: ${error}`);
      lastSyncError = error;
    } catch {
      // The connection row is informational; a failure to read it is not worth interrupting anyone for.
    }
  },

  async syncNow() {
    const backend = get().backend;
    if (!backend) return;
    set((s) => ({ connections: s.connections.map((c) => ({ ...c, syncing: true })) }));
    try {
      await backend.syncNow();
    } catch (e) {
      get().report("Couldn't start a sync", e);
    }
    // The sync announces itself when it ends; this only clears the flag if that never comes.
    setTimeout(() => void get().refreshConnections(), SYNC_FLAG_MS);
  },

  report(what, e) {
    useToasts.getState().push(`${what}: ${messageOf(e)}`);
  },

  async approve(id) {
    const backend = get().backend!;
    const mine = generation;
    const p = await backend.proposalsApprove(id);
    if (backend !== get().backend || mine !== generation) return p;
    set((s) => ({ proposals: { ...s.proposals, [p.id]: p } }));
    return p;
  },

  async skip(id) {
    const backend = get().backend!;
    const mine = generation;
    const p = await backend.proposalsSkip(id);
    if (backend !== get().backend || mine !== generation) return p;
    set((s) => ({ proposals: { ...s.proposals, [p.id]: p } }));
    return p;
  },

  async draftTransition(item, to) {
    const backend = get().backend!;
    const mine = generation;
    const old = draftsForItem(get(), item).filter((d) => d.intent.type === "transition");
    const current = get().items[itemKey(item)];
    const wf = current && workflowOfItem(get(), current);
    if (current && wf && movesAreOpaque(wf)) {
      // A lookup that fails leaves the choice open, since approval asks the tracker again; one that succeeds is binding.
      const offered = await get().loadMoves(current);
      if (offered && !offered.some((s) => s.id === to.id)) throw new Error(`${item.key} can't move to ${to.name} from ${current.status.name}`);
    }
    try {
      const p = await backend.proposalsCreate({ type: "transition", item, to: to.id }, to.name);
      for (const d of old) await backend.proposalsSkip(d.id);
      return p;
    } finally {
      if (backend === get().backend && mine === generation) await get().refreshProposals();
    }
  },

  dispose() {
    stop?.();
    stop = null;
    generation++;
    set({ ...empty });
  },
}));

function keyToRef(key: string): ItemRef {
  const at = key.indexOf(":");
  const externalId = key.slice(at + 1);
  return { connectionId: key.slice(0, at), externalId, key: externalId };
}

type State = Pick<WorkspaceState, "items" | "containers" | "events" | "proposals" | "needsMe" | "me" | "names" | "moves">;

/** The statuses the tracker last said `item` can move to, if it said so for the status the item is in now. */
export const knownMoves = (s: Pick<State, "moves">, item: WorkItem): StatusDef[] | null => {
  const known = s.moves[itemKey(item.item)];
  return known?.statusId === item.status.id ? known.to : null;
};

export const filterContext = (s: Pick<State, "me" | "needsMe">, now = Date.now()): FilterContext => ({
  me: s.me,
  now,
  needsMe: s.needsMe,
});

/** Items matching a filter, newest update first. */
export function itemsByFilter(s: Pick<State, "items" | "needsMe" | "me">, filter: WorkFilter, now = Date.now()): WorkItem[] {
  const all = Object.values(s.items);
  return all.filter(compileFilter(filter, all, filterContext(s, now))).sort((a, b) => b.updated.localeCompare(a.updated));
}

export const itemByRef = (s: Pick<State, "items">, ref: ItemRef): WorkItem | undefined => s.items[itemKey(ref)];

export function containerWorkflow(s: Pick<State, "containers">, ref: ContainerRef): Workflow | null {
  return s.containers[containerKey(ref)]?.workflow ?? null;
}

/** The workflow that governs an item, which is its container's. */
export const workflowOfItem = (s: Pick<State, "containers">, item: WorkItem) => containerWorkflow(s, item.container);

export const allContainers = (s: Pick<State, "containers">): WorkContainer[] =>
  Object.values(s.containers).sort((a, b) => a.key.localeCompare(b.key));

export const itemsInContainer = (s: Pick<State, "items" | "needsMe" | "me">, ref: ContainerRef) => itemsByFilter(s, { type: "container", container: ref });

export const childrenOf = (s: Pick<State, "items" | "needsMe" | "me">, ref: ItemRef) => itemsByFilter(s, { type: "parent", item: ref });

export const needsMeItems = (s: Pick<State, "items" | "needsMe" | "me">) => itemsByFilter(s, { type: "needsMe" });

export const eventsFor = (s: Pick<State, "events">, ref: ItemRef): WorkEvent[] => s.events[itemKey(ref)] ?? [];

/** Drafts about an item, newest first. Pending ones by default, since those are the ones a person still has to decide on. */
export function draftsForItem(s: Pick<State, "proposals">, ref: ItemRef, states: ProposalStateKind[] = ["pending"]): Proposal[] {
  return Object.values(s.proposals)
    .filter((p) => states.includes(p.state.type) && targetOf(p.intent) !== null && itemKey(targetOf(p.intent)!) === itemKey(ref))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const pendingDrafts = (s: Pick<State, "proposals">): Proposal[] =>
  Object.values(s.proposals)
    .filter((p) => p.state.type === "pending")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** How many pending drafts each item has, keyed by `itemKey`, for badges. */
export function draftCounts(s: Pick<State, "proposals">): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of pendingDrafts(s)) {
    const t = targetOf(p.intent);
    if (t) counts[itemKey(t)] = (counts[itemKey(t)] ?? 0) + 1;
  }
  return counts;
}

export function nameOf(s: Pick<State, "names">, person: PersonRef | null): string {
  return person ? (s.names[person.accountId] ?? person.accountId) : "Unassigned";
}

/** What `parseQuery` and `describeFilter` need to resolve names. */
export function queryLookup(s: Pick<State, "items" | "containers" | "names" | "me">): QueryLookup {
  const seen = new Set<string>();
  const people: QueryLookup["people"][number][] = [];
  for (const i of Object.values(s.items)) {
    for (const ref of [i.assignee, i.reporter]) {
      if (!ref || seen.has(`${ref.connectionId}:${ref.accountId}`)) continue;
      seen.add(`${ref.connectionId}:${ref.accountId}`);
      people.push({ ref, name: s.names[ref.accountId] ?? ref.accountId });
    }
  }
  return { containers: allContainers(s), people, me: s.me, items: Object.values(s.items) };
}

/** Re-runs the filter when the data or the filter changes. */
export function useItemsByFilter(filter: WorkFilter): WorkItem[] {
  const items = useWorkspace((s) => s.items);
  const needsMe = useWorkspace((s) => s.needsMe);
  const me = useWorkspace((s) => s.me);
  const key = JSON.stringify(filter);
  return useMemo(() => itemsByFilter({ items, needsMe, me }, filter), [items, needsMe, me, key]);
}
