/**
 * Every global and screen-level shortcut, in one table: its key, the screen it belongs to and its label. Handlers look
 * their key up here, and the footer hints and the keys shown on buttons read their text from here, so the two cannot
 * drift apart.
 *
 * Kept next to the field they edit instead, because moving them here adds nothing: Enter to send in a text box, Esc to
 * leave a dialog, a popover or an open confirmation, and the arrow keys inside a menu, a tab strip or a list widget.
 */
export type KeyScope = "app" | "canvas" | "inbox" | "work" | "peek" | "list";

/** The footers that show a shortcut: the Board and List canvases, and the Work screen. */
export type FooterOn = "canvas" | "work";

export interface Shortcut {
  id: string;
  scope: KeyScope;
  /** `KeyboardEvent.key` values that trigger it. */
  keys: readonly string[];
  /** Needs ⌘ (or Ctrl); keys are then compared in lower case. */
  mod?: boolean;
  /** Fires with Shift held too (a modifier-free key never does). */
  shiftOk?: boolean;
  /** Fires while the person types in a field. Plain keys never do (rule 6). */
  inFields?: boolean;
  label: string;
  /** How the key reads on screen. A shortcut without one is not shown. */
  show?: string;
  /** Where it is named in a footer, and how soon it goes when the footer narrows (0 stays longest). */
  footer?: Partial<Record<FooterOn, { rank: number; text: string }>>;
}

/** In the order the footers name them. Ids are unique within a scope. */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: "next", scope: "list", keys: ["j", "ArrowDown"], label: "Next item", show: "j k", footer: { work: { rank: 0, text: "move" } } },
  { id: "prev", scope: "list", keys: ["k", "ArrowUp"], label: "Previous item" },
  { id: "open", scope: "list", keys: ["Enter", "o"], label: "Open", show: "↵", footer: { work: { rank: 0, text: "open" } } },
  { id: "approve", scope: "list", keys: ["a"], label: "Approve, allow or retry" },
  { id: "edit", scope: "list", keys: ["e"], label: "Edit" },
  { id: "dismiss", scope: "list", keys: ["d"], label: "Dismiss or deny" },
  { id: "skip", scope: "list", keys: ["s"], label: "Skip" },
  { id: "back", scope: "list", keys: ["Escape"], label: "Back" },

  { id: "step", scope: "canvas", keys: ["j", "k"], label: "Next or previous ticket", show: "j k", footer: { canvas: { rank: 0, text: "move and peek" } } },
  { id: "menu", scope: "canvas", keys: ["m", "ContextMenu"], label: "Open a card's menu" },

  { id: "step", scope: "inbox", keys: ["j", "k"], label: "Next or previous entry" },
  { id: "markRead", scope: "inbox", keys: ["m"], label: "Mark an entry read" },

  { id: "ask", scope: "work", keys: ["n"], label: "Ask Pip", show: "n", footer: { work: { rank: 1, text: "ask Pip" } } },
  { id: "undo", scope: "work", keys: ["z"], mod: true, label: "Undo the newest skip or dismissal" },

  { id: "reply", scope: "peek", keys: ["r"], label: "Reply to a comment" },

  { id: "close", scope: "app", keys: ["Escape"], label: "Close the peek or Pip's pane", show: "Esc", footer: { canvas: { rank: 1, text: "close" }, work: { rank: 1, text: "clear" } } },
  { id: "regions", scope: "app", keys: ["F6"], shiftOk: true, inFields: true, label: "Move between the page, the peek and Pip", show: "F6", footer: { work: { rank: 2, text: "regions" } } },
  { id: "pip", scope: "app", keys: ["j"], mod: true, inFields: true, label: "Open or close Pip", show: "⌘J", footer: { canvas: { rank: 3, text: "Pip" }, work: { rank: 3, text: "Pip" } } },
  { id: "jump", scope: "app", keys: ["k"], mod: true, inFields: true, label: "Search and jump", show: "⌘K", footer: { canvas: { rank: 1, text: "jump" }, work: { rank: 2, text: "jump" } } },
];

const find = (scope: KeyScope, id: string): Shortcut => {
  const s = SHORTCUTS.find((x) => x.scope === scope && x.id === id);
  if (!s) throw new Error(`No shortcut ${scope}.${id}`);
  return s;
};

/** The keys of a shortcut, as `KeyboardEvent.key` values. */
export const keysOf = (scope: KeyScope, id: string): readonly string[] => find(scope, id).keys;

/** How a shortcut reads on screen: "⌘J", "Esc". */
export const showOf = (scope: KeyScope, id: string): string => find(scope, id).show ?? find(scope, id).keys[0];

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
}

/** Whether `target` takes typing: an input, a textarea, a select or anything editable. Plain keys are never shortcuts there. */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown; closest?: (s: string) => unknown };
  if (el.isContentEditable === true) return true;
  if (typeof el.tagName === "string" && /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) return true;
  return typeof el.closest === "function" && !!el.closest("[contenteditable]:not([contenteditable=false])");
}

/**
 * Whether `ev` is the shortcut `scope`.`id`: its key with exactly the modifiers it names, and not typed into a field
 * unless the shortcut is one that works there. The one place the typing guard is applied.
 */
export function pressed(ev: KeyLike, scope: KeyScope, id: string): boolean {
  const s = find(scope, id);
  if (!!(ev.metaKey || ev.ctrlKey) !== !!s.mod || ev.altKey || (ev.shiftKey && !s.shiftOk)) return false;
  if (!(s.mod ? s.keys.includes(ev.key.toLowerCase()) : s.keys.includes(ev.key))) return false;
  return s.inFields || !isTypingTarget(ev.target);
}

/** Which of a two-key step shortcut (`j k`) `ev` is: 1 for the first key, -1 for the second, 0 for neither. */
export function stepOf(ev: KeyLike, scope: KeyScope, id = "step"): 1 | -1 | 0 {
  if (!pressed(ev, scope, id)) return 0;
  return ev.key === find(scope, id).keys[0] ? 1 : -1;
}

/** One hint of a footer: the keys, then what they do. */
export interface FooterHint {
  id: string;
  /** Lower numbers stay visible longer as the footer narrows. */
  rank: number;
  keys: string[];
  text: string;
}

/** The hints a footer names, in table order. */
export function footerHints(on: FooterOn): FooterHint[] {
  return SHORTCUTS.flatMap((s) => {
    const at = s.footer?.[on];
    return at && s.show ? [{ id: `${s.scope}.${s.id}`, rank: at.rank, keys: s.show.split(" "), text: at.text }] : [];
  });
}
