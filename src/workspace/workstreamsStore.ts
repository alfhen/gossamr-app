import { create } from "zustand";
import type { Backend } from "../backend/types";
import { GENERAL_CONVERSATION, workstreamConversation, workstreamOfConversation } from "../lib/conversations";
import { stageText } from "../lib/workstreamStage";
import { budgetView } from "../lib/workstreamHold";
import type { AutoStartSwitches, ItemRef, Run, ScreenContext, Workstream, WorkstreamEvent, WorkstreamMode, WorkstreamRule, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { PIP_INPUT_ID } from "./draftKeys";
import { keepSelectionOpen, usePipHome } from "./pipHomeStore";
import { usePrefs } from "./prefs";
import { useRuns, type RunSheetTarget } from "./runsStore";
import { useTabs } from "./tabsStore";
import { messageOf, useToasts } from "./toasts";

interface WorkstreamsState {
  backend: Backend | null;
  /** The open workstreams, newest first, each with the stage its runs give it. */
  list: WorkstreamView[];
  /** The closed workstreams, as Pip home lists them read-only once asked; empty until `loadClosed` read them. */
  closed: WorkstreamView[];
  init(backend: Backend): void;
  dispose(): void;
  refresh(): Promise<void>;
  /** Reads the closed workstreams into `closed`. */
  loadClosed(): Promise<void>;
  /** Each workstream's audit, oldest first, by id, as last read by `loadEvents`; Pip home's step rail reads the selected one's. */
  events: Record<string, WorkstreamEvent[]>;
  /** Reads workstream `id`'s audit into `events`. */
  loadEvents(id: string): Promise<void>;
  /** The open workstream on the ticket `itemKey` (its key, such as `CA-401`), if there is one. */
  forItem(itemKey: string, connectionId?: string): WorkstreamView | null;
  /** Opens (or finds) the workstream on `item` and shows its conversation: on Pip home there, elsewhere in the Pip pane. Null when it couldn't. */
  start(item: ItemRef): Promise<WorkstreamView | null>;
  /** The workstream whose Close waits for the person to confirm it in the peek, if any. */
  confirmingClose: string | null;
  /** Asks the person to confirm closing workstream `id` (null takes the question back). */
  askClose(id: string | null): void;
  /** Closes workstream `id`; its runs and drafts stay as they are, and its ticket's conversation is General again. False when it couldn't. */
  close(id: string): Promise<boolean>;
  /** The global auto-start switches, as Settings has them, for what "as in Settings" means; null until read. */
  globals: AutoStartSwitches | null;
  /** Reads the global auto-start switches again. */
  loadGlobals(): Promise<void>;
  /** The person's Manage switch: in `manage` the supervisor wakes Pip and starts the routine steps. False when it couldn't. */
  setMode(id: string, mode: WorkstreamMode): Promise<boolean>;
  /** Holds workstream `id`: no wakes and no automatic steps; its running agents carry on. False when it couldn't. */
  hold(id: string): Promise<boolean>;
  /** Lifts workstream `id`'s hold, whatever held it. False when it couldn't. */
  resume(id: string): Promise<boolean>;
  /** The workstream's own switch for one automatic step; null follows Settings again. False when it couldn't. */
  setRule(id: string, rule: WorkstreamRule, on: boolean | null): Promise<boolean>;
  /** Holds every open workstream and stops Pip's turns in them, and says how many it held. Null when it couldn't. */
  holdAll(): Promise<number | null>;
  /** Holds workstream `id` and stops each of its agents that can be stopped. False when it couldn't. */
  stop(id: string): Promise<boolean>;
}

let stop: (() => void) | null = null;
/** Bumped on every read and on dispose, so a list read for an earlier backend or account can't land. */
let seq = 0;
/** The same for reads of the closed workstreams. */
let closedSeq = 0;
/** The same for reads of each workstream's audit: the newest read of each id, from one counter, so a read from before a dispose never matches. */
const eventsSeq = new Map<string, number>();
let eventsCounter = 0;

const ofItem = (list: readonly WorkstreamView[], key: string, connectionId?: string) =>
  list.find((v) => v.workstream.itemKey === key && v.workstream.closedAt === null && (!connectionId || v.workstream.connectionId === connectionId)) ?? null;

/** "1 workstream", "2 workstreams". */
const workstreams = (n: number) => `${n} ${n === 1 ? "workstream" : "workstreams"}`;

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

  return {
    backend: null,
    list: [],
    closed: [],
    events: {},
    confirmingClose: null,
    globals: null,

    init(backend) {
      get().dispose();
      set({ backend });
      // The selected workstream on Pip home has its audit read again with the list, for its step rail.
      const selectedEvents = () => {
        const id = usePipHome.getState().selected;
        if (id) void get().loadEvents(id);
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
      set({ backend: null, list: [], closed: [], events: {}, confirmingClose: null, globals: null });
      usePipHome.getState().reset();
    },

    async refresh() {
      const { backend } = get();
      if (!backend) return;
      const mine = ++seq;
      const list = await backend.workstreamsList().catch(() => null);
      if (!list || mine !== seq || get().backend !== backend) return;
      set({ list });
      keepSelectionOpen(list.filter((v) => v.workstream.closedAt === null).map((v) => v.workstream.id));
      // What Pip home lists as closed follows the open list: one closed meanwhile moves across.
      if (usePipHome.getState().showClosed) void get().loadClosed();
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
        if (get().backend === backend) await get().refresh();
        focusPip(ws.id);
        return get().list.find((v) => v.workstream.id === ws.id) ?? { workstream: ws, stage: "intake", runs: [], labels: [], budget: budgetView(ws) };
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
        if (get().backend === backend) await get().refresh();
        useToasts.getState().push(`Closed the workstream on ${ws.itemKey ?? ws.title}. Its agents and drafts are kept.`, "info");
        return true;
      } catch (e) {
        useToasts.getState().push(`Couldn't close the workstream. ${messageOf(e)}`);
        return false;
      }
    },

    async loadGlobals() {
      const backend = get().backend ?? useWorkspace.getState().backend;
      const settings = await backend?.runsSettings().catch(() => null);
      if (settings && (get().backend ?? useWorkspace.getState().backend) === backend) set({ globals: settings.autostart });
    },

    setMode: (id, mode) => ok(mode === "manage" ? "Couldn't let Pip manage the workstream" : "Couldn't stop Pip managing the workstream", (b) => b.workstreamsSetMode(id, mode)),

    hold: (id) => ok("Couldn't hold the workstream", (b) => b.workstreamsHold(id)),

    resume: (id) => ok("Couldn't resume the workstream", (b) => b.workstreamsResume(id)),

    setRule: (id, rule, on) => ok("Couldn't change the automatic step", (b) => b.workstreamsSetRule(id, rule, on)),

    async holdAll() {
      const done = await act("Couldn't hold the workstreams", (b) => b.workstreamsHoldAll());
      if (!done.ok) return null;
      const n = done.value.length;
      const open = get().list.length;
      const said = n ? `Held ${workstreams(n)}. ${n === 1 ? "Its" : "Their"} agents carry on; nothing starts on its own until you resume.` : open ? "Every open workstream is held already." : "There are no open workstreams to hold.";
      useToasts.getState().push(said, "info");
      return n;
    },

    async stop(id) {
      const done = await act("Couldn't stop the workstream", (b) => b.workstreamsStop(id));
      if (!done.ok) return false;
      const { stopped, failed } = done.value;
      const agents = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;
      useToasts.getState().push(
        `Held the workstream${stopped ? ` and stopped ${agents(stopped)}` : ""}.${failed ? ` ${agents(failed)} couldn't be stopped; see the Agents view.` : ""}`,
        failed ? "error" : "info",
      );
      return true;
    },
  };
});

