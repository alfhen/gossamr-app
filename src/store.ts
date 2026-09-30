import { create } from "zustand";
import { auth, type Account, type Site } from "./backend/auth";
import type { Backend } from "./backend/types";
import type { Mention } from "./lib/mentions";
import { itemsForView, stackByTicket, type ListItem } from "./lib/views";
import type { InboxEvent, Snapshot, Ticket, Uploaded, ViewId } from "./types";

export interface Toast {
  id: number;
  message: string;
  undo?: () => void;
}

export type Overlay = "palette" | "help" | "transition" | "snooze" | null;

interface State {
  backend: Backend | null;
  /** The signed-in Jira account, or null when running on sample data. */
  account: { site: Site; me: Account } | null;
  snap: Snapshot | null;
  now: Date;
  view: ViewId;
  project: string | null;
  selectedId: string | null;
  /** How many days back My work reaches, including today. */
  workDays: number;
  /** Tickets whose stack of updates is shown expanded. */
  expanded: ReadonlySet<string>;
  overlay: Overlay;
  toast: Toast | null;
  error: string | null;
}

interface Actions {
  init(backend: Backend): Promise<void>;
  tick(): void;
  setView(view: ViewId, project?: string | null): void;
  select(id: string | null): void;
  move(delta: 1 | -1): void;
  setWorkDays(days: number): void;
  /** Expands or collapses the stack the selection is in. */
  setStackOpen(open: boolean): void;
  openOverlay(o: Overlay): void;
  markDone(): Promise<void>;
  snooze(until: Date): Promise<void>;
  toggleUnread(): Promise<void>;
  transition(transitionId: string, name: string): Promise<void>;
  comment(body: string, options?: CommentOptions): Promise<boolean>;
  showToast(message: string, undo?: () => void): void;
  goToTicket(key: string): void;
  signOut(): Promise<void>;
}

export interface CommentOptions {
  mentions?: Mention[];
  files?: Uploaded[];
  /** The ticket to comment on; the selected one when omitted. */
  ticketKey?: string;
  /** The backend the files were uploaded through. The comment is refused if another has taken over since. */
  via?: Backend;
}

export type Store = State & Actions;

let toastSeq = 0;
let unsubscribe: (() => void) | null = null;
/** Bumped by each init and sign-out, so a load that finishes late can't restore a previous account's data. */
let generation = 0;

/** Drops the classic screens' live subscription and invalidates any load still in flight. */
export function stopClassicSync() {
  generation++;
  unsubscribe?.();
  unsubscribe = null;
}

