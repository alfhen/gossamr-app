import { create } from "zustand";
import type { Backend } from "../backend/types";
import { GENERAL_CONVERSATION, workstreamConversation, workstreamOfConversation } from "../lib/conversations";
import { STAGE_LABEL } from "../lib/workstreamStage";
import type { ItemRef, Run, ScreenContext, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { PIP_INPUT_ID } from "./draftKeys";
import { usePrefs } from "./prefs";
import { useRuns, type RunSheetTarget } from "./runsStore";
import { useTabs } from "./tabsStore";
import { messageOf, useToasts } from "./toasts";

interface WorkstreamsState {
  backend: Backend | null;
  /** The open workstreams, newest first, each with the stage its runs give it. */
  list: WorkstreamView[];
  init(backend: Backend): void;
  dispose(): void;
  refresh(): Promise<void>;
  /** The open workstream on the ticket `itemKey` (its key, such as `CA-401`), if there is one. */
  forItem(itemKey: string, connectionId?: string): WorkstreamView | null;
  /** Opens (or finds) the workstream on `item` and shows its conversation in the Pip pane. Null when it couldn't. */
  start(item: ItemRef): Promise<WorkstreamView | null>;
  /** The workstream whose Close waits for the person to confirm it in the peek, if any. */
  confirmingClose: string | null;
  /** Asks the person to confirm closing workstream `id` (null takes the question back). */
  askClose(id: string | null): void;
  /** Closes workstream `id`; its runs and drafts stay as they are, and its ticket's conversation is General again. False when it couldn't. */
  close(id: string): Promise<boolean>;
}

let stop: (() => void) | null = null;
/** Bumped on every read and on dispose, so a list read for an earlier backend or account can't land. */
let seq = 0;

const ofItem = (list: readonly WorkstreamView[], key: string, connectionId?: string) =>
  list.find((v) => v.workstream.itemKey === key && v.workstream.closedAt === null && (!connectionId || v.workstream.connectionId === connectionId)) ?? null;

export const useWorkstreams = create<WorkstreamsState>()((set, get) => ({
  backend: null,
  list: [],
  confirmingClose: null,

  init(backend) {
    get().dispose();
    set({ backend });
    const offWorkstreams = backend.onWorkstreamsChanged(() => void get().refresh());
    // A run that moved on may have moved its workstream's stage on.
    const offRuns = backend.onRunsChanged(() => void get().refresh());
    stop = () => (offWorkstreams(), offRuns());
    void get().refresh();
  },

  dispose() {
    stop?.();
    stop = null;
    seq++;
    set({ backend: null, list: [], confirmingClose: null });
  },

  async refresh() {
    const { backend } = get();
    if (!backend) return;
    const mine = ++seq;
    const list = await backend.workstreamsList().catch(() => null);
    if (list && mine === seq && get().backend === backend) set({ list });
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
      focusPip();
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
      if (get().backend === backend) await get().refresh();
      useToasts.getState().push(`Closed the workstream on ${ws.itemKey ?? ws.title}. Its agents and drafts are kept.`, "info");
      return true;
    } catch (e) {
      useToasts.getState().push(`Couldn't close the workstream. ${messageOf(e)}`);
      return false;
    }
  },
}));

/** Opens the Pip pane, or keeps it open, and puts the cursor in its composer. */
export function focusPip() {
  usePrefs.getState().setPipOpen(true);
  if (typeof document === "undefined") return;
  // The pane may only mount on this render; its input is there on the next frame.
  const focus = () => document.getElementById(PIP_INPUT_ID)?.focus();
  focus();
  requestAnimationFrame(focus);
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
export const conversationTitle = (ws: WorkstreamView | null) => (ws ? `Workstream: ${ws.workstream.title} · ${STAGE_LABEL[ws.stage]}` : "General");

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
