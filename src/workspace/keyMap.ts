/**
 * One keyboard model for every list that holds things to act on: the Needs you list, draft cards (in the conversation, the
 * step rail, Activity's Drafts and the ticket peek), the Agents list. The same key means the same thing wherever it is
 * pressed; what a place can't do with it, it ignores.
 *
 *   j / k (or the arrows)  move
 *   Enter or o             open
 *   a                      approve (a draft), allow (a permission), the primary action of the item
 *   e                      edit
 *   d                      dismiss (a failure, a draft), deny (a permission)
 *   s                      skip (a draft)
 *   Esc                    back
 *
 * What a key does to an item is for the item to say (`needsActions.keyPlan`, `draftKeys.draftKeyAction`); this is only
 * which key is which intent, and the hint line every footer reads.
 */
export type KeyIntent = "next" | "prev" | "open" | "approve" | "edit" | "dismiss" | "skip" | "back";

interface Binding {
  intent: KeyIntent;
  keys: readonly string[];
}

/** Every binding, in the order the footer names them. */
export const KEY_BINDINGS: readonly Binding[] = [
  { intent: "next", keys: ["j", "ArrowDown"] },
  { intent: "prev", keys: ["k", "ArrowUp"] },
  { intent: "open", keys: ["Enter", "o"] },
  { intent: "approve", keys: ["a"] },
  { intent: "edit", keys: ["e"] },
  { intent: "dismiss", keys: ["d"] },
  { intent: "skip", keys: ["s"] },
  { intent: "back", keys: ["Escape"] },
];

const BY_KEY = new Map(KEY_BINDINGS.flatMap((b) => b.keys.map((k) => [k, b.intent] as const)));

interface Modifiers {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** What a plain key press means in the model; null for any other key, and for any press with a modifier held. */
export function keyIntent(ev: Modifiers): KeyIntent | null {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return null;
  return BY_KEY.get(ev.key) ?? null;
}

/** Whether `key` is any of the model's letters (a, e, d, s, o), the ones a field being typed in must keep. */
export const isActionKey = (key: string) => key.length === 1 && BY_KEY.has(key) && !["j", "k"].includes(key);

/** The kinds of item the keys act on, for `keyHint`. */
export type KeyItem = "need" | "draft" | "run" | "list";

/** What each key does on each kind of item, for the hint line: the keys, then the words. A kind leaves out a key it has no use for. */
export const HINTS: Record<KeyItem, readonly (readonly [keys: string, what: string])[]> = {
  need: [["j k", "move"], ["↵", "open"], ["a", "approve or allow"], ["e", "edit"], ["d", "dismiss or deny"], ["s", "skip"], ["Esc", "back"]],
  draft: [["j k", "move"], ["↵", "open"], ["a", "approve"], ["e", "edit"], ["d s", "skip"], ["Esc", "back"]],
  run: [["j k", "move"], ["↵", "open"], ["a", "allow or retry"], ["d", "dismiss or deny"], ["Esc", "back"]],
  list: [["j k", "move"], ["↵", "open"], ["Esc", "back"]],
};

/** The footer line for the keyboard on a `kind` of item: "j k move · ↵ open · a approve …", from the same table everywhere. */
export const keyHint = (kind: KeyItem): string => HINTS[kind].map(([keys, what]) => `${keys} ${what}`).join(" · ");

/** The key labels a hint may use, each the display of a binding: "↵" is Enter, "Esc" is Escape. */
export const KEY_LABEL: Record<string, string> = { Enter: "↵", Escape: "Esc", ArrowDown: "↓", ArrowUp: "↑" };
