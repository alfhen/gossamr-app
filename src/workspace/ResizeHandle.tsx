import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { dragWidth, keyboardWidth, type Limits } from "./paneSizes";

export function useWindowWidth(): number {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("resize", cb);
      return () => window.removeEventListener("resize", cb);
    },
    () => window.innerWidth,
    () => 1280,
  );
}

interface ResizeOptions {
  value: number;
  limits: Limits;
  fallback: number;
  onChange(width: number): void;
}

export function useResize({ value, limits, fallback, onChange }: ResizeOptions) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });

  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("ws-resizing");
    return () => document.body.classList.remove("ws-resizing");
  }, [dragging]);

  return {
    dragging,
    onPointerDown(ev: PointerEvent<HTMLElement>) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.currentTarget.setPointerCapture(ev.pointerId);
      start.current = { x: ev.clientX, width: value };
      setDragging(true);
    },
    onPointerMove(ev: PointerEvent<HTMLElement>) {
      if (dragging) onChange(dragWidth(start.current.width, start.current.x, ev.clientX, limits));
    },
    onPointerUp(ev: PointerEvent<HTMLElement>) {
      if (ev.currentTarget.hasPointerCapture(ev.pointerId)) ev.currentTarget.releasePointerCapture(ev.pointerId);
      setDragging(false);
    },
    onLostPointerCapture() {
      setDragging(false);
    },
    onKeyDown(ev: KeyboardEvent<HTMLElement>) {
      const next = keyboardWidth(ev.key, ev.shiftKey, value, limits, fallback);
      if (next === null) return;
      ev.preventDefault();
      onChange(next);
    },
    onDoubleClick() {
      onChange(fallback);
    },
  };
}

type Handlers = Omit<ReturnType<typeof useResize>, "dragging">;

interface HandleProps extends Partial<Handlers> {
  label: string;
  value: number;
  limits: Limits;
  dragging?: boolean;
}

export function ResizeHandle({ label, value, limits, dragging = false, ...handlers }: HandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={limits.min}
      aria-valuemax={Math.max(limits.min, Math.round(limits.max))}
      tabIndex={0}
      data-dragging={dragging || undefined}
      title="Drag to resize. Double-click to reset."
      className="ws-resize-handle absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none outline-none"
      {...handlers}
    />
  );
}
