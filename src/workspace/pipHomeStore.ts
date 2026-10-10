import { create } from "zustand";

/** The three columns of Pip home, left to right. */
export const PIP_HOME_COLUMNS = ["list", "conversation", "rail"] as const;
export type PipHomeColumn = (typeof PIP_HOME_COLUMNS)[number];

/**
 * A card on Pip home something asked to bring into view: a draft, a run, or the selected workstream's held banner. A run
 * `where: "rail"` is its card on the step rail, whose step opens for it; otherwise the first card of it on Pip home.
 */
export type PipHomeFocus = { type: "draft"; id: string } | { type: "run"; id: string; where?: "rail" } | { type: "workstream" };

interface PipHomeState {
  /** The workstream whose conversation Pip home shows, by id; null is General. */
  selected: string | null;
  /** Whether the workstream list shows the closed ones too, read-only. */
  showClosed: boolean;
  /** The column the keyboard is in. */
  column: PipHomeColumn;
  /** The card to bring into view and focus once it renders; cleared by whoever focused it. */
  focusTarget: PipHomeFocus | null;
  openWorkstream(id: string): void;
  openGeneral(): void;
  setShowClosed(on: boolean): void;
  setColumn(column: PipHomeColumn): void;
  focus(target: PipHomeFocus | null): void;
  /** Back to General with nothing asked, for when the workstreams go away or another account is shown. */
  reset(): void;
}

const BLANK = { selected: null, showClosed: false, column: "conversation", focusTarget: null } as const;

export const usePipHome = create<PipHomeState>((set) => ({
  ...BLANK,
  openWorkstream: (selected) => set((s) => (s.selected === selected ? s : { selected, focusTarget: null })),
  openGeneral: () => set((s) => (s.selected === null ? s : { selected: null, focusTarget: null })),
  setShowClosed: (showClosed) => set({ showClosed }),
  setColumn: (column) => set({ column }),
  focus: (focusTarget) => set({ focusTarget }),
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
