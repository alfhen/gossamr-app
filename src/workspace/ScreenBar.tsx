import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

const SCROLLER = "[data-bar-scroll]";

/** A screen's header laid over its content: solid at rest, fading once the `data-bar-scroll` scroller moves under it. */
export function ScreenBar({ bar, resetKey, children }: { bar: ReactNode; resetKey: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const barEl = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = barEl.current;
    if (!el) return;
    const measure = () => frame.current?.style.setProperty("--ws-bar-h", `${el.offsetHeight}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    const root = frame.current;
    if (!root) return;
    let scroller = root.querySelector<HTMLElement>(SCROLLER);
    const mark = () => barEl.current?.toggleAttribute("data-under", (scroller?.scrollTop ?? 0) > 2);
    mark();
    if (typeof MutationObserver === "undefined") return;
    // A filter that empties the list swaps the scroller for a note without a scroll event, so the swap itself re-reads the fade.
    const watch = new MutationObserver(() => {
      const next = root.querySelector<HTMLElement>(SCROLLER);
      if (next === scroller) return;
      scroller = next;
      mark();
    });
    watch.observe(root, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [resetKey]);

  return (
    <div
      ref={frame}
      className="relative min-h-0 flex-1"
      onScrollCapture={(ev) => {
        const el = ev.target as HTMLElement;
        if (!el.matches?.(SCROLLER) || !barEl.current) return;
        barEl.current.toggleAttribute("data-under", el.scrollTop > 2);
      }}
    >
      <div
        ref={barEl}
        className="ws-bar"
        onWheel={(ev) => {
          // The bar covers the top of the scroller, so a wheel over it would otherwise scroll nothing.
          frame.current?.querySelector<HTMLElement>(SCROLLER)?.scrollBy({ top: ev.deltaY });
        }}
      >
        {bar}
      </div>
      <div className="h-full">{children}</div>
    </div>
  );
}
