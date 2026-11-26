/**
 * Where each Allow sits in the layout of what scrolls around it, sampled for a short burst after anything on the page
 * changes (the DOM, a size, an answer) and at every pointer move and press, and whether the
 * pointer has been off it since, so a click on an Allow that came under a resting pointer can be told from one aimed at
 * it. A card above that shrinks moves every card below it, which no change to their own requests shows. Scrolling moves
 * nothing here (the person did that), and neither does a transform: the place is read from an untransformed wrapper, since
 * a button swells as it is pressed.
 */
interface Tracked {
  /** What is measured: the button's untransformed wrapper. */
  box: Element;
  scroller: Element | null;
  x: number;
  y: number;
  movedAt: number;
  /** The last moment the pointer was off the button. */
  outsideAt: number;
  onMove(): void;
}

const tracked = new Map<Element, Tracked>();
let frame = 0;
/** Frames left in the current burst of sampling. */
let burstLeft = 0;
/** Frames a burst lasts: long enough for a layout change and what it sets off to settle. */
const BURST_FRAMES = 30;
let watching: { stop(): void } | null = null;

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

/** Notes a move of `at` since it was last seen; true when it moved. */
function check(at: Tracked, now: number): boolean {
  const { x, y } = place(at.box, at.scroller);
  if (x === at.x && y === at.y) return false;
  Object.assign(at, { x, y, movedAt: now });
  at.onMove();
  return true;
}

function sample() {
  const now = performance.now();
  for (const at of tracked.values()) check(at, now);
  frame = tracked.size && --burstLeft > 0 ? requestAnimationFrame(sample) : 0;
}

/** Samples every frame for a while; nothing runs while the page is still. */
function burst() {
  if (!tracked.size) return;
  burstLeft = BURST_FRAMES;
  if (!frame) frame = requestAnimationFrame(sample);
}

/** Watches the page for what can move a button while one is followed: a change to the DOM, or to the window's size. */
function watch() {
  if (watching) return;
  const dom = new MutationObserver(burst);
  dom.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(burst);
  sizes?.observe(document.documentElement);
  window.addEventListener("resize", burst);
  watching = {
    stop() {
      dom.disconnect();
      sizes?.disconnect();
      window.removeEventListener("resize", burst);
    },
  };
}

/**
 * Follows the Allow `el`, measured by `box` (an untransformed element that moves with it), until the returned function
 * is called, calling `onMove` each time it moves.
 */
export function trackMoves(el: Element, box: Element, onMove: () => void): () => void {
  listen();
  const scroller = scrollerOf(box);
  tracked.set(el, { box, scroller, ...place(box, scroller), movedAt: performance.now(), outsideAt: Number.NEGATIVE_INFINITY, onMove });
  watch();
  burst();
  return () => {
    tracked.delete(el);
    if (tracked.size) return;
    watching?.stop();
    watching = null;
  };
}

/** Whether `el` moved within the last `ms`, including a move since the last frame. */
export function movedWithin(el: Element, ms: number): boolean {
  const at = tracked.get(el);
  if (!at) return true;
  const now = performance.now();
  return check(at, now) || now - at.movedAt < ms;
}

/** The last two presses of the pointer anywhere on the page: where, when, and on which button (or element). */
const presses: { x: number; y: number; at: number; on: Element | null }[] = [];
let listening = false;

/** Where the pointer last was, unknown until it moves; when the last answer on the page was given. */
let pointer = { x: Number.NaN, y: Number.NaN };
let answer = { seq: 0, at: Number.NEGATIVE_INFINITY };
/** The answer each Allow last had focus moved onto it by a key after. */
const keyAimed = new WeakMap<Element, number>();
/** A key that moves focus was pressed in this task. */
let navigating = false;

const inside = (p: { x: number; y: number }, r: DOMRect) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener(
    "pointermove",
    (ev) => {
      const before = pointer;
      pointer = { x: ev.clientX, y: ev.clientY };
      const now = performance.now();
      for (const at of tracked.values()) check(at, now);
      // Off the button where it is now, before this move or after it. A pointer resting where a button came to be is on
      // it, and so is a wobble inside it.
      for (const [el, at] of tracked) {
        const r = el.getBoundingClientRect();
        if ((Number.isFinite(before.x) && !inside(before, r)) || !inside(pointer, r)) at.outsideAt = now;
      }
    },
    true,
  );
  // Focus moved by a key: a Tab or an arrow pressed just now, not code that focused Allow after some other key.
  document.addEventListener(
    "keydown",
    (ev) => {
      if (!/^(Tab|Arrow(Up|Down|Left|Right))$/.test(ev.key)) return;
      navigating = true;
      setTimeout(() => (navigating = false), 0);
    },
    true,
  );
  document.addEventListener(
    "focusin",
    (ev) => {
      if (navigating && ev.target instanceof Element && ev.target.matches("[data-allow]")) keyAimed.set(ev.target, answer.seq);
    },
    true,
  );
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

/** Notes a permission answer: from now on an Allow counts only when aimed afresh. */
export function noteAnswer() {
  answer = { seq: answer.seq + 1, at: performance.now() };
  burst();
}

/**
 * Whether a click on the Allow `el` was aimed at it. By the pointer: it has been off `el` at some moment after both the
 * last answer on the page and `el`'s last change of place, so clicks at one spot and a wobble inside the button never
 * count, while leaving it and coming back does. By a key: focus was moved onto `el` by a key after the last answer.
 */
export function aimedAfresh(el: Element, byKey: boolean): boolean {
  if (byKey) return !answer.seq || keyAimed.get(el) === answer.seq;
  const at = tracked.get(el);
  return !!at && at.outsideAt > Math.max(at.movedAt, answer.at);
}
