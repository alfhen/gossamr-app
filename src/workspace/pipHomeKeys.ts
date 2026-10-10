import { PIP_INPUT_ID } from "./draftKeys";
import { PIP_HOME_COLUMNS, type PipHomeColumn } from "./pipHomeStore";

/** What the item with focus in the workstream list or the step rail is, as the keyboard steps through them. */
export type PipHomeItemKind = "row" | "tray" | "chip" | "run" | "draft";

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
}

/** What a key on Pip home does: go to a column, focus the item at `index` in this one, or act on the item with focus. */
export type PipHomeKeyAction = { type: "column"; to: PipHomeColumn } | { type: "focus"; index: number } | { type: "open" } | { type: "toggle" };

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

const step = (column: PipHomeColumn, by: 1 | -1): PipHomeColumn => {
  const at = PIP_HOME_COLUMNS.indexOf(column);
  return PIP_HOME_COLUMNS[(at + by + PIP_HOME_COLUMNS.length) % PIP_HOME_COLUMNS.length];
};

/**
 * Which way a key moves between Pip home's columns: F6 and Cmd/Ctrl+] go right, Shift+F6 and Cmd/Ctrl+[ left, wrapping
 * around. Like Cmd/Ctrl+J they work from Pip's composer too, which is how the person leaves it; never from another field
 * (a budget, an answer to a run), where shortcuts don't fire while the person types.
 */
function columnStep(ev: PipHomeKeyEvent): 1 | -1 | 0 {
  if (ev.altKey) return 0;
  if (ev.key === "F6" && !ev.metaKey && !ev.ctrlKey) return ev.shiftKey ? -1 : 1;
  if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey) return ev.key === "]" ? 1 : ev.key === "[" ? -1 : 0;
  return 0;
}

/**
 * The key `ev` on Pip home, given where the keyboard is: a column move, a step through the list or the rail, or opening
 * or toggling the item with focus. Null leaves the key to whatever else takes it: plain keys never act while the person
 * types in a field or while something is open over Pip home, and in the conversation they stay its cards' own.
 */
export function pipHomeKey(ev: PipHomeKeyEvent, state: PipHomeKeyState): PipHomeKeyAction | null {
  const by = columnStep(ev);
  if (by) return state.overlay || (isTypingTarget(ev.target) && (ev.target as { id?: unknown }).id !== PIP_INPUT_ID) ? null : { type: "column", to: step(state.column, by) };
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return null;
  if (state.overlay || isTypingTarget(ev.target) || state.column === "conversation") return null;
  const move = ev.key === "j" || ev.key === "ArrowDown" ? 1 : ev.key === "k" || ev.key === "ArrowUp" ? -1 : 0;
  if (move) {
    if (!state.count) return null;
    // From nothing focused, j starts at the top and k at the bottom; at either end it stays.
    const index = state.at < 0 ? (move > 0 ? 0 : state.count - 1) : Math.min(state.count - 1, Math.max(0, state.at + move));
    return { type: "focus", index };
  }
  if (ev.key !== "Enter" && ev.key !== " ") return null;
  switch (state.kind) {
    case "row":
    case "tray":
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