export const useStore = create<Store>()((set, get) => {
  const run = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
      return true;
    } catch (err) {
      set({ error: `Couldn't ${what}: ${err instanceof Error ? err.message : String(err)}` });
      return false;
    }
  };

  return {
    backend: null,
    account: null,
    snap: null,
    now: new Date(),
    view: "inbox",
    project: null,
    selectedId: null,
    workDays: 7,
    expanded: new Set(),
    overlay: null,
    toast: null,
    error: null,

    async init(backend) {
      const mine = ++generation;
      // The current backend keeps running until this one has loaded, so a failed load leaves the app as it was.
      let live = false;
      let missed = false;
      let updates = 0;
      const stop = backend.subscribe((snap) => {
        updates++;
        if (live) set({ snap, now: new Date() });
        else missed = true;
      });
      let snap: Snapshot;
      try {
        snap = await backend.load();
      } catch (e) {
        stop();
        throw e;
      }
      if (mine !== generation) return stop();
      const previous = get().backend;
      unsubscribe?.();
      unsubscribe = () => {
        live = false;
        stop();
      };
      live = true;
      if (previous && previous !== backend) previous.dispose?.();
      set({ backend, snap, now: new Date() });
      // An update that arrived during the load may be newer than what it returned, so read the latest once more.
      // It's skipped if a newer update arrives while it runs, since that one is already showing.
      if (missed) {
        const seen = updates;
        void backend
          .load()
          .then((latest) => live && updates === seen && set({ snap: latest, now: new Date() }))
          .catch(() => {});
      }
      const first = currentItems(get())[0];
      if (first) get().select(first.id);
    },

    tick: () => set({ now: new Date() }),

    setView(view, project = null) {
      set({ view, project, selectedId: null, overlay: null });
      const first = currentItems(get())[0];
      get().select(first?.id ?? null);
    },

    select(id) {
      const { backend, snap, selectedId } = get();
      if (!backend || !snap) return;
      const prevKey = selectedId && ticketKeyOf(selectedId, snap);
      set({ selectedId: id });
      const nextKey = id && ticketKeyOf(id, snap);
      // "Since you last looked" means since you last left the ticket, so the diff stays visible while it's open.
      if (prevKey && prevKey !== nextKey) void backend.markSeen(prevKey);
      for (const ev of selectedEvents(get())) if (ev.unread) void backend.setUnread(ev.id, false);
    },

    move(delta) {
      const items = currentItems(get());
      if (!items.length) return;
      const i = items.findIndex((x) => x.id === get().selectedId);
      const next = Math.max(0, Math.min(items.length - 1, i + delta));
      get().select(items[next].id);
    },

    setStackOpen(open) {
      const s = get();
      const item = currentItems(s).find((i) => i.id === s.selectedId);
      if (!item || !(item.stack || item.inStack)) return;
      const expanded = new Set(s.expanded);
      if (open) expanded.add(item.ticketKey);
      else expanded.delete(item.ticketKey);
      set({ expanded });
      if (!open) get().select(`s:${item.ticketKey}`);
    },

    setWorkDays(workDays) {
      set({ workDays });
    },

    openOverlay(overlay) {
      // Menus render only for a selected ticket or event; opening one without it would swallow all shortcuts.
      if (overlay === "transition" && !selectedTicket(get())) return;
      if (overlay === "snooze" && !selectedEvents(get()).length) return;
      set({ overlay });
    },

    async markDone() {
      const { backend } = get();
      const evs = selectedEvents(get());
      if (!backend || !evs.length) return;
      const done = evs[0].doneAt === null;
      const neighbour = neighbourOf(get(), evs);
      const apply = (ev: InboxEvent) => backend.setDone(ev.id, done);
      const revert = async (ev: InboxEvent) => {
        await backend.setDone(ev.id, !done);
        if (done && ev.snoozedUntil) await backend.snooze(ev.id, new Date(ev.snoozedUntil));
        // Clearing and snoozing both mark an update read, so its unread state is restored last, here and in snooze.
        if (ev.unread) await backend.setUnread(ev.id, true);
      };
      if (await run("update the item", () => applyAll(evs, apply, revert))) {
        if (neighbour) get().select(neighbour);
        get().showToast(`${done ? "Cleared" : "Moved back to Inbox"}${countOf(evs)}`, () =>
          void run("undo", () => applyAll(evs, revert, apply)),
        );
      }
    },

    async snooze(until) {
      const { backend } = get();
      const evs = selectedEvents(get());
      if (!backend || !evs.length) return;
      const neighbour = neighbourOf(get(), evs);
      const apply = (ev: InboxEvent) => backend.snooze(ev.id, until);
      const revert = async (ev: InboxEvent) => {
        await backend.snooze(ev.id, ev.snoozedUntil ? new Date(ev.snoozedUntil) : null);
        if (ev.unread) await backend.setUnread(ev.id, true);
      };
      if (await run("snooze the item", () => applyAll(evs, apply, revert))) {
        if (neighbour) get().select(neighbour);
        const when = until.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
        get().showToast(`Snoozed${countOf(evs)} until ${when}`, () => void run("undo", () => applyAll(evs, revert, apply)));
      }
    },

    async toggleUnread() {
      const { backend } = get();
      const evs = selectedEvents(get());
      const unread = !evs.some((e) => e.unread);
      if (!backend || !evs.length) return;
      const apply = (ev: InboxEvent) => backend.setUnread(ev.id, unread);
      const revert = (ev: InboxEvent) => backend.setUnread(ev.id, ev.unread);
      await run("update the item", () => applyAll(evs, apply, revert));
    },

    async transition(transitionId, name) {
      const { backend } = get();
      const t = selectedTicket(get());
      if (!backend || !t) return;
      if (await run(`move ${t.key}`, () => backend.transition(t.key, transitionId))) {
        get().showToast(`${t.key}: ${name}`);
      }
    },

    async comment(body, { mentions = [], files = [], ticketKey, via } = {}) {
      const { backend, snap } = get();
      if (via && backend !== via) {
        set({ error: "Couldn't comment: you switched Jira accounts while the files were uploading" });
        return false;
      }
      const t = ticketKey ? (snap?.tickets[ticketKey] ?? null) : selectedTicket(get());
      const text = body.trim();
      if (!backend || !t || (!text && !files.length)) return false;
      const ok = await run(`comment on ${t.key}`, () => backend.comment(t.key, text, mentions, files));
      if (ok) get().showToast(`Commented on ${t.key}`);
      return ok;
    },

    showToast(message, undo) {
      set({ toast: { id: ++toastSeq, message, undo } });
    },

    async signOut() {
      if (await run("sign out", auth.signOut)) {
        generation++;
        unsubscribe?.();
        unsubscribe = null;
        get().backend?.dispose?.();
        set({ account: null, backend: null, snap: null, selectedId: null, overlay: null });
      }
    },

    goToTicket(key) {
      const s = get();
      if (!s.snap?.tickets[key]) return;
      const here = currentItems(s).find((i) => i.ticketKey === key);
      if (here) return s.select(here.id);
      const mine = s.snap.tickets[key].assignee?.accountId === s.snap.me.accountId;
      const view: ViewId = mine ? "work" : "watching";
      set({ view, project: null, overlay: null });
      const found = currentItems(get()).find((i) => i.ticketKey === key);
      get().select(found?.id ?? `t:${key}`);
    },
  };
});

