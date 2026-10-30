import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

type Attrs = Record<string, string | true | undefined>;

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
  attrs?: Attrs;
}

export interface SegmentedProps<T extends string> {
  label: string;
  options: readonly SegmentOption<T>[];
  /** The chosen segment; null leaves the lens away, for a one-segment toggle that is off. */
  value: T | null;
  onChange(value: T): void;
  /** "pressed" is a row of toggle buttons; "radio" is one choice of several, and the arrow keys move it. */
  kind?: "pressed" | "radio";
  className?: string;
  attrs?: Attrs;
}

/** The segment an arrow key moves to in a radio group, or null when the key does not move it. */
export function nextSegment<T extends string>(values: readonly T[], current: T | null, key: string): T | null {
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  if (!step || values.length === 0) return null;
  const at = current === null ? -1 : values.indexOf(current);
  return values[(at + step + values.length) % values.length];
}

/** What a key chooses: in radio mode an arrow key moves to the next enabled segment; a group of toggles leaves keys to the buttons. */
export function chosenByKey<T extends string>(kind: "pressed" | "radio", options: readonly SegmentOption<T>[], value: T | null, key: string): T | null {
  if (kind !== "radio") return null;
  return nextSegment(options.filter((o) => !o.disabled).map((o) => o.value), value, key);
}

export function Segmented<T extends string>({ label, options, value, onChange, kind = "pressed", className = "", attrs }: SegmentedProps<T>) {
  const track = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [pressing, setPressing] = useState(false);
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => {
      const on = el.querySelector<HTMLElement>("[data-on]");
      const next = on ? { x: on.offsetLeft, w: on.offsetWidth } : null;
      setBox((was) => (was?.x === next?.x && was?.w === next?.w ? was : next));
    };
    measure();
    const frame = requestAnimationFrame(() => setReady(true));
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    watch?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      watch?.disconnect();
    };
  }, [value]);

  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    const to = chosenByKey(kind, options, value, ev.key);
    if (to === null) return;
    ev.preventDefault();
    ev.stopPropagation();
    onChange(to);
    const index = options.findIndex((o) => o.value === to);
    track.current?.querySelectorAll<HTMLElement>(":scope > button")[index]?.focus();
  };

  const release = () => setPressing(false);
  const style = { "--seg-x": `${box?.x ?? 0}px`, "--seg-w": `${box?.w ?? 0}px` } as CSSProperties;

  return (
    <div
      ref={track}
      role={kind === "radio" ? "radiogroup" : "group"}
      aria-label={label}
      data-ready={ready || undefined}
      data-pressing={pressing || undefined}
      className={`ws-seg ${className}`}
      style={style}
      onKeyDown={onKeyDown}
      onPointerDown={() => setPressing(true)}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      {...attrs}
    >
      <span aria-hidden className="ws-seg-thumb" />
      {options.map((o) => {
        const on = o.value === value;
        const state = kind === "radio" ? { role: "radio", "aria-checked": on } : { "aria-pressed": on };
        return (
          <button key={o.value} type="button" {...state} data-on={on || undefined} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)} {...o.attrs}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
