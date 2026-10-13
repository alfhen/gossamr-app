import { PIP_INPUT_ID } from "./draftKeys";
import { keyIntent } from "./keyMap";
import { PIP_HOME_REGIONS, columnRegion, type PipHomeColumn, type PipHomeRegion } from "./pipHomeStore";

/**
 * What the item with focus in the workstream list or the step rail is, as the keyboard steps through them: a workstream's
 * row, a row of the Needs you list (a `group` for a workstream, a `need` inside an expanded one), a step's chip, a run's card or a draft's card.
 */
export type PipHomeItemKind = "row" | "group" | "need" | "chip" | "run" | "draft";

/** Where Pip home's keyboard stands when a key is pressed. */
export interface PipHomeKeyState {
  /** The column the keyboard is in. */
  column: PipHomeColumn;
  /** Something over Pip home takes the keys: the palette, a sheet, the peek, a popover or any other dialog. */
  overlay: boolean;
  /** How many items the column's keyboard steps through (rows and tray items, or chips and the cards under open chips). */
  count: number;
  /** The one of them with focus, or -1. */
  at: number;
  /** What that one is. */
  kind: PipHomeItemKind | null;
  /** The region the keyboard is in, for F6; the one `column` holds first when omitted. */
  region?: PipHomeRegion;
  /** The regions on screen: the decision pane only while one is open, the step rail only while a workstream gives it steps. F6 passes the others by. */
  regions?: readonly PipHomeRegion[];
  /** A key of the Needs you list waits for Enter on the item with focus. */
  asking?: boolean;
  /** A decision is open in the middle column. */
  pane?: boolean;
  /** Focus is inside that open decision (on its button, not in its answer box): a, e, d and s act on the need it shows. */
  inPane?: boolean;
}

/** What a key on Pip home does: go to a region, focus the item at `index` in this one, or act on the item with focus. */
export type PipHomeKeyAction =
  | { type: "region"; to: PipHomeRegion }
  | { type: "focus"; index: number }
  | { type: "open" }
  | { type: "toggle" }
  /** Enter or → on a Needs you row: expands it and opens its decision. */
  | { type: "decide" }
  /** ← on a Needs you row: folds its group. */
  | { type: "collapse" }
  /** a (approve or allow), d (dismiss or deny), s (skip) or e (edit) on a Needs you row, or inside its open decision */
  | { type: "act"; act: "approve" | "dismiss" | "skip" | "edit" }
  /** Enter on a row that asked for it, or any other key. */
  | { type: "confirm" }
  | { type: "cancel" }
  /** Esc on a Needs you row while a decision is open. */
  | { type: "closePane" };

export interface PipHomeKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: unknown;
}

/** Whether `target` takes typing: an input, a textarea, a select or anything editable. Plain keys are never shortcuts there. */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown; closest?: (s: string) => unknown };
  if (el.isContentEditable === true) return true;
  if (typeof el.tagName === "string" && /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) return true;
  return typeof el.closest === "function" && !!el.closest("[contenteditable]:not([contenteditable=false])");
}

/** The region `by` from `region` among those `on` screen, wrapping around; the one the keyboard is in always counts. */
export function stepRegion(region: PipHomeRegion, by: 1 | -1, on: readonly PipHomeRegion[] = PIP_HOME_REGIONS): PipHomeRegion {
  const regions = PIP_HOME_REGIONS.filter((r) => r === region || on.includes(r));
  const at = regions.indexOf(region);
  return regions[(at + by + regions.length) % regions.length];
}

/**
 * Which way a key moves between Pip home's regions: F6 and Cmd/Ctrl+] go on, Shift+F6 and Cmd/Ctrl+[ back, wrapping
 * around, past the decision pane while none is open and the Steps column while no workstream gives it steps. Like Cmd/Ctrl+J they work from Pip's composer too,
 * which is how the person leaves it; never from another field (a budget, an answer to a run), where shortcuts don't fire
 * while the person types.
 */
function columnStep(ev: PipHomeKeyEvent): 1 | -1 | 0 {
  if (ev.altKey) return 0;
  if (ev.key === "F6" && !ev.metaKey && !ev.ctrlKey) return ev.shiftKey ? -1 : 1;
  if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey) return ev.key === "]" ? 1 : ev.key === "[" ? -1 : 0;
  return 0;
}

/**
 * The key `ev` on Pip home, given where the keyboard is: a region move, a step through the list or the rail, or opening
 * or toggling the item with focus. Null leaves the key to whatever else takes it: plain keys never act while the person
 * types in a field or while something is open over Pip home, and in the conversation they stay its cards' own.
 */
