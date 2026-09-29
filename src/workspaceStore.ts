import { useMemo } from "react";
import { create } from "zustand";
import type { Backend } from "./backend/types";
import { ALL, compileFilter, containerKey, itemKey, type FilterContext, type QueryLookup } from "./lib/filter";
import { targetOf } from "./lib/proposals";
import type {
  ContainerRef,
  ItemRef,
  PersonRef,
  Proposal,
  ProposalStateKind,
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
  /** The user's accounts across connections. */
  me: PersonRef[];
  /** Display names by account id. */
  names: Record<string, string>;
  /** Loads everything and keeps it current until `dispose` or the next `init`. */
  init(backend: Backend): Promise<void>;
  refresh(): Promise<void>;
  refreshProposals(): Promise<void>;
  loadEvents(ref: ItemRef): Promise<void>;
  approve(id: string): Promise<Proposal>;
  skip(id: string): Promise<Proposal>;
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
  me: [],
  names: {},
};

const byKey = <T,>(list: T[], key: (t: T) => string): Record<string, T> => Object.fromEntries(list.map((t) => [key(t), t]));

let stop: (() => void) | null = null;
let generation = 0;
let refreshSeq = 0;
let proposalSeq = 0;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  ...empty,

  async init(backend) {
    get().dispose();
    const mine = ++generation;
    set({ ...empty, backend, status: "loading" });
    const offCache = backend.onCacheChanged(() => void get().refresh());
    const offProposals = backend.onProposalsChanged(() => void get().refreshProposals());
    stop = () => {
      offCache();
      offProposals();
    };
    try {
      const [snap] = await Promise.all([backend.load(), get().refresh(), get().refreshProposals()]);
      if (mine !== generation) return;
      const accounts = Object.values(get().containers).map((c) => c.ref.connectionId);
      const me = [...new Set(accounts)].map((connectionId) => ({ connectionId, accountId: snap.me.accountId }));
      set({ me, names: { ...get().names, [snap.me.accountId]: snap.me.name }, status: "ready" });
    } catch (e) {
      if (mine === generation) set({ status: "error", error: String(e) });
      throw e;
    }
  },

  async refresh() {
    const backend = get().backend;
    if (!backend) return;
    const mine = ++refreshSeq;
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
    set((s) => ({
      items: byKey(items, (i) => itemKey(i.item)),
      containers: byKey(containers, (c) => containerKey(c.ref)),
      needsMe: new Set(needsMe.map((i) => itemKey(i.item))),
      names: { ...s.names, ...Object.fromEntries(people.map((p) => [p.accountId, p.name])) },
      events: { ...s.events, ...Object.fromEntries(events) },
    }));
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

  async approve(id) {
    const p = await get().backend!.proposalsApprove(id);
    set((s) => ({ proposals: { ...s.proposals, [p.id]: p } }));
    return p;
  },

  async skip(id) {
    const p = await get().backend!.proposalsSkip(id);
    set((s) => ({ proposals: { ...s.proposals, [p.id]: p } }));
    return p;
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

type State = Pick<WorkspaceState, "items" | "containers" | "events" | "proposals" | "needsMe" | "me" | "names">;

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
