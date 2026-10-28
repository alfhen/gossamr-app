import { isTypingTarget, pressed } from "../lib/keys";
import { PIP_INPUT_ID } from "./draftKeys";
import { keyIntent } from "./keyMap";

/** What the item with focus in a list of needs is: a row for a workstream's group, or a need inside an expanded one. */
export type NeedsItemKind = "group" | "need";

/** Where the list's keyboard stands when a key is pressed. */
export interface NeedsKeyState {
  /** Something over the page takes the keys: the palette, a sheet, the peek, a popover or any other dialog. */
  overlay: boolean;
  /** How many rows the keyboard steps through. */
  count: number;
  /** The one of them with focus, or -1. */
  at: number;
  /** What that one is. */
  kind: NeedsItemKind | null;
  /** A key of the list waits for Enter on the item with focus. */
  asking?: boolean;
  /** A decision is open. */
  pane?: boolean;
  /** Focus is inside that open decision (on its button, not in its answer box): a, e, d and s act on the need it shows. */
  inPane?: boolean;
}

/** What a key in a list of needs does: focus the row at `index`, or act on the row with focus or the open decision. */
export type NeedsKeyAction =
  | { type: "focus"; index: number }
  /** Enter or → on a row: expands it and opens its decision. */
  | { type: "decide" }
  /** ← on a row: folds its group. */
  | { type: "collapse" }
  /** a (approve or allow), d (dismiss or deny), s (skip) or e (edit) on a row, or inside its open decision */
  | { type: "act"; act: "approve" | "dismiss" | "skip" | "edit" }
  /** Enter on a row that asked for it. */
  | { type: "confirm" }
  /** Any other key while a row waits for Enter. */
  | { type: "cancel" }
  /** Esc on a row while a decision is open. */
  | { type: "closePane" }
  /** Ctrl/Cmd+Z outside a field: takes back the newest skip or dismissal still on offer. */
  | { type: "undo" };

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: unknown;
}

/** Whether F6 may leave `target`: Pip's composer, or a single-line input, which F6 types nothing in. */
function f6Leaves(target: unknown, key: string): boolean {
  if (!isTypingTarget(target)) return true;
  if ((target as { id?: unknown }).id === PIP_INPUT_ID) return true;
  return key === "F6" && /^INPUT$/i.test(String((target as { tagName?: unknown }).tagName ?? ""));
}

/**
 * The key `ev` in a list of needs, given where the keyboard is: a step through the rows, or acting on the row with
 * focus or on the open decision. Null leaves the key to whatever else takes it: plain keys never act while the person
 * types in a field or while something is open over the page.
 */
export function needsKey(ev: KeyEventLike, state: NeedsKeyState): NeedsKeyAction | null {
  if (pressed(ev, "work", "undo")) return state.overlay ? null : { type: "undo" };
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return null;
  if (state.overlay || isTypingTarget(ev.target)) return null;
  // Inside the open decision the same keys act on the need it shows.
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
  if (!state.kind) return null;
  // A key that asked for Enter: Enter does it, anything else only cancels it, as on a draft's card.
  if (state.asking) return ev.key === "Enter" ? { type: "confirm" } : { type: "cancel" };
  const intent = keyIntent(ev);
  const move = intent === "next" ? 1 : intent === "prev" ? -1 : 0;
  if (move) {
    if (!state.count) return null;
    // From nothing focused, j starts at the top and k at the bottom; at either end it stays.
    const index = state.at < 0 ? (move > 0 ? 0 : state.count - 1) : Math.min(state.count - 1, Math.max(0, state.at + move));
    return { type: "focus", index };
  }
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

/** What may take Tab, before the ones that are disabled, hidden or taken out of the order are left out. */
export const TABBABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab from the last stop on the page goes: round to the first stop on the page (the app's rail), never to the page
 * itself, where focus would show nowhere. `stops` are the page's Tab stops in order; null leaves Tab to the browser.
 */
export function wrapTab<T>(ev: Pick<KeyEventLike, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, stops: readonly T[], active: T | null, wraps: boolean): T | null {
  if (ev.key !== "Tab" || ev.shiftKey || ev.metaKey || ev.ctrlKey || ev.altKey || !wraps || stops.length < 2) return null;
  return active !== null && stops[stops.length - 1] === active ? stops[0] : null;
}

/** The regions F6 steps through in the workspace layout, in the order they sit on screen: the main area, the peek over it, Pip's pane, and the toast while one is shown. */
export type WorkspaceRegion = "main" | "peek" | "pip" | "toast";

const REGION_ORDER: readonly WorkspaceRegion[] = ["main", "peek", "pip", "toast"];

/**
 * Where F6 (`by` 1) or Shift+F6 (-1) goes from `current` among the regions `present` on screen, wrapping round. It works
 * from Pip's composer too, which is how the keyboard leaves it.
 */
export function nextRegion(present: readonly WorkspaceRegion[], current: WorkspaceRegion, by: 1 | -1): WorkspaceRegion {
  const shown = REGION_ORDER.filter((r) => r === current || present.includes(r));
  const at = shown.indexOf(current);
  return shown[(at + by + shown.length) % shown.length];
}

/** F6 forward, Shift+F6 back, and nothing for any other key, in the workspace layout. */
export function regionStep(ev: Pick<KeyEventLike, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target">): 1 | -1 | 0 {
  if (!pressed(ev, "app", "regions")) return 0;
  if (!f6Leaves(ev.target, ev.key)) return 0;
  return ev.shiftKey ? -1 : 1;
}
