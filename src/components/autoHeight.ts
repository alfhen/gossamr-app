import { useLayoutEffect, type RefObject } from "react";

/** Sizes a textarea to its text. Flex growth is suspended while measuring, or a grown field would never report that it could shrink. */
export function fitHeight(el: HTMLTextAreaElement) {
  const grow = el.style.flexGrow;
  el.style.flexGrow = "0";
  el.style.height = "auto";
  const border = el.offsetHeight - el.clientHeight;
  el.style.height = `${el.scrollHeight + border}px`;
  el.style.flexGrow = grow;
}

/** Keeps a textarea as tall as its text, including when a change of width rewraps it. */
export function useAutoHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string, on = true) {
  useLayoutEffect(() => {
    if (on && ref.current) fitHeight(ref.current);
  }, [ref, value, on]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitHeight(el);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref, on]);
}
