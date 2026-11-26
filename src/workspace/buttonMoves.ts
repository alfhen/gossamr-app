/**
 * Where each answer button sits in what scrolls around it, sampled every frame while one is shown, so a click on a button
 * that moved under the pointer a moment ago can be told from one aimed at it. A card above that shrinks moves every card
 * below it, which no change to their own requests shows. Scrolling moves nothing here: the person did that.
 */
interface Tracked {
  scroller: Element | null;
  x: number;
  y: number;
  movedAt: number;
  onMove(): void;
}

const tracked = new Map<Element, Tracked>();
let frame = 0;

function scrollerOf(el: Element): Element | null {
  for (let at = el.parentElement; at; at = at.parentElement) if (/auto|scroll/.test(getComputedStyle(at).overflowY)) return at;
  return null;
}

/** Where `el` sits in its scroller's content (or the page's), whatever is scrolled into view. */
function place(el: Element, scroller: Element | null): { x: number; y: number } {
  const own = el.getBoundingClientRect();
  if (!scroller) return { x: own.left + window.scrollX, y: own.top + window.scrollY };
  const box = scroller.getBoundingClientRect();
  return { x: own.left - box.left + scroller.scrollLeft, y: own.top - box.top + scroller.scrollTop };
}

/** Notes a move of `el` since it was last seen; true when it moved. */
function check(el: Element, at: Tracked, now: number): boolean {
  const { x, y } = place(el, at.scroller);
  if (x === at.x && y === at.y) return false;
  Object.assign(at, { x, y, movedAt: now });
  at.onMove();
  return true;
}

function sample() {
  const now = performance.now();
  for (const [el, at] of tracked) check(el, at, now);
  frame = tracked.size ? requestAnimationFrame(sample) : 0;
}

/** Follows `el` until the returned function is called, calling `onMove` each time it moves. */
export function trackMoves(el: Element, onMove: () => void): () => void {
  listen();
  const scroller = scrollerOf(el);
  tracked.set(el, { scroller, ...place(el, scroller), movedAt: performance.now(), onMove });
  if (!frame) frame = requestAnimationFrame(sample);
  return () => void tracked.delete(el);
}

/** Whether `el` moved within the last `ms`, including a move since the last frame. */
export function movedWithin(el: Element, ms: number): boolean {
  const at = tracked.get(el);
  if (!at) return true;
  const now = performance.now();
  return check(el, at, now) || now - at.movedAt < ms;
}

/** The last two presses of the pointer anywhere on the page: where, when, and on which button (or element). */
const presses: { x: number; y: number; at: number; on: Element | null }[] = [];
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener(
    "pointerdown",
    (ev) => {
      const on = ev.target instanceof Element ? (ev.target.closest("button") ?? ev.target) : null;
      presses.push({ x: ev.clientX, y: ev.clientY, at: performance.now(), on });
      if (presses.length > 2) presses.shift();
    },
    true,
  );
}

/** How close two presses must be, in px, to count as the pointer not having moved. */
const SAME_SPOT = 4;

/**
 * Whether this press on `el` repeats the one before at the same spot within `ms`, while that one landed on something
 * else: what was under the pointer changed between two clicks it did not move for. It holds however slow the page is.
 */
export function repeatOnOther(el: Element, ms: number): boolean {
  if (presses.length < 2) return false;
  const [before, now] = presses;
  return now.on === el && before.on !== el && now.at - before.at < ms && Math.abs(now.x - before.x) <= SAME_SPOT && Math.abs(now.y - before.y) <= SAME_SPOT;
}