/**
 * Whether the rail offers Hold all: while any open workstream is in Manage and not held, or Pip is answering in a
 * workstream's conversation (`conversations`, by conversation, as claudeStore keeps them).
 */
export function holdAllVisible(list: readonly WorkstreamView[], conversations: Readonly<Record<string, { turns: readonly { status: string }[] } | undefined>>): boolean {
  if (list.some((v) => v.workstream.closedAt === null && v.workstream.mode === "manage" && v.workstream.heldReason === null)) return true;
  return Object.entries(conversations).some(([c, conv]) => workstreamOfConversation(c) !== null && !!conv?.turns.some((t) => t.status === "running"));
}

/**
 * Opens the Pip pane, or keeps it open, and puts the cursor in its composer. On Pip home there is no pane: it selects
 * workstream `id` there (when given) and puts the cursor in Pip home's composer instead.
 */
export function focusPip(id?: string) {
  if (useTabs.getState().route === "pip") {
    if (id) usePipHome.getState().openWorkstream(id);
  } else {
    usePrefs.getState().setPipOpen(true);
  }
  focusComposer();
}

/**
 * Shows workstream `id` (null: General) on Pip home, from any route: the palette's "Open the workstream on KEY", the
 * peek's "Open on Pip home", an Activity row. A peek open over Pip home closes so the workstream is what shows.
 */