export function pipHomeKey(ev: PipHomeKeyEvent, state: PipHomeKeyState): PipHomeKeyAction | null {
  const by = columnStep(ev);
  if (by) return state.overlay || (isTypingTarget(ev.target) && (ev.target as { id?: unknown }).id !== PIP_INPUT_ID) ? null : { type: "region", to: stepRegion(state.region ?? columnRegion(state.column), by, state.regions) };
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return null;
  if (state.overlay || isTypingTarget(ev.target)) return null;
  // Inside the open decision the same keys act on the need it shows; the pane is in the conversation column, so this comes first.
  if (state.inPane && state.pane) {
    switch (keyIntent(ev)) {
      case "approve":
        return { type: "act", act: "approve" };
      case "dismiss":
        return { type: "act", act: "dismiss" };
      case "skip":
        return { type: "act", act: "skip" };
      case "edit":
        return { type: "act", act: "edit" };
      case "back":
        return { type: "closePane" };
    }
    return null;
  }
  if (state.column === "conversation") return null;
  const need = state.kind === "group" || state.kind === "need";
  // A key that asked for Enter: Enter does it, anything else only cancels it, as on a draft's card.
  if (need && state.asking) return ev.key === "Enter" ? { type: "confirm" } : { type: "cancel" };
  const intent = keyIntent(ev);
  const move = intent === "next" ? 1 : intent === "prev" ? -1 : 0;
  if (move) {
    if (!state.count) return null;
    // From nothing focused, j starts at the top and k at the bottom; at either end it stays.
    const index = state.at < 0 ? (move > 0 ? 0 : state.count - 1) : Math.min(state.count - 1, Math.max(0, state.at + move));
    return { type: "focus", index };
  }
  if (need) {
    // The one model (keyMap.ts): Enter or o opens, a approves, e edits, d dismisses or denies, s skips, Esc goes back.
    switch (intent) {
      case "open":
        return { type: "decide" };
      case "approve":
        return { type: "act", act: "approve" };
      case "dismiss":
        return { type: "act", act: "dismiss" };
      case "skip":
        return { type: "act", act: "skip" };
      case "edit":
        return { type: "act", act: "edit" };
      case "back":
        return state.pane ? { type: "closePane" } : null;
    }
    if (ev.key === " " || ev.key === "ArrowRight") return { type: "decide" };
    return ev.key === "ArrowLeft" ? { type: "collapse" } : null;
  }
  if (state.kind === "run" && intent === "open") return { type: "open" };
  if (ev.key !== "Enter" && ev.key !== " ") return null;
  switch (state.kind) {
    case "row":
      return { type: "open" };
    case "chip":
      return { type: "toggle" };
    // Space on a run card is the page's; a draft card takes its own keys.
    case "run":
      return ev.key === "Enter" ? { type: "open" } : null;
    default:
      return null;
  }
}

/** What may take Tab, before the ones that are disabled, hidden or taken out of the order are left out. */
export const TABBABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab from the last stop on Pip home goes: round to the first stop on the page (the app's rail), never to the page
 * itself, where focus would show nowhere. `stops` are the page's Tab stops in order; null leaves Tab to the browser.
 */
export function wrapTab<T>(ev: Pick<PipHomeKeyEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, stops: readonly T[], active: T | null, onPipHome: boolean): T | null {
  if (ev.key !== "Tab" || ev.shiftKey || ev.metaKey || ev.ctrlKey || ev.altKey || !onPipHome || stops.length < 2) return null;
  return active !== null && stops[stops.length - 1] === active ? stops[0] : null;
}

/** The regions F6 steps through in the workspace layout, in the order they sit on screen: the main area, the peek over it, Pip's pane. */
export type WorkspaceRegion = "main" | "peek" | "pip";

const REGION_ORDER: readonly WorkspaceRegion[] = ["main", "peek", "pip"];

/**
 * Where F6 (`by` 1) or Shift+F6 (-1) goes from `current` among the regions `present` on screen, wrapping round, as Pip
 * home's columns do. Outside Pip home it works from Pip's composer too, which is how the keyboard leaves it.
 */
export function nextRegion(present: readonly WorkspaceRegion[], current: WorkspaceRegion, by: 1 | -1): WorkspaceRegion {
  const shown = REGION_ORDER.filter((r) => r === current || present.includes(r));
  const at = shown.indexOf(current);
  return shown[(at + by + shown.length) % shown.length];
}

/** F6 forward, Shift+F6 back, and nothing for any other key, in the workspace layout. */
export function regionStep(ev: Pick<PipHomeKeyEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target">): 1 | -1 | 0 {
  if (ev.key !== "F6" || ev.metaKey || ev.ctrlKey || ev.altKey) return 0;
  if (isTypingTarget(ev.target) && (ev.target as { id?: unknown }).id !== PIP_INPUT_ID) return 0;
  return ev.shiftKey ? -1 : 1;
}
