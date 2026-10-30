import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

const SCROLLER = "[data-bar-scroll]";

/**
 * A screen's header laid over its content. The scroller marked `data-bar-scroll` pads its top with `--ws-bar-h`,
 * so at rest the bar is solid and nothing sits beneath it; once the content scrolls the bar fades and its controls blur what passes.
 */
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
    barEl.current?.removeAttribute("data-under");
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