export function openOnPipHome(id: string | null) {
  const tabs = useTabs.getState();
  if (tabs.route !== "pip") tabs.setRoute("pip");
  else if (tabs.selected !== null) tabs.select(null);
  const home = usePipHome.getState();
  if (id) home.openWorkstream(id);
  else home.openGeneral();
}

/** Puts the cursor in Pip's composer, the pane's or Pip home's, whichever is on screen. */
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

/** ⌘J and the rail's Pip button: on Pip home they go to its composer; elsewhere they open or close the Pip pane. */
export function togglePip() {
  if (useTabs.getState().route === "pip") return focusComposer();
  const prefs = usePrefs.getState();
  prefs.setPipOpen(!prefs.pipOpen);
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

/** The open workstream `run` belongs to, or else the one open on its ticket. */
export function runWorkstream(list: readonly WorkstreamView[], run: Run | null | undefined): WorkstreamView | null {
  if (!run) return null;
  const own = run.spec.workstream ? list.find((v) => v.workstream.id === run.spec.workstream && v.workstream.closedAt === null) : undefined;
  return own ?? (run.item ? ofItem(list, run.item.key, run.item.connectionId) : null);
}

/**
 * The workstream in focus for the Pip pane: the open one on the ticket the peek shows; otherwise the one of the run in
 * focus (its sheet open, or selected on the Agents view), so starting a run from a workstream's conversation keeps it.
 */
function focusedWorkstream(list: readonly WorkstreamView[], ticket: ItemRef | null, run: Run | null | undefined): WorkstreamView | null {
  return (ticket ? ofItem(list, ticket.key, ticket.connectionId) : null) ?? runWorkstream(list, run);
}

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
  return focusedWorkstream(useWorkstreams.getState().list, ticket, focusedRun(tabs.route));
}

/** The conversation the Pip pane shows: the focused workstream's, otherwise General. */
export function paneConversation(): string {
  const ws = paneWorkstream();
  return ws ? workstreamConversation(ws.workstream.id) : GENERAL_CONVERSATION;
}

/** The conversation Pip home shows: its selected workstream's, or General. */
const homeConversation = (selected: string | null) => (selected ? workstreamConversation(selected) : GENERAL_CONVERSATION);

/** The conversation in focus: on Pip home the one it shows, elsewhere the one the Pip pane shows (`paneConversation`). */
export function focusedConversation(): string {
  return useTabs.getState().route === "pip" ? homeConversation(usePipHome.getState().selected) : paneConversation();
}

/** `focusedConversation`, kept current. */
export function useFocusedConversation(): string {
  const home = useTabs((s) => s.route === "pip");
  const selected = usePipHome((s) => s.selected);
  const pane = usePaneWorkstream();
  if (home) return homeConversation(selected);
  return pane ? workstreamConversation(pane.workstream.id) : GENERAL_CONVERSATION;
}

/** The open workstream Pip home shows, kept current; null for General. */
export function useHomeWorkstream(): WorkstreamView | null {
  const selected = usePipHome((s) => s.selected);
  return useWorkstreams((s) => (selected ? (s.list.find((v) => v.workstream.id === selected && v.workstream.closedAt === null) ?? null) : null));
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
  return useWorkstreams((s) => focusedWorkstream(s.list, ticket ?? null, run));
}

/** The open workstream on `item`, kept current. */
export function useItemWorkstream(item: ItemRef | null | undefined): WorkstreamView | null {
  return useWorkstreams((s) => (item ? ofItem(s.list, item.key, item.connectionId) : null));
}

/** "Workstream: CA-401 Retry … · Intake", or "General", for the head of the Pip pane. */
export const conversationTitle = (ws: WorkstreamView | null) => (ws ? `Workstream: ${ws.workstream.title} · ${stageText(ws.stage, ws.waitingForPr)}` : "General");

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
