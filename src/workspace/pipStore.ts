import { create } from "zustand";
import type { ScreenContext, WorkFilter } from "../types";
import { remember, type Nudge } from "./nudges";
import { usePrefs } from "./prefs";
import { readStored, writeStored } from "./storage";
import { activeTab, useTabs } from "./tabsStore";

/** A filter Pip put on a tab, with what it replaced, so the person can take it back. */
export interface PipFiltered {
  tabId: string;
  before: WorkFilter;
  beforeTitle: string | null;
  filter: WorkFilter;
  note: string;
  /** The question that asked for it, when one did. */
  requestId?: string | null;
}

/** Where a filter Pip applied stands: in place, taken back, or no longer the person's to undo because they changed the tab since. */
export type AppliedState = "applied" | "undone" | "changed" | "gone";

interface PipState {
  /** The last filter Pip put on a tab; drives the line under the filter bar. */
  filtered: PipFiltered | null;
  /** Every filter Pip applied for a question in the pane, by request, with whether it was taken back. */
  applied: Record<string, PipFiltered & { undone: boolean }>;
  /** Nudges the person has closed or acted on, by id; they stay closed. */
  dismissed: string[];
  /** Nudges already shown this session, so each comes up once. */
  seen: string[];
  nudge: Nudge | null;
  lastNudgeAt: number;
  /** Set while the context is pinned to this snapshot instead of following the screen. */
  pinned: ScreenContext | null;
  /** Text the person selected in the peek sheet to ask about. */
  quote: string | null;
  /** A prompt waiting to land in the pane's input, in place of what is there or, with `append`, after it. */
  prefill: { text: string; append?: boolean } | null;
  applyFilter(filter: WorkFilter, note: string, requestId?: string): void;
  undoFilter(): void;
  clearFiltered(): void;
  undoApplied(requestId: string): void;
  redoApplied(requestId: string): void;
  dismiss(id: string): void;
  showNudge(nudge: Nudge, now: number): void;
  hideNudge(): void;
  setPinned(context: ScreenContext | null): void;
  askAbout(text: string): void;
  clearQuote(): void;
  /** Opens the pane with `text` in the input, unsent. */
  openWith(text: string): void;
  /** Adds text to the end of the pane's input, as typing that landed on a draft card does. */
  typeOn(text: string): void;
  clearPrefill(): void;
}

const KEY = "gossamr-pip";

const loadDismissed = (): string[] => {
  const raw = readStored(KEY) as { dismissed?: unknown } | null;
  return Array.isArray(raw?.dismissed) ? raw.dismissed.filter((d): d is string => typeof d === "string") : [];
};

const setTabFilter = (tabId: string, filter: WorkFilter, title: string | null) =>
  useTabs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, filter, title } : t)) }));

export const usePip = create<PipState>((set, get) => ({
  filtered: null,
  applied: {},
  dismissed: loadDismissed(),
  seen: [],
  nudge: null,
  lastNudgeAt: 0,
  pinned: null,
  quote: null,
  prefill: null,

  applyFilter(filter, note, requestId) {
    const tabs = useTabs.getState();
    const tab = activeTab(tabs);
    const filtered: PipFiltered = { tabId: tab.id, before: tab.filter, beforeTitle: tab.title, filter, note, requestId: requestId ?? null };
    set((s) => ({ filtered, applied: requestId ? { ...s.applied, [requestId]: { ...filtered, undone: false } } : s.applied }));
    tabs.setFilter(filter);
    tabs.setRoute("workspace");
  },

  undoFilter() {
    const f = get().filtered;
    if (!f) return;
    setTabFilter(f.tabId, f.before, f.beforeTitle);
    set((s) => ({ filtered: null, applied: f.requestId && s.applied[f.requestId] ? { ...s.applied, [f.requestId]: { ...s.applied[f.requestId], undone: true } } : s.applied }));
  },

  clearFiltered: () => set({ filtered: null }),

  undoApplied(requestId) {
    const a = get().applied[requestId];
    if (!a || a.undone) return;
    setTabFilter(a.tabId, a.before, a.beforeTitle);
    set((s) => ({ applied: { ...s.applied, [requestId]: { ...a, undone: true } }, filtered: s.filtered?.requestId === requestId ? null : s.filtered }));
  },

  redoApplied(requestId) {
    const a = get().applied[requestId];
    if (!a?.undone || !useTabs.getState().tabs.some((t) => t.id === a.tabId)) return;
    setTabFilter(a.tabId, a.filter, null);
    set((s) => ({ applied: { ...s.applied, [requestId]: { ...a, undone: false } }, filtered: { ...a, requestId } }));
  },

  dismiss: (id) => set((s) => ({ dismissed: remember(s.dismissed, id), nudge: s.nudge?.id === id ? null : s.nudge })),
  showNudge: (nudge, now) => set((s) => ({ nudge, lastNudgeAt: now, seen: remember(s.seen, nudge.id) })),
  hideNudge: () => set((s) => (s.nudge ? { nudge: null } : s)),
  setPinned: (pinned) => set({ pinned }),
  askAbout(text) {
    set({ quote: text });
    usePrefs.getState().setPipOpen(true);
  },
  clearQuote: () => set({ quote: null }),
  openWith(text) {
    set({ prefill: { text } });
    usePrefs.getState().setPipOpen(true);
  },
  typeOn: (text) => set((s) => ({ prefill: s.prefill ? { ...s.prefill, text: s.prefill.text + text } : { text, append: true } })),
  clearPrefill: () => set({ prefill: null }),
}));

usePip.subscribe(({ dismissed }) => writeStored(KEY, { dismissed }));

const sameFilter = (a: WorkFilter, b: WorkFilter) => JSON.stringify(a) === JSON.stringify(b);

/** Whether the chip still describes the tab: the person may have changed the filter by hand since. */
export const isStillFiltered = (f: PipFiltered | null, tab: { id: string; filter: WorkFilter }): f is PipFiltered =>
  !!f && f.tabId === tab.id && sameFilter(f.filter, tab.filter);

/** What a card in the conversation should offer for a filter Pip applied, given the tabs as they are now. */
export function appliedState(a: { tabId: string; filter: WorkFilter; before: WorkFilter; undone: boolean }, tabs: readonly { id: string; filter: WorkFilter }[]): AppliedState {
  const tab = tabs.find((t) => t.id === a.tabId);
  if (!tab) return "gone";
  if (a.undone) return sameFilter(tab.filter, a.before) ? "undone" : "changed";
  return sameFilter(tab.filter, a.filter) ? "applied" : "changed";
}

/** Forgets what belonged to the previous account: filters Pip put on tabs and any pinned context, and, when `nudges`, the suggestions closed for good. */
export function resetPip(nudges: boolean) {
  usePip.setState({ filtered: null, applied: {}, pinned: null, quote: null, nudge: null, ...(nudges ? { dismissed: [], seen: [] } : {}) });
}
