/** A draft's card in the peek, as "Drafts waiting" lists it. */
export const PEEK_DRAFT = "#peek-sheet article[data-draft]";

/** The peek's own Close, where the keyboard waits once the peek has no draft left to go to. */
export const PEEK_CLOSE = '#peek-sheet button[aria-label="Close details"]';

/** The peek's own scroll container, the only thing a card focused from code may scroll. */
export const PEEK_SCROLL = "[data-peek-scroll]";

interface Box {
  top: number;
  bottom: number;
}

interface Scroller {
  scrollTop: number;
  getBoundingClientRect(): Box;
}

interface Focusable {
  focus(options?: FocusOptions): void;
  hasAttribute?(name: string): boolean;
  setAttribute?(name: string, value: string): void;
  closest?(selector: string): unknown;
  getBoundingClientRect?(): Box;
}

interface Root {
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): ArrayLike<unknown>;
}

/**
 * Where `box` must scroll to so `card` is in view, its top at the top for "start", or the least move for "nearest" (a
 * card taller than the box shows its top). Null when it needn't move.
 */
export function scrollTopFor(card: Box, box: Box, scrollTop: number, block: ScrollLogicalPosition): number | null {
  const above = card.top - box.top;
  if (block === "start" || above < 0 || card.bottom - card.top > box.bottom - box.top) return above === 0 ? null : scrollTop + above;
  const below = card.bottom - box.bottom;
  return below > 0 ? scrollTop + below : null;
}

/**
 * Focuses `el` from code, a card that isn't focusable by itself included, and brings it into view by scrolling the peek's
 * own container only. `scrollIntoView`, or a plain `focus()`, scrolls every ancestor too, the app's overflow-hidden root
 * among them, which shifts the whole window up under the person until the peek closes.
 */
function take(el: Focusable, block: ScrollLogicalPosition) {
  if (el.hasAttribute && !el.hasAttribute("tabindex")) el.setAttribute?.("tabindex", "-1");
  el.focus({ preventScroll: true });
  const box = el.closest?.(PEEK_SCROLL) as Scroller | null | undefined;
  if (!box || !el.getBoundingClientRect) return;
  const to = scrollTopFor(el.getBoundingClientRect(), box.getBoundingClientRect(), box.scrollTop, block);
  if (to !== null) box.scrollTop = to;
}

/**
 * Where focus goes when the draft card `card`, which had it, leaves the peek (decided there): the next card, else the
 * one before, else the peek's Close. Never nowhere, where the keyboard would be lost behind the peek.
 */
export function peekFocusAfterLeaving(card: unknown, root: Root) {
  const cards = Array.from(root.querySelectorAll(PEEK_DRAFT)) as Focusable[];
  const at = cards.indexOf(card as Focusable);
  const next = at < 0 ? cards[0] : (cards[at + 1] ?? cards[at - 1]);
  if (next) return take(next, "nearest");
  (root.querySelector(PEEK_CLOSE) as Focusable | null)?.focus({ preventScroll: true });
}

/** About two seconds of frames: long enough for the peek to open, short enough that a stale ask doesn't linger. */
const FOCUS_FRAMES = 120;

/**
 * Hands the keyboard to draft `id`'s card in the peek once the peek shows it, as when a draft on Pip home that is read
 * in the peek (a description rewrite) is opened from there: the card's diff comes into view and its buttons are the
 * next Tabs. Gives up after about two seconds. Returns a cancel.
 */
export function focusPeekDraft(id: string, root: Root = document, frame: (go: () => void) => number = requestAnimationFrame, cancel: (n: number) => void = cancelAnimationFrame): () => void {
  let handle = 0;
  let tries = 0;
  const find = () => {
    const card = root.querySelector(`${PEEK_DRAFT}[data-draft="${id.replace(/["\\]/g, "\\$&")}"]`) as Focusable | null;
    if (card) return take(card, "start");
    if (++tries < FOCUS_FRAMES) handle = frame(find);
  };
  handle = frame(find);
  return () => cancel(handle);
}