function ticketKeyOf(id: string, snap: Snapshot): string | null {
  if (id.startsWith("t:") || id.startsWith("s:")) return id.slice(2);
  return snap.events.find((e) => `e:${e.id}` === id)?.ticketKey ?? null;
}

export function currentItems(s: Pick<State, "snap" | "view" | "project" | "now" | "expanded" | "workDays">): ListItem[] {
  return s.snap ? stackByTicket(itemsForView(s.snap, s.view, s.project, s.now, s.workDays), s.expanded) : [];
}

export function selectedTicket(s: State): Ticket | null {
  if (!s.snap || !s.selectedId) return null;
  const key = ticketKeyOf(s.selectedId, s.snap);
  return key ? (s.snap.tickets[key] ?? null) : null;
}

export function selectedEvent(s: State) {
  if (!s.snap || !s.selectedId?.startsWith("e:")) return null;
  return s.snap.events.find((e) => `e:${e.id}` === s.selectedId) ?? null;
}

/** The updates the selection acts on: every update in a selected stack, or the one selected update. */
export function selectedEvents(s: State): InboxEvent[] {
  if (s.selectedId?.startsWith("s:")) return currentItems(s).find((i) => i.id === s.selectedId)?.stack ?? [];
  const ev = selectedEvent(s);
  return ev ? [ev] : [];
}

/**
 * Applies a change to every update, all or nothing: if any call fails, the updates that did change are reverted
 * before the first error is rethrown. `revert` gets the update as it was before the change.
 */
async function applyAll(evs: InboxEvent[], apply: (ev: InboxEvent) => Promise<void>, revert: (ev: InboxEvent) => Promise<void>) {
  const results = await Promise.allSettled(evs.map(apply));
  const failed = results.find((r) => r.status === "rejected");
  if (!failed) return;
  await Promise.allSettled(evs.filter((_, i) => results[i].status === "fulfilled").map(revert));
  throw failed.reason;
}
const countOf = (evs: InboxEvent[]) => (evs.length > 1 ? ` (${evs.length} updates)` : "");

/**
 * The nearest item that stays in the list once `leaving` has left it, looking below the selection first. The ticket's
 * own remaining updates come before other tickets.
 */
function neighbourOf(s: State, leaving: InboxEvent[]): string | null {
  const items = currentItems(s);
  const i = items.findIndex((x) => x.id === s.selectedId);
  if (i < 0) return null;
  const gone = new Set(leaving.map((e) => e.id));
  const stays = (x: ListItem) => {
    const evs = x.stack ?? (x.event ? [x.event] : null);
    return !evs || !evs.every((e) => gone.has(e.id));
  };
  const sameTicket = (x: ListItem) => x.ticketKey === items[i].ticketKey && !x.stack && stays(x);
  const below = items.slice(i + 1);
  const above = items.slice(0, i).reverse();
  const next = below.find(sameTicket) ?? above.find(sameTicket) ?? below.find(stays) ?? above.find(stays);
  return next?.id ?? null;
}
