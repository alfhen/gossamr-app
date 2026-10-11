import { useMemo } from "react";
import { create } from "zustand";
import type { Backend } from "./backend/types";
import { ALL, compileFilter, containerKey, itemKey, usesCode, type FilterContext, type QueryLookup } from "./lib/filter";
import { targetOf } from "./lib/proposals";
import { movesAreOpaque } from "./workspace/boardLogic";
import { workContainers } from "./workspace/domains";
import { useDev } from "./workspace/devStore";
import type { CodeSummary } from "./lib/devLinks";
import { newStrays, strayText } from "./workspace/watchLogic";
import { useTabs } from "./workspace/tabsStore";
import { messageOf, useToasts } from "./workspace/toasts";
import type {
  ConnectionInfo,
  ContainerRef,
  ItemRef,
  PersonRef,
  Proposal,
  ProposalStateKind,
  StatusDef,
  Stray,
  WatchChange,
  WatchMode,
  WatchState,
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
  /** What each connection follows. Items, containers, counts and Pip's view are already limited to it. */
  watch: WatchState[];
  /** Open items assigned to the person in containers they don't watch, until watched or dismissed. */
  strays: Stray[];
  /** The one ticket read live for the peek, never part of `items`. */
  peeked: Record<string, PeekedItem>;
  /** The user's accounts across connections. */
  me: PersonRef[];
  /** Display names by account id. */
  names: Record<string, string>;
  /** Loads everything and keeps it current until `dispose` or the next `init`. */
  init(backend: Backend): Promise<void>;
  refresh(): Promise<void>;
  /** Re-reads only the set of items waiting on the user, which read, done and snooze changes alter without a sync. */
  refreshNeedsMe(): Promise<void>;
  refreshProposals(): Promise<void>;
  refreshWatch(): Promise<void>;
  /** Changes what is watched, then re-reads everything the watch set scopes. */
  watchContainers(connectionId: string, changes: WatchChange[]): Promise<void>;
  watchMode(connectionId: string, mode: WatchMode): Promise<void>;
  /** Starts watching `changes` and switches the connection to selected mode. The containers go first so a failure leaves the choice still to make. */
  chooseWatch(connectionId: string, changes: WatchChange[]): Promise<void>;
  /** Re-reads the strays of every connection; `announce` also raises a notice for them, as when the app starts. */
  refreshStrays(announce?: boolean): Promise<void>;
  dismissStray(stray: Stray): Promise<void>;
  showPeeked(peeked: PeekedItem): void;
  clearPeeked(): void;
  /** Reads an item live without storing it, flagged `unwatched` when its project isn't watched. Null when it can't be seen. */
  peekItem(ref: ItemRef): Promise<WorkItem | null>;
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
  /** Posts a review draft to GitHub as one comment review, on the person's approval. A refusal resolves with the draft pending and `error` set. */
  /** Posts review draft `id` as the person saw it, with `revisions` revisions; one changed since is refused. */
  postReview(id: string, revisions: number, postAnyway?: boolean): Promise<Proposal>;
  /** Sends a follow-up draft back to its run. Rejects with the reason when it can't be sent; the draft stays pending. */
  sendFollowUp(id: string, message: string): Promise<void>;
  /** Sends an answer draft to the run that asked. Rejects with the reason when it can't be sent; the draft stays pending. */
  sendAnswerDraft(id: string, message: string): Promise<void>;
  skip(id: string): Promise<Proposal>;
  /** Drafts moving an item to a status, replacing any transition draft still pending for it. Nothing is written until approval. */
  draftTransition(item: ItemRef, to: StatusDef): Promise<Proposal>;
  dispose(): void;
}

export interface PeekedItem {
  item: WorkItem;
  /** The container's name when the catalog knows it. */
  containerName: string | null;
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
  watch: [],
  strays: [],
  peeked: {},
  me: [],
  names: {},
};

const byKey = <T,>(list: T[], key: (t: T) => string): Record<string, T> => Object.fromEntries(list.map((t) => [key(t), t]));

