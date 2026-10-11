import { describe, expect, it, vi } from "vitest";
import { focusPeekDraft, PEEK_CLOSE, PEEK_DRAFT, PEEK_SCROLL, peekFocusAfterLeaving, scrollTopFor } from "./peekDrafts";

/** The peek's scroll container, 400px tall from y=100, scrolled by `scrollTop`. */
const scroller = (scrollTop = 0) => ({ scrollTop, getBoundingClientRect: () => ({ top: 100, bottom: 500 }) });

const el = (id = "", rect = { top: 100, bottom: 200 }, box: ReturnType<typeof scroller> | null = null) => {
  const attrs = new Map<string, string>();
  return {
    id,
    focus: vi.fn(),
    // Scrolls every ancestor, the app's root among them: never to be called.
    scrollIntoView: vi.fn(),
    getBoundingClientRect: () => rect,
    closest: (sel: string) => (sel === PEEK_SCROLL ? box : null),
    hasAttribute: (n: string) => attrs.has(n),
    setAttribute: (n: string, v: string) => void attrs.set(n, v),
    getAttribute: (n: string) => attrs.get(n) ?? null,
  };
};

const rootOf = (cards: ReturnType<typeof el>[], close = el("close")) => ({
  querySelectorAll: (sel: string) => (sel === PEEK_DRAFT ? cards : []),
  querySelector: (sel: string) => {
    if (sel === PEEK_CLOSE) return close;
    const id = /data-draft="([^"]+)"\]$/.exec(sel)?.[1];
    return (sel.startsWith(PEEK_DRAFT) && cards.find((c) => c.id === id)) || null;
  },
});

describe("the keyboard and drafts in the peek", () => {
  it("goes on to the next draft once one is decided, else the one before, else the peek's Close; never nowhere", () => {
    const cards = [el("a"), el("b"), el("c")];
    const close = el("close");
    peekFocusAfterLeaving(cards[1], rootOf(cards, close));
    expect(cards[2].focus).toHaveBeenCalledWith({ preventScroll: true });
    // A card isn't focusable by itself: it is made so from code.
    expect(cards[2].getAttribute("tabindex")).toBe("-1");
    peekFocusAfterLeaving(cards[2], rootOf(cards, close));
    expect(cards[1].focus).toHaveBeenCalled();
    peekFocusAfterLeaving(cards[0], rootOf([cards[0]], close));
    expect(close.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    for (const c of cards) expect(c.scrollIntoView).not.toHaveBeenCalled();
  });

  it("brings the next card into view by scrolling the peek alone, and only as far as it must", () => {
    const box = scroller(50);
    const below = el("below", { top: 450, bottom: 600 }, box);
    peekFocusAfterLeaving(el("gone"), rootOf([below]));
    expect(below.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(below.scrollIntoView).not.toHaveBeenCalled();
    expect(box.scrollTop).toBe(150);
    const seen = scroller(50);
    peekFocusAfterLeaving(el("gone"), rootOf([el("seen", { top: 200, bottom: 300 }, seen)]));
    expect(seen.scrollTop).toBe(50);
  });

  it("focuses the draft opened from Pip home once the peek shows it, its diff in view, and gives up after about two seconds", () => {
    const frames: (() => void)[] = [];
    const frame = (go: () => void) => frames.push(go);
    const cards: ReturnType<typeof el>[] = [];
    const root = rootOf(cards);
    focusPeekDraft("rw-1", root, frame, vi.fn());
    // The peek is still opening: it asks again on the next frame.
    frames.shift()!();
    expect(frames).toHaveLength(1);
    const box = scroller(20);
    const card = el("rw-1", { top: 380, bottom: 900 }, box);
    cards.push(el("other"), card);
    frames.shift()!();
    expect(card.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    // Its diff comes into view at the top of the peek, the peek's own container scrolled and nothing else: a
    // scrollIntoView would scroll the app's root too and push the window's top out of sight.
    expect(card.scrollIntoView).not.toHaveBeenCalled();
    expect(box.scrollTop).toBe(300);
    expect(cards[0].focus).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);

    // A draft that never shows stops being looked for.
    const never: (() => void)[] = [];
    focusPeekDraft("gone", rootOf([]), (go) => never.push(go), vi.fn());
    let n = 0;
    while (never.length && n < 1000) (never.shift()!(), n++);
    expect(n).toBe(120);
  });


  it("scrolls the peek to a card's top for start, and for nearest the least that shows it", () => {
    const box = { top: 100, bottom: 500 };
    expect(scrollTopFor({ top: 300, bottom: 400 }, box, 40, "start")).toBe(240);
    expect(scrollTopFor({ top: 100, bottom: 200 }, box, 40, "start")).toBeNull();
    expect(scrollTopFor({ top: 300, bottom: 400 }, box, 40, "nearest")).toBeNull();
    expect(scrollTopFor({ top: 60, bottom: 160 }, box, 40, "nearest")).toBe(0);
    expect(scrollTopFor({ top: 450, bottom: 560 }, box, 40, "nearest")).toBe(100);
    // Taller than the peek: its top shows.
    expect(scrollTopFor({ top: 450, bottom: 1000 }, box, 40, "nearest")).toBe(390);
  });
});
