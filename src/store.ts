import { create } from "zustand";
import { auth, type Account, type Site } from "./backend/auth";
import type { Backend } from "./backend/types";
import { itemsForView, type ListItem } from "./lib/views";
import type { Snapshot, Ticket, ViewId } from "./types";

export interface Toast {
  id: number;
  message: string;
  undo?: () => void;
}

export type Overlay = "palette" | "help" | "transition" | "snooze" | "connect" | null;

interface State {
  backend: Backend | null;
  /** The signed-in Jira account, or null when running on sample data. */
  account: { site: Site; me: Account } | null;
  snap: Snapshot | null;
  now: Date;
  view: ViewId;
  project: string | null;
  selectedId: string | null;
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
  openOverlay(o: Overlay): void;
  markDone(): Promise<void>;
  snooze(until: Date): Promise<void>;
  toggleUnread(): Promise<void>;
  transition(transitionId: string, name: string): Promise<void>;
  comment(body: string): Promise<boolean>;
  showToast(message: string, undo?: () => void): void;
  goToTicket(key: string): void;
  signOut(): Promise<void>;
}

export type Store = State & Actions;

let toastSeq = 0;
let unsubscribe: (() => void) | null = null;

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
    overlay: null,
    toast: null,
    error: null,

    async init(backend) {
      unsubscribe?.();
      unsubscribe = backend.subscribe((snap) => set({ snap, now: new Date() }));
      const snap = await backend.load();
      set({ backend, snap, now: new Date() });
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
      const ev = id?.startsWith("e:") ? snap.events.find((e) => `e:${e.id}` === id) : undefined;
      if (ev?.unread) void backend.setUnread(ev.id, false);
    },

    move(delta) {
      const items = currentItems(get());
      if (!items.length) return;
      const i = items.findIndex((x) => x.id === get().selectedId);
      const next = Math.max(0, Math.min(items.length - 1, i + delta));
      get().select(items[next].id);
    },

    openOverlay(overlay) {
      // Menus render only for a selected ticket or event; opening one without it would swallow all shortcuts.
      if (overlay === "transition" && !selectedTicket(get())) return;
      if (overlay === "snooze" && !selectedEvent(get())) return;
      set({ overlay });
    },

    async markDone() {
      const { backend } = get();
      const ev = selectedEvent(get());
      if (!backend || !ev) return;
      const done = ev.doneAt === null;
      const snoozedUntil = ev.snoozedUntil;
      const neighbour = neighbourOf(get());
      if (await run("update the item", () => backend.setDone(ev.id, done))) {
        if (neighbour) get().select(neighbour);
        get().showToast(done ? "Marked done" : "Moved back to Inbox", () =>
          void run("undo", async () => {
            await backend.setDone(ev.id, !done);
            if (done && snoozedUntil) await backend.snooze(ev.id, new Date(snoozedUntil));
          }),
        );
      }
    },

    async snooze(until) {
      const { backend } = get();
      const ev = selectedEvent(get());
      if (!backend || !ev) return;
      const neighbour = neighbourOf(get());
      if (await run("snooze the item", () => backend.snooze(ev.id, until))) {
        if (neighbour) get().select(neighbour);
        const when = until.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
        get().showToast(`Snoozed until ${when}`, () => void backend.snooze(ev.id, null));
      }
    },

    async toggleUnread() {
      const { backend } = get();
      const ev = selectedEvent(get());
      if (backend && ev) await run("update the item", () => backend.setUnread(ev.id, !ev.unread));
    },

    async transition(transitionId, name) {
      const { backend } = get();
      const t = selectedTicket(get());
      if (!backend || !t) return;
      if (await run(`move ${t.key}`, () => backend.transition(t.key, transitionId))) {
        get().showToast(`${t.key}: ${name}`);
      }
    },

    async comment(body) {
      const { backend } = get();
      const t = selectedTicket(get());
      const text = body.trim();
      if (!backend || !t || !text) return false;
      const ok = await run(`comment on ${t.key}`, () => backend.comment(t.key, text));
      if (ok) get().showToast(`Commented on ${t.key}`);
      return ok;
    },

    showToast(message, undo) {
      set({ toast: { id: ++toastSeq, message, undo } });
    },

    async signOut() {
      if (await run("sign out", auth.signOut)) {
        unsubscribe?.();
        unsubscribe = null;
        set({ account: null, backend: null, snap: null, selectedId: null, overlay: null });
      }
    },

    goToTicket(key) {
      const s = get();
      if (!s.snap?.tickets[key]) return;
      const here = currentItems(s).find((i) => i.ticketKey === key);
      if (here) return s.select(here.id);
      const mine = s.snap.tickets[key].assignee?.accountId === s.snap.me.accountId;
      const view: ViewId = mine ? "mine" : "watching";
      set({ view, project: null, overlay: null });
      const found = currentItems(get()).find((i) => i.ticketKey === key);
      get().select(found?.id ?? `t:${key}`);
    },
  };
});

function ticketKeyOf(id: string, snap: Snapshot): string | null {
  if (id.startsWith("t:")) return id.slice(2);
  return snap.events.find((e) => `e:${e.id}` === id)?.ticketKey ?? null;
}

export function currentItems(s: Pick<State, "snap" | "view" | "project" | "now">): ListItem[] {
  return s.snap ? itemsForView(s.snap, s.view, s.project, s.now) : [];
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

/** The item to select after the current one leaves the list. */
function neighbourOf(s: State): string | null {
  const items = currentItems(s);
  const i = items.findIndex((x) => x.id === s.selectedId);
  if (i < 0) return null;
  return (items[i + 1] ?? items[i - 1])?.id ?? null;
}