let stop: (() => void) | null = null;
let generation = 0;
let refreshSeq = 0;
const SYNC_FLAG_MS = 20_000;
let proposalSeq = 0;
let watchSeq = 0;
let needsMeSeq = 0;
let straySeq = 0;
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
    const offSnapshot = backend.subscribe(() => {
      void get().refreshConnections();
      get().refreshNeedsMe().catch((e) => get().report("Couldn't refresh what needs you", e));
    });
    // A change the person makes also emits a cache change, which re-reads what the watch set scopes; this only
    // needs to refresh the settings themselves, including when the app chose for a small catalog.
    const offWatch = backend.onWatchChanged(() => {
      get().refreshWatch().catch((e) => get().report("Couldn't load what you watch", e));
      void get().refreshStrays();
    });
    const offStrays = backend.onAssignedElsewhere((found) => {
      const before = get().strays;
      const after = [...before.filter((s) => s.container.connectionId !== found.connectionId), ...found.strays];
      set({ strays: after });
      announceStrays(newStrays(before, after));
    });
    stop = () => {
      offStrays();
      offCache();
      offProposals();
      offSnapshot();
      offWatch();
    };
    try {
      const [identity] = await Promise.all([backend.cacheMe(), get().refresh(), get().refreshProposals(), get().refreshWatch()]);
      if (mine !== generation) return;
      const names = Object.fromEntries(identity.accounts.map((a) => [a.accountId, identity.displayName]));
      set((s) => ({ me: identity.accounts, names: { ...s.names, ...names }, status: "ready" }));
      void get().refreshConnections();
      void get().refreshStrays(true);
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
    const [items, containers, people] = await Promise.all([
      backend.cacheSearch(ALL),
      backend.cacheContainers(),
      backend.cachePeople(),
      get().refreshNeedsMe(),
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
      names: { ...s.names, ...Object.fromEntries(people.map((p) => [p.accountId, p.name])) },
      events: { ...s.events, ...Object.fromEntries(events) },
    }));
    for (const k of Object.keys(get().comments)) {
      if (itemMap[k] && itemMap[k].commentCount !== before[k]?.commentCount) void get().loadComments(itemMap[k].item);
    }
  },

  async refreshNeedsMe() {
    const backend = get().backend;
    if (!backend) return;
    const mine = ++needsMeSeq;
    const found = await backend.cacheSearch({ type: "needsMe" });
    if (backend === get().backend && mine === needsMeSeq) set({ needsMe: new Set(found.map((i) => itemKey(i.item))) });
  },

  async refreshProposals() {
    const backend = get().backend;
    if (!backend) return;
    const mine = ++proposalSeq;
    const list = await backend.proposalsList();
    if (backend === get().backend && mine === proposalSeq) set({ proposals: byKey(list, (p) => p.id) });
  },

  async refreshWatch() {
    const backend = get().backend;
    if (!backend) return;
    const mine = ++watchSeq;
    const watch = await backend.watchGet();
    if (backend === get().backend && mine === watchSeq) set({ watch });
  },

  async watchContainers(connectionId, changes) {
    const backend = get().backend;
    if (!backend || !changes.length) return;
    await backend.watchSetContainers(connectionId, changes);
    await Promise.all([get().refreshWatch(), get().refresh()]);
  },

  async watchMode(connectionId, mode) {
    const backend = get().backend;
    if (!backend) return;
    await backend.watchSetMode(connectionId, mode);
    await Promise.all([get().refreshWatch(), get().refresh()]);
  },

  async chooseWatch(connectionId, changes) {
    const backend = get().backend;
    if (!backend) return;
    await backend.watchSetContainers(connectionId, changes);
    await backend.watchSetMode(connectionId, "selected");
    await Promise.all([get().refreshWatch(), get().refresh()]);
  },

  async refreshStrays(announce = false) {
    const backend = get().backend;
    if (!backend) return;
    const mine = ++straySeq;
    const connections = get().watch.map((w) => w.connectionId);
    const found = await Promise.all(connections.map((id) => backend.watchUnwatchedAssigned(id).catch(() => [] as Stray[])));
    if (backend !== get().backend || mine !== straySeq) return;
    const before = get().strays;
    const strays = found.flat();
    set({ strays });
    if (announce) announceStrays(newStrays(before, strays));
  },

  async dismissStray(stray) {
    const backend = get().backend;
    if (!backend) return;
    set((s) => ({ strays: s.strays.filter((x) => x !== stray) }));
    try {
      await backend.watchDismissAssigned(stray.container.connectionId, stray.container.externalId);
    } catch (e) {
      get().report("Couldn't dismiss that", e);
      void get().refreshStrays();
    }
  },

  showPeeked: (peeked) => set({ peeked: { [itemKey(peeked.item.item)]: peeked } }),

  clearPeeked: () => set((s) => (Object.keys(s.peeked).length ? { peeked: {} } : s)),

  peekItem(ref) {
    return get().backend?.peekItem(ref) ?? Promise.resolve(null);
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
    const mine = generation;
    const flight = `${mine}|${key}|${item.status.id}`;
    const running = moving.get(flight);
    if (running) return running;
    const job = backend
      .cacheTransitions(item.item)
      .then((offered) => {
        if (backend !== get().backend || mine !== generation) return null;
        const to = offered.map((m) => m.to);
        set((s) => ({ moves: { ...s.moves, [key]: { statusId: item.status.id, to } } }));
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
      const error = connections.find((c) => c.error && !c.transient)?.error ?? null;
      if (error && error !== lastSyncError) useToasts.getState().push(`Couldn't sync: ${error}`);
      lastSyncError = error;
    } catch {
      // The connection row is informational; a failure to read it is not worth interrupting anyone for.
      if (backend === get().backend) clearSyncing();
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
      if (backend === get().backend) clearSyncing();
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
    if (get().proposals[id]?.intent.type === "startRun") throw new Error("A run is approved with its own button, after its prompt is shown.");
    if (get().proposals[id]?.intent.type === "followUp") throw new Error("A follow-up is sent back with its own button.");
    if (get().proposals[id]?.intent.type === "runAnswer") throw new Error("An answer is sent with its own button.");
    if (get().proposals[id]?.intent.type === "githubReview") throw new Error("A review is posted to GitHub with its own button.");
    const p = await backend.proposalsApprove(id);
    if (backend !== get().backend || mine !== generation) return p;
    set((s) => ({ proposals: { ...s.proposals, [p.id]: p } }));
    return p;
  },

  async postReview(id, revisions, postAnyway = false) {
    const backend = get().backend!;
    const mine = generation;
    const p = await backend.proposalsPostReview(id, revisions, postAnyway);
    if (backend !== get().backend || mine !== generation) return p;
    set((s) => ({ proposals: { ...s.proposals, [p.id]: p } }));
    return p;
  },

  async sendFollowUp(id, message) {
    const backend = get().backend!;
    const mine = generation;
    try {
      await backend.runsSendFollowUp(id, message);
    } finally {
      const p = await backend.proposalsGet(id).catch(() => null);
      if (p && backend === get().backend && mine === generation) set((s) => ({ proposals: { ...s.proposals, [p.id]: p } }));
    }
  },

  async sendAnswerDraft(id, message) {
    const backend = get().backend!;
    const mine = generation;
    try {
      await backend.runsAnswerDraft(id, message);
    } finally {
      const p = await backend.proposalsGet(id).catch(() => null);
      if (p && backend === get().backend && mine === generation) set((s) => ({ proposals: { ...s.proposals, [p.id]: p } }));
    }
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
      if (backend !== get().backend || mine !== generation) throw new Error("The workspace changed while checking where the ticket can move");
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

function announceStrays(strays: Stray[]) {
  const first = strays[0];
  if (!first) return;
  const text = strays.length > 1 ? `${strayText(first)}, and in ${strays.length - 1} more.` : `${strayText(first)}.`;
  useToasts.getState().push(text, "info", { label: "Review", run: () => useTabs.getState().setRoute("activity") });
}

function clearSyncing() {
  useWorkspace.setState((s) => ({ connections: s.connections.map((c) => ({ ...c, syncing: false })) }));
}

function keyToRef(key: string): ItemRef {
  const at = key.indexOf(":");
  const externalId = key.slice(at + 1);
  return { connectionId: key.slice(0, at), externalId, key: externalId };
}

type State = Pick<WorkspaceState, "items" | "containers" | "events" | "proposals" | "needsMe" | "me" | "names" | "moves" | "watch">;

/** The statuses the tracker last said `item` can move to, if it said so for the status the item is in now. */
export const knownMoves = (s: Pick<State, "moves">, item: WorkItem): StatusDef[] | null => {
  const known = s.moves[itemKey(item.item)];
  return known?.statusId === item.status.id ? known.to : null;
};

export const filterContext = (s: Pick<State, "me" | "needsMe"> & { code?: ReadonlyMap<string, CodeSummary> }, now = Date.now()): FilterContext => ({
  me: s.me,
  now,
  needsMe: s.needsMe,
  code: s.code,
});

/** Items matching a filter, newest update first. */
export function itemsByFilter(s: Pick<State, "items" | "needsMe" | "me"> & { code?: ReadonlyMap<string, CodeSummary> }, filter: WorkFilter, now = Date.now()): WorkItem[] {
  const all = Object.values(s.items);
  return all.filter(compileFilter(filter, all, filterContext(s, now))).sort((a, b) => b.updated.localeCompare(a.updated));
}

export const itemByRef = (s: Pick<State, "items">, ref: ItemRef): WorkItem | undefined => s.items[itemKey(ref)];

export function containerWorkflow(s: Pick<State, "containers">, ref: ContainerRef): Workflow | null {
  return s.containers[containerKey(ref)]?.workflow ?? null;
}

/** The workflow that governs an item, which is its container's. */
export const workflowOfItem = (s: Pick<State, "containers">, item: WorkItem) => containerWorkflow(s, item.container);

/** Work containers only: a repository is never a project. */
export const allContainers = (s: Pick<State, "containers">): WorkContainer[] =>
  workContainers(Object.values(s.containers)).sort((a, b) => a.key.localeCompare(b.key));

export const itemsInContainer = (s: Pick<State, "items" | "needsMe" | "me">, ref: ContainerRef) => itemsByFilter(s, { type: "container", container: ref });

export const childrenOf = (s: Pick<State, "items" | "needsMe" | "me">, ref: ItemRef) => itemsByFilter(s, { type: "parent", item: ref });

export const needsMeItems = (s: Pick<State, "items" | "needsMe" | "me">) => itemsByFilter(s, { type: "needsMe" });

/** What `connectionId` follows, or undefined before it has loaded. */
export const watchOf = (s: Pick<State, "watch">, connectionId: string): WatchState | undefined => s.watch.find((w) => w.connectionId === connectionId);

/** Whether any connection is waiting for the person to choose what to watch. */
export const needsWatchChoice = (s: Pick<State, "watch">): boolean => s.watch.some((w) => w.needsChoice);

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
  const wantsCode = usesCode(filter);
  const code = useDev((d) => (wantsCode ? d.index : undefined));
  const key = JSON.stringify(filter);
  return useMemo(() => itemsByFilter({ items, needsMe, me, code }, filter), [items, needsMe, me, code, key]);
}
