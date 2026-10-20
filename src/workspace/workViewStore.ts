import { create } from "zustand";
import { useTabs } from "./tabsStore";

/**
 * A card in an open workstream's detail something asked to bring into view: a draft, a run, the held banner or a review
 * that still blocks. A run `where: "rail"` is its card on the step rail, whose step opens for it.
 */
export type WorkViewFocus = { type: "draft"; id: string } | { type: "run"; id: string; where?: "rail" } | { type: "workstream" } | { type: "escalation" };

/** A key of the Needs you list that waits for Enter: what it would do, said as the row asks it. */
export interface NeedAsking {
  /** The need's key. */
  key: string;
  /** The line the row shows while it waits: "↵ approve this comment · any other key cancels". */
  text: string;
}

interface WorkViewState {
  /** The workstream whose detail is open over the Agents view, by id; null while none is. */
  selected: string | null;
  /** Whether the Agents view lists the closed workstreams too, read-only. */
  showClosed: boolean;
  /** The card to bring into view and focus once it renders; cleared by whoever focused it. */
  focusTarget: WorkViewFocus | null;
  /** The need whose decision is open under the Needs you strip, by its key; null while none is. */
  deciding: string | null;
  /** Bumped to remount the open decision, so a pane intent set for the need already open is read. */
  paneRev: number;
  /** The workstreams (by id, "general" for General) whose row in the Needs you list is expanded to every need it holds. */
  expanded: ReadonlySet<string>;
  /** The groups the person folded in the list, which opens a group by default while its needs fit. */
  collapsed: ReadonlySet<string>;
  /** The key press in the Needs you list that waits for Enter. */
  asking: NeedAsking | null;
  /**
   * The group (its row id, "general" for General) whose "Approve N safe drafts" preview is open under the strip, in
   * place of a need's decision. It confirms nothing; the person does.
   */
  batch: string | null;
  /** Plan my week is open above the list. */
  planOpen: boolean;
  setPlanOpen(open: boolean): void;
  /** Start my day is open above the list: asked for with ⌘K, until "Done for now". */
  dayOpen: boolean;
  setDayOpen(open: boolean): void;
  /** The glossary ("What the words mean") is open above the list, after its first-run card was dismissed. */
  wordsOpen: boolean;
  setWordsOpen(open: boolean): void;
  /** Opens group `gid`'s combined preview of its safe drafts, for the person to confirm. */
  previewBatch(gid: string): void;
  /** Opens need `key`'s decision. */
  decide(key: string): void;
  /** Remounts the open decision. */
  redecide(): void;
  /** Closes the decision, or the batch preview. */
  closeDecision(): void;
  setExpanded(id: string, on: boolean): void;
  ask(asking: NeedAsking | null): void;
  openWorkstream(id: string): void;
  closeWorkstream(): void;
  setShowClosed(on: boolean): void;
  focus(target: WorkViewFocus | null): void;
  /** Back to nothing open, for when the workstreams go away or another account is shown. */
  reset(): void;
}

const BLANK = { selected: null, showClosed: false, focusTarget: null, deciding: null, paneRev: 0, expanded: new Set<string>(), collapsed: new Set<string>(), asking: null, batch: null, planOpen: false, dayOpen: false, wordsOpen: false } as const;

export const useWorkView = create<WorkViewState>((set) => ({
  ...BLANK,
  openWorkstream: (selected) => set((s) => (s.selected === selected ? s : { selected, focusTarget: null })),
  closeWorkstream: () => set((s) => (s.selected === null ? s : { selected: null, focusTarget: null })),
  setShowClosed: (showClosed) => set({ showClosed }),
  focus: (focusTarget) => set({ focusTarget }),
  decide: (key) => set({ deciding: key, batch: null, asking: null, focusTarget: null }),
  redecide: () => set((s) => ({ paneRev: s.paneRev + 1 })),
  closeDecision: () => set({ deciding: null, batch: null, asking: null }),
  setExpanded: (id, on) =>
    set((s) =>
      s.expanded.has(id) === on && s.collapsed.has(id) !== on
        ? s
        : { expanded: new Set(on ? [...s.expanded, id] : [...s.expanded].filter((x) => x !== id)), collapsed: new Set(on ? [...s.collapsed].filter((x) => x !== id) : [...s.collapsed, id]) },
    ),
  ask: (asking) => set({ asking }),
  previewBatch: (gid) => set((s) => ({ batch: gid, deciding: null, asking: null, expanded: new Set([...s.expanded, gid]), collapsed: new Set([...s.collapsed].filter((x) => x !== gid)) })),
  setPlanOpen: (planOpen) => set({ planOpen }),
  setDayOpen: (dayOpen) => set({ dayOpen }),
  setWordsOpen: (wordsOpen) => set({ wordsOpen }),
  reset: () => set({ ...BLANK }),
}));

// A workstream's detail belongs to the Agents view: leaving it puts the detail away, and coming back shows the list.
useTabs.subscribe((s, was) => {
  if (was.route === "agents" && s.route !== "agents") useWorkView.getState().closeWorkstream();
});

/** Closes the open workstream's detail once a fresh read of the open ones (`openIds`) no longer has it, as after it closed. */
export function keepSelectionOpen(openIds: readonly string[]) {
  const { selected, closeWorkstream } = useWorkView.getState();
  if (selected !== null && !openIds.includes(selected)) closeWorkstream();
}

/**
 * What the pane does on opening for the key that opened it: press its Edit, where it has one ("edit"), or keep focus on
 * the pane's heading ("card"), for a draft the person has not asked to act on yet.
 */
export type PaneIntent = "edit" | "card";
let paneIntent: PaneIntent | null = null;
export const setPaneIntent = (intent: PaneIntent | null) => void (paneIntent = intent);
export function takePaneIntent(): PaneIntent | null {
  const was = paneIntent;
  // Let go once the current task is over, not at once: a mount effect that runs twice in a row (React's development check) reads it twice.
  if (was) queueMicrotask(() => void (paneIntent === was && (paneIntent = null)));
  return was;
}
