import { create } from "zustand";
import type { Backend } from "../backend/types";
import { GENERAL_CONVERSATION, workstreamConversation, workstreamOfConversation } from "../lib/conversations";
import { ofItem, runWorkstream } from "../lib/workstreamStage";
import { adoptCount, adoptedText, adoptUndoneText } from "../lib/workstreamAdopt";
import type { ItemRef, Run, ScreenContext, Workstream, WorkstreamEvent, WorkstreamUndo, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { PIP_INPUT_ID } from "./draftKeys";
import { focusAdopted, focusAdoptButton, focusWorkstreamRow } from "./focusDrawn";
import { NO_WORKSTREAM_ID, keepSelectionOpen, useWorkView } from "./workViewStore";
import { usePrefs } from "./prefs";
import { useRuns, type RunSheetTarget } from "./runsStore";
import { useTabs } from "./tabsStore";
import { messageOf, useToasts } from "./toasts";
import { offerUndo, withdrawUndo } from "./undo";

interface WorkstreamsState {
  backend: Backend | null;
  /** The open workstreams, newest first, each with the stage its runs give it; the Agents view sorts them for display (`byStatusRank`). */
  list: WorkstreamView[];
  /** Whether the first read of the open list has landed; false until then, so an empty `list` is not mistaken for "no workstreams". */
  loaded: boolean;
  /** The closed workstreams, as the Agents view lists them read-only once asked; empty until `loadClosed` read them. */
  closed: WorkstreamView[];
  init(backend: Backend): void;
  dispose(): void;
  refresh(): Promise<void>;
  /** Reads the closed workstreams into `closed`. */
  loadClosed(): Promise<void>;
  /** Each workstream's audit, oldest first, by id, as last read by `loadEvents`; the workstream detail's step rail reads the open one's. */
  events: Record<string, WorkstreamEvent[]>;
  /** Reads workstream `id`'s audit into `events`. */
  loadEvents(id: string): Promise<void>;
  /** The open workstream on the ticket `itemKey` (its key, such as `CA-401`), if there is one. */
  forItem(itemKey: string, connectionId?: string): WorkstreamView | null;
  /** Opens (or finds) the workstream on `item` and shows its conversation: on the Agents view there, elsewhere in the Pip pane. Null when it couldn't. */
  start(item: ItemRef): Promise<WorkstreamView | null>;
  /** The workstream whose Close waits for the person to confirm it in the peek, if any. */
  confirmingClose: string | null;
  /** Asks the person to confirm closing workstream `id` (null takes the question back). */
  askClose(id: string | null): void;
  /** Closes workstream `id`; its runs and drafts stay as they are, and its ticket's conversation is General again. False when it couldn't. */
  close(id: string): Promise<boolean>;
  /** Reopens closed workstream `id` as it stood, from a closed row's Reopen. False when it couldn't (its ticket may have another one open by now). */
  reopen(id: string): Promise<boolean>;
  /** The person's "Bring them here": the runs and drafts on the workstream's ticket that sit under General move into it, with an Undo that puts them back. False when nothing moved. */
  adopt(id: string): Promise<boolean>;
  /** Pauses workstream `id`: Pip isn't woken in it; its running agents carry on. False when it couldn't. */
  pause(id: string): Promise<boolean>;
  /** Resumes workstream `id`, whatever paused it. False when it couldn't. */
  resume(id: string): Promise<boolean>;
  /** Pauses workstream `id` and stops each of its agents that can be stopped. False when it couldn't. */
  stop(id: string): Promise<boolean>;
  /** Dismisses the question Pip asked in workstream `id`, so it leaves Needs you. False when it couldn't. */
  dismissAsk(id: string): Promise<boolean>;
}

let stop: (() => void) | null = null;
/** Bumped on every read and on dispose, so a list read for an earlier backend or account can't land. */
let seq = 0;
/** The same for reads of the closed workstreams. */
let closedSeq = 0;
/** The same for reads of each workstream's audit: the newest read of each id, from one counter, so a read from before a dispose never matches. */
const eventsSeq = new Map<string, number>();
let eventsCounter = 0;

export const useWorkstreams = create<WorkstreamsState>()((set, get) => {
  /** Calls the backend for one of the person's controls, then reads the list again; a refusal is told in a toast as `failed`. */
  async function act<T>(failed: string, call: (backend: Backend) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    const backend = get().backend ?? useWorkspace.getState().backend;
    if (!backend) {
      useToasts.getState().push("Not connected yet.");
      return { ok: false };
    }
    try {
      const value = await call(backend);
      if (get().backend === backend) await get().refresh();
      return { ok: true, value };
    } catch (e) {
      useToasts.getState().push(`${failed}. ${messageOf(e)}`);
      return { ok: false };
    }
  }
  const ok = async (failed: string, call: (backend: Backend) => Promise<Workstream>) => (await act(failed, call)).ok;
  /** Takes a change back through the backend, which allows it only while that change is the last thing in the audit. A refusal rejects, for the Undo to tell. */
  async function undoChange(id: string, undo: WorkstreamUndo): Promise<void> {
    const backend = get().backend ?? useWorkspace.getState().backend;
    if (!backend) throw new Error("Not connected yet.");
    await backend.workstreamsUndo(id, undo);
    if (get().backend === backend) await get().refresh();
  }
  async function reopenIt(id: string): Promise<void> {
    const backend = get().backend ?? useWorkspace.getState().backend;
    if (!backend) throw new Error("Not connected yet.");
    await backend.workstreamsReopen(id);
    if (get().backend === backend) await get().refresh();
  }
  /** Where the keyboard goes once a closed workstream is back: it opens, and its row has the keyboard. */
  const showWorkstreamRow = (id: string) => {
    useWorkView.getState().openWorkstream(id);
    focusWorkstreamRow(id);
  };
  /** The offer of Undo for each workstream's adoption: the backend allows it only while it is the last thing in the audit, so once the workstream moved on the offer is dead. */
  const adoptOffers = new Map<string, number>();
  /** The offer of Undo for each close, with its ticket: a new workstream on that ticket makes Reopen refuse, so starting one takes the offer back. */
  const closeOffers = new Map<string, { offer: number; itemKey: string | null }>();
  const withdrawClose = (id: string) => {
    withdrawUndo(closeOffers.get(id)?.offer);
    closeOffers.delete(id);
  };
  /** Takes back the adoption offers of workstreams that have moved on since: paused, or closed (gone from the open list). */
  const settleAdoptions = (list: readonly WorkstreamView[]) => {
    for (const [id, offer] of [...adoptOffers]) {
      const v = list.find((x) => x.workstream.id === id);
      if (v && !v.workstream.pausedReason) continue;
      withdrawUndo(offer);
      adoptOffers.delete(id);
    }
  };
  return {
    backend: null,
    list: [],
    loaded: false,
    closed: [],
    events: {},
    confirmingClose: null,

    init(backend) {
      get().dispose();
      set({ backend });
      // Every audit something read (the selected workstream's, for its step rail; a timeline's, in the Pip pane or across
      // workstreams) is read again with the list, so a draft decided meanwhile shows in its counts and lines at once.
      const selectedEvents = () => {
        const selected = useWorkView.getState().selected;
        for (const id of new Set([...(selected && selected !== NO_WORKSTREAM_ID ? [selected] : []), ...Object.keys(get().events)])) void get().loadEvents(id);
      };
      const offWorkstreams = backend.onWorkstreamsChanged(() => (void get().refresh(), selectedEvents()));
      // A run that moved on may have moved its workstream's stage on.
      const offRuns = backend.onRunsChanged(() => (void get().refresh(), selectedEvents()));
      stop = () => (offWorkstreams(), offRuns());
      void get().refresh();
    },

    dispose() {
      stop?.();
      stop = null;
      seq++;
      closedSeq++;
      eventsSeq.clear();
      set({ backend: null, list: [], loaded: false, closed: [], events: {}, confirmingClose: null });
      useWorkView.getState().reset();
    },

    async refresh() {
      const { backend } = get();
      if (!backend) return;
      const mine = ++seq;
      const list = await backend.workstreamsList().catch(() => null);
      if (!list || mine !== seq || get().backend !== backend) return;
      set({ list, loaded: true });
      settleAdoptions(list);
      keepSelectionOpen(list.filter((v) => v.workstream.closedAt === null).map((v) => v.workstream.id));
      // What the Agents view lists as closed follows the open list: one closed meanwhile moves across.
      if (useWorkView.getState().showClosed) void get().loadClosed();
    },

    async loadClosed() {
      const { backend } = get();
      if (!backend) return;
      const mine = ++closedSeq;
      const all = await backend.workstreamsList(true).catch(() => null);
      if (all && mine === closedSeq && get().backend === backend) set({ closed: all.filter((v) => v.workstream.closedAt !== null) });
    },

    async loadEvents(id) {
      const { backend } = get();
      if (!backend) return;
      const mine = ++eventsCounter;
      eventsSeq.set(id, mine);
      const events = await backend.workstreamsEvents(id).catch(() => null);
      // A newer read of the same audit, a dispose or another backend meanwhile: this one is stale.
      if (!events || eventsSeq.get(id) !== mine || get().backend !== backend) return;
      set({ events: { ...get().events, [id]: events } });
    },

    forItem: (itemKey, connectionId) => ofItem(get().list, itemKey, connectionId),

    async start(item) {
      const backend = get().backend ?? useWorkspace.getState().backend;
      if (!backend) {
        useToasts.getState().push("Not connected yet.");
        return null;
      }
      try {
        const ws = await backend.workstreamsOpen(item);
        for (const [id, c] of [...closeOffers]) if (c.itemKey !== null && c.itemKey === ws.itemKey) withdrawClose(id);
        if (get().backend === backend) await get().refresh();
        focusPip(ws.id);
        return get().list.find((v) => v.workstream.id === ws.id) ?? { workstream: ws, stage: "intake", runs: [], labels: [] };
      } catch (e) {
        useToasts.getState().push(`Couldn't start a workstream on ${item.key}. ${messageOf(e)}`);
        return null;
      }
    },

    askClose: (confirmingClose) => set({ confirmingClose }),

    async close(id) {
      set({ confirmingClose: null });
      const backend = get().backend ?? useWorkspace.getState().backend;
      if (!backend) {
        useToasts.getState().push("Not connected yet.");
        return false;
      }
      try {
        const ws = await backend.workstreamsClose(id);
        withdrawUndo(adoptOffers.get(id));
        adoptOffers.delete(id);
        if (get().backend === backend) await get().refresh();
        // Close is one click and a confirmation away from the person's work: Undo reopens it as it stood.
        const name = ws.itemKey ?? ws.title;
        withdrawClose(id);
        closeOffers.set(id, { offer: offerUndo({ what: "close", text: `Closed the workstream on ${name}. Its agents and drafts are kept in General.`, undone: `Reopened the workstream on ${name}.`, undo: () => reopenIt(id), refocus: () => showWorkstreamRow(id) }), itemKey: ws.itemKey ?? null });
        return true;
      } catch (e) {
        useToasts.getState().push(`Couldn't close the workstream. ${messageOf(e)}`);
        return false;
      }
    },

    async reopen(id) {
      const done = await act("Couldn't reopen the workstream", (b) => b.workstreamsReopen(id));
      if (!done.ok) return false;
      withdrawClose(id);
      showWorkstreamRow(id);
      const name = done.value.itemKey ?? done.value.title;
      // It comes back as it stood: a pause is still there to lift.
      useToasts.getState().push(done.value.pausedReason ? `Reopened the workstream on ${name}. It is still paused; Resume it to carry on.` : `Reopened the workstream on ${name}.`, "info");
      return true;
    },

    async adopt(id) {
      const ws = get().list.find((v) => v.workstream.id === id)?.workstream;
      const done = await act("Couldn't bring them here", (b) => b.workstreamsAdopt(id));
      if (!done.ok) return false;
      const moved = done.value;
      const key = ws?.itemKey ?? ws?.title ?? "the ticket";
      const count = adoptCount(moved.runs.length, moved.drafts.length);
      withdrawUndo(adoptOffers.get(id));
      adoptOffers.set(id, offerUndo({ text: adoptedText(count, key), undone: adoptUndoneText(count, key), undo: () => undoChange(id, { type: "adopt", ...moved }), refocus: () => focusAdoptButton(id) }));
      focusAdopted();
      return true;
    },

    async pause(id) {
      const done = await act("Couldn't pause the workstream", (b) => b.workstreamsPause(id));
      if (!done.ok) return false;
      const name = done.value.itemKey ?? done.value.title;
      useToasts.getState().push(`Paused ${name}. Resume it to wake Pip there again.`, "info");
      return true;
    },

    resume: (id) => ok("Couldn't resume the workstream", (b) => b.workstreamsResume(id)),

    async dismissAsk(id) {
      return (await act("Couldn't dismiss the question", (b) => b.workstreamsDismissAsk(id))).ok;
    },

    async stop(id) {
      const done = await act("Couldn't stop the workstream", (b) => b.workstreamsStop(id));
      if (!done.ok) return false;
      const { stopped, failed } = done.value;
      const agents = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;
      useToasts.getState().push(
        `Paused the workstream${stopped ? ` and stopped ${agents(stopped)}` : ""}.${failed ? ` ${agents(failed)} couldn't be stopped; see the Agents view.` : ""}`,
        failed ? "error" : "info",
      );
      return true;
    },
  };
});

/**
 * Opens the Pip drawer, or keeps it open, and puts the cursor in its composer. On the Agents view it also opens workstream
 * `id` (when given), whose conversation the drawer then shows.
 */
export function focusPip(id?: string) {
  if (id && useTabs.getState().route === "agents") useWorkView.getState().openWorkstream(id);
  usePrefs.getState().setPipOpen(true);
  focusComposer();
}

/**
 * Shows workstream `id` (null: just the Agents view) on the Agents view, from any route: the palette's "Open the workstream
 * on KEY", the peek's "Open in Agents", an Activity row. A peek open over the view closes so the workstream is what shows.
 */
export function openOnAgents(id: string | null) {
  const tabs = useTabs.getState();
  if (tabs.route !== "agents") tabs.setRoute("agents");
  else if (tabs.selected !== null) tabs.select(null);
  const view = useWorkView.getState();
  if (id) view.openWorkstream(id);
  else view.closeWorkstream();
}

/** Puts the cursor in Pip's composer. */
export function focusComposer() {
  if (typeof document === "undefined") return;
  // The composer may only mount on this render; its input is there on the next frame.
  const focus = () => document.getElementById(PIP_INPUT_ID)?.focus();
  focus();
  const was = document.activeElement;
  // Focused now: focusing again a frame later could only take a key typed since (F6, say) back to the input.
  if (was && was === document.getElementById(PIP_INPUT_ID)) return;
  requestAnimationFrame(() => {
    // Only if focus hasn't moved since: a key pressed in between (F6 to the rail, say) keeps where it took it.
    const at = document.activeElement;
    if (at === was || !at || at === document.body) focus();
  });
}

/** ⌘J and the rail's Pip button: open or close the Pip drawer from any screen. Opening puts the cursor in its composer. */
export function togglePip() {
  usePrefs.getState().setPipOpen(!usePrefs.getState().pipOpen);
  if (usePrefs.getState().pipOpen) focusComposer();
}

/** The ticket the peek shows (selected or peeked), when one is open on a screen that shows it. */
function shownTicket(selected: string | null, route: string, bulk: boolean): ItemRef | null {
  if (!selected || route === "settings" || bulk) return null;
  const ws = useWorkspace.getState();
  return (ws.items[selected] ?? ws.peeked[selected]?.item)?.item ?? null;
}

/** The run in focus: the one whose sheet is open, or on the Agents view the selected one. */
function focusedRunId(route: string, sheet: RunSheetTarget | null, selectedId: string | null): string | null {
  if (route === "settings") return null;
  if (sheet?.type === "run") return sheet.id;
  return route === "agents" ? selectedId : null;
}

export { runWorkstream };

/**
 * The workstream in focus for the Pip pane: the open one on the ticket the peek shows; otherwise the one of the run in
 * focus (its sheet open, or selected on the Agents view), so starting a run from a workstream's conversation keeps it;
 * otherwise the one whose detail is open on the Agents view (`detail`).
 */
function focusedWorkstream(list: readonly WorkstreamView[], ticket: ItemRef | null, run: Run | null | undefined, detail: string | null = null): WorkstreamView | null {
  const opened = detail ? (list.find((v) => v.workstream.id === detail && v.workstream.closedAt === null) ?? null) : null;
  return opened ?? (ticket ? ofItem(list, ticket.key, ticket.connectionId) : null) ?? runWorkstream(list, run);
}

/** The workstream whose detail is open, while the Agents view is what is on screen. */
const shownDetail = (route: string, selected: string | null) => (route === "agents" ? selected : null);

/** The run in focus right now, as `focusedRunId` picks it. */
function focusedRun(route: string): Run | null {
  const runs = useRuns.getState();
  const id = focusedRunId(route, runs.sheet, runs.selectedId);
  return id ? (runs.runs.find((r) => r.id === id) ?? null) : null;
}

/** The workstream in focus for the Pip pane, as `focusedWorkstream` picks it. */
export function paneWorkstream(): WorkstreamView | null {
  const tabs = useTabs.getState();
  const ticket = shownTicket(tabs.selected, tabs.route, tabs.marked.length > 1);
  return focusedWorkstream(useWorkstreams.getState().list, ticket, focusedRun(tabs.route), shownDetail(tabs.route, useWorkView.getState().selected));
}

/** The conversation the Pip pane shows: the focused workstream's, otherwise General. */
export function paneConversation(): string {
  const ws = paneWorkstream();
  return ws ? workstreamConversation(ws.workstream.id) : GENERAL_CONVERSATION;
}

/** The conversation in focus: the one the Pip pane shows (`paneConversation`). */
export const focusedConversation = paneConversation;

/** `focusedConversation`, kept current. */
export function useFocusedConversation(): string {
  const pane = usePaneWorkstream();
  return pane ? workstreamConversation(pane.workstream.id) : GENERAL_CONVERSATION;
}

/** `paneWorkstream`, kept current as the selection, the tickets and the workstreams change. */
export function usePaneWorkstream(): WorkstreamView | null {
  const selected = useTabs((s) => s.selected);
  const route = useTabs((s) => s.route);
  const bulk = useTabs((s) => s.marked.length > 1);
  const ticket = useWorkspace((s) => (selected && route !== "settings" && !bulk ? (s.items[selected] ?? s.peeked[selected]?.item)?.item : undefined));
  const run = useRuns((s) => {
    const id = focusedRunId(route, s.sheet, s.selectedId);
    return id ? s.runs.find((r) => r.id === id) : undefined;
  });
  const detail = useWorkView((s) => shownDetail(route, s.selected));
  return useWorkstreams((s) => focusedWorkstream(s.list, ticket ?? null, run, detail));
}

/** The open workstream on `item`, kept current. */
export function useItemWorkstream(item: ItemRef | null | undefined): WorkstreamView | null {
  return useWorkstreams((s) => (item ? ofItem(s.list, item.key, item.connectionId) : null));
}

/** "Workstream: CA-401 Retry …", or "General", for the head of the Pip pane. */
export const conversationTitle = (ws: WorkstreamView | null) => (ws ? `Workstream: ${ws.workstream.title}` : "General");

/** The ticket of the workstream whose conversation `conversation` is, as the workspace knows it; null for General or a ticket it hasn't loaded. */
export function workstreamTicket(conversation: string): ItemRef | null {
  const id = workstreamOfConversation(conversation);
  const ws = id ? useWorkstreams.getState().list.find((v) => v.workstream.id === id)?.workstream : undefined;
  if (!ws?.itemKey) return null;
  const { items, peeked } = useWorkspace.getState();
  const known = [...Object.values(items), ...Object.values(peeked).map((p) => p.item)].find((w) => w?.item.key === ws.itemKey && w.item.connectionId === ws.connectionId);
  return known?.item ?? null;
}

/** What Pip is told it sees for a question in `conversation`: in a workstream's conversation with no ticket on screen, the workstream's ticket. */
export function contextFor(conversation: string, context: ScreenContext): ScreenContext {
  if (context.item) return context;
  const item = workstreamTicket(conversation);
  return item ? { ...context, item } : context;
}
