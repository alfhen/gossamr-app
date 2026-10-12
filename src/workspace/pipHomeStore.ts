import { create } from "zustand";

/** The three columns of Pip home, left to right. */
export const PIP_HOME_COLUMNS = ["list", "conversation", "rail"] as const;
export type PipHomeColumn = (typeof PIP_HOME_COLUMNS)[number];

/**
 * A card on Pip home something asked to bring into view: a draft, a run, or the selected workstream's held banner. A run
 * `where: "rail"` is its card on the step rail, whose step opens for it; otherwise the first card of it on Pip home.
 */
export type PipHomeFocus = { type: "draft"; id: string } | { type: "run"; id: string; where?: "rail" } | { type: "workstream" } | { type: "escalation" };

/** A key of the Needs you list that waits for Enter: what it would do, said as the row asks it. */
export interface NeedAsking {
  /** The need's key. */
  key: string;
  /** The line the row shows while it waits: "↵ approve this comment · any other key cancels". */
  text: string;
}

interface PipHomeState {
  /** The workstream whose conversation Pip home shows, by id; null is General. */
  selected: string | null;
  /** Whether the workstream list shows the closed ones too, read-only. */
  showClosed: boolean;
  /** The column the keyboard is in. */
  column: PipHomeColumn;
  /** The card to bring into view and focus once it renders; cleared by whoever focused it. */
  focusTarget: PipHomeFocus | null;
  /** The need whose decision is open in the middle column, by its key; null while none is. */
  deciding: string | null;
  /** Bumped to remount the open decision, so a pane intent set for the need already open is read. */
  paneRev: number;
  /** The workstreams (by id, "general" for General) whose row in the Needs you list is expanded to every need it holds. */
  expanded: ReadonlySet<string>;
  /** The key press in the Needs you list that waits for Enter. */
  asking: NeedAsking | null;
  /**
   * The group (its row id, "general" for General) whose "Approve N safe drafts" preview the palette asked to open: the list
   * opens the group, shows the combined preview and clears this. It confirms nothing.
   */
  batchPreview: string | null;
  /** Asks the list to open group `gid`'s combined preview of its safe drafts, for the person to confirm. */
  previewBatch(gid: string): void;
  /** Opens need `key`'s decision in the middle column, for workstream `workstreamId` (null is General). */
  decide(key: string, workstreamId: string | null): void;
  /** Remounts the open decision. */
  redecide(): void;
  /** Closes the decision. */
  closeDecision(): void;
  setExpanded(id: string, on: boolean): void;
  ask(asking: NeedAsking | null): void;
  openWorkstream(id: string): void;
  openGeneral(): void;
  setShowClosed(on: boolean): void;
  setColumn(column: PipHomeColumn): void;
  focus(target: PipHomeFocus | null): void;
  /** Back to General with nothing asked, for when the workstreams go away or another account is shown. */
  reset(): void;
}

const BLANK = { selected: null, showClosed: false, column: "conversation", focusTarget: null, deciding: null, paneRev: 0, expanded: new Set<string>(), asking: null, batchPreview: null } as const;

export const usePipHome = create<PipHomeState>((set) => ({
  ...BLANK,
  openWorkstream: (selected) => set((s) => (s.selected === selected ? s : { selected, focusTarget: null })),
  openGeneral: () => set((s) => (s.selected === null ? s : { selected: null, focusTarget: null })),
  setShowClosed: (showClosed) => set({ showClosed }),
  setColumn: (column) => set({ column }),
  focus: (focusTarget) => set({ focusTarget }),
  decide: (key, workstreamId) => set({ deciding: key, selected: workstreamId, asking: null, focusTarget: null }),
  redecide: () => set((s) => ({ paneRev: s.paneRev + 1 })),
  closeDecision: () => set({ deciding: null, asking: null }),
  setExpanded: (id, on) => set((s) => (s.expanded.has(id) === on ? s : { expanded: new Set(on ? [...s.expanded, id] : [...s.expanded].filter((x) => x !== id)) })),
  ask: (asking) => set({ asking }),
  previewBatch: (gid) => set((s) => ({ batchPreview: gid, expanded: new Set([...s.expanded, gid]) })),
  reset: () => set({ ...BLANK }),
}));

/**
 * Keeps Pip home's selection on an open workstream: once a fresh read of the open ones (`openIds`) no longer has it, as
 * after it closed, Pip home shows General again.
 */
export function keepSelectionOpen(openIds: readonly string[]) {
  const { selected, openGeneral } = usePipHome.getState();
  if (selected !== null && !openIds.includes(selected)) openGeneral();
}
