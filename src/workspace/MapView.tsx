import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { useWorkspace } from "../workspaceStore";
import { daysQuiet } from "./boardLogic";
import { ageLevel, statusTone, type StatusTone } from "./canvasShared";
import { CanvasFooter } from "./CanvasFooter";
import type { CanvasProps } from "./canvases";
import { FIT, layoutMap, neighbour, shownKey, zoomAt, type Direction, type MapEdge, type MapLayout, type Viewport } from "./mapLayout";
import { useTabs } from "./tabsStore";
import { useCards } from "./useCards";

const FILL: Record<StatusTone, string> = { todo: "fill-ws-ink3", active: "fill-ws-accent", done: "fill-ws-done", review: "fill-ws-review", blocked: "fill-ws-blocked" };
const ARROWS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
const nodeId = (key: string) => `map-node-${key}`;

export interface MapSvgProps {
  layout: MapLayout;
  viewport: Viewport;
  selected: string | null;
  marked: readonly string[];
  focused: string | null;
  hovered: string | null;
  blocked: ReadonlySet<string>;
  /** Tickets waiting on the person, which pulse. */
  needsMe: ReadonlySet<string>;
  now: Date;
  drafts: Readonly<Record<string, number>>;
  onNode(key: string, ev: MouseEvent): void;
  onHover(key: string | null): void;
  onCluster(parentKey: string): void;
}

const touches = (e: MapEdge, key: string | null) => key !== null && (e.from === key || e.to === key);

/** The map itself, with no state of its own: the same props always draw the same picture. */
export function MapSvg({ layout, viewport, selected, marked, focused, hovered, blocked, needsMe, now, drafts, onNode, onHover, onCluster }: MapSvgProps) {
  const active = hovered ?? focused;
  const clusters = new Map(layout.clusters.map((c) => [c.key, c]));
  const near = new Set(layout.edges.filter((e) => touches(e, active)).flatMap((e) => [e.from, e.to]));
  return (
    <svg viewBox={`-30 -56 ${layout.width + 60} ${layout.height + 86}`} role="presentation" className="h-full w-full select-none">
      <defs>
        <marker id="map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L8 4L0 8z" className="fill-ws-blocked" />
        </marker>
      </defs>
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.k})`}>
        {layout.clusters.map((c) => (
          <g key={c.key} data-cluster={c.key}>
            <circle cx={c.x} cy={c.y} r={c.r} className="fill-ws-accent-soft stroke-ws-sep2" strokeDasharray="4 5" fillOpacity={0.5} />
            <text
              x={c.x}
              y={c.y - c.r - 22}
              textAnchor="middle"
              className={`fill-ws-ink2 text-[13px] font-bold ${c.parentKey ? "cursor-pointer hover:fill-ws-ink" : ""}`}
              onClick={c.parentKey ? () => onCluster(c.parentKey!) : undefined}
            >
              {c.label}
            </text>
            <text x={c.x} y={c.y - c.r - 7} textAnchor="middle" className="fill-ws-ink3 text-[10px]">
              {c.sub} · {c.done}/{c.total} done{c.shown < c.total ? ` · ${c.shown} shown` : ""}
            </text>
            <rect x={c.x - 30} y={c.y - c.r - 1} width={60} height={3} rx={1.5} className="fill-ws-sep" />
            <rect x={c.x - 30} y={c.y - c.r - 1} width={c.total ? (60 * c.done) / c.total : 0} height={3} rx={1.5} className="fill-ws-done" />
          </g>
        ))}
        {layout.edges.map((e) => {
          const lit = touches(e, active);
          const blocks = e.kind === "blocks";
          return (
            <path
              key={e.key}
              d={e.d}
              data-edge={e.kind}
              data-lit={lit || undefined}
              fill="none"
              strokeWidth={lit ? 2.6 : blocks ? 1.6 : 1.2}
              strokeDasharray={blocks ? undefined : "4 4"}
              markerEnd={blocks ? "url(#map-arrow)" : undefined}
              opacity={active === null ? 0.7 : lit ? 1 : 0.12}
              className={blocks ? "stroke-ws-blocked" : "stroke-ws-ink3"}
            />
          );
        })}
        {layout.nodes.map((n) => {
          const isSelected = selected === n.key;
          const isMarked = marked.includes(n.key);
          const isBlocked = blocked.has(n.key);
          const dim = active !== null && !near.has(n.key) && active !== n.key;
          const label = active === n.key || isSelected;
          const cluster = clusters.get(n.cluster);
          const tone = statusTone(n.item.status);
          const days = daysQuiet(n.item, now);
          const stale = tone === "done" ? 0 : ageLevel(days);
          const pulses = needsMe.has(n.key);
          return (
            <g
              key={n.key}
              id={nodeId(n.key)}
              role="button"
              aria-label={`${n.item.item.key} ${n.item.title}, ${n.item.status.name}${isBlocked ? ", blocked" : ""}${pulses ? ", needs you" : ""}${stale >= 2 ? `, quiet for ${days} days` : ""}${drafts[n.key] ? ", has a draft" : ""}${cluster ? `, in ${cluster.label}` : ""}`}
              aria-pressed={isSelected}
              data-node={n.key}
              className="cursor-pointer motion-safe:transition-opacity"
              opacity={dim ? 0.3 : stale >= 2 ? 0.7 : 1}
              onClick={(ev) => onNode(n.key, ev)}
              onPointerEnter={() => onHover(n.key)}
              onPointerLeave={() => onHover(null)}
            >
              <title>{`${n.item.item.key} · ${n.item.title} · ${n.item.status.name}`}</title>
              {isBlocked && <circle cx={n.x} cy={n.y} r={n.r + 5} fill="none" strokeWidth={1.5} strokeDasharray="3 2" className="stroke-ws-blocked" data-blocked />}
              {pulses && <circle cx={n.x} cy={n.y} r={n.r} fill="none" strokeWidth={2} className="ws-ring stroke-ws-pip" data-pulse />}
              <circle
                cx={n.x}
                cy={n.y}
                r={n.r}
                strokeWidth={isSelected || isMarked ? 3.5 : 2}
                strokeDasharray={stale >= 3 ? "3 2" : undefined}
                className={`${FILL[tone]} ${isSelected ? "stroke-ws-pip" : isMarked ? "stroke-ws-accent" : "stroke-ws-win"}`}
                fillOpacity={stale >= 2 ? 0.55 : tone === "done" ? 0.7 : 0.95}
              />
              {stale >= 2 && (
                <text x={n.x + n.r * 0.7} y={n.y - n.r * 0.5} fontSize={stale >= 3 ? 13 : 11} aria-hidden data-stale={stale >= 3 ? "spider" : "web"}>
                  {stale >= 3 ? "🕷" : "🕸"}
                </text>
              )}
              {focused === n.key && <circle cx={n.x} cy={n.y} r={n.r + 8} fill="none" strokeWidth={2} className="stroke-ws-pip" data-focus />}
              {drafts[n.key] ? <circle cx={n.x + n.r * 0.75} cy={n.y - n.r * 0.75} r={4.5} strokeWidth={1.5} className="fill-ws-pip stroke-ws-win" data-draft /> : null}
              <text x={n.x} y={n.y + n.r + 11} textAnchor="middle" className="fill-ws-ink2 font-mono text-[9.5px] font-bold">
                {n.item.item.key.replace(/^[A-Za-z]+-/, "")}
              </text>
              {label && (
                <text x={n.x} y={n.y - n.r - 8} textAnchor="middle" strokeWidth={4} paintOrder="stroke" className="fill-ws-ink stroke-ws-win text-[11px] font-semibold">
                  {n.item.title.length > 38 ? `${n.item.title.slice(0, 37)}…` : n.item.title}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

const KEY_DOTS: { tone: StatusTone; label: string }[] = [
  { tone: "todo", label: "To do" },
  { tone: "active", label: "In progress" },
  { tone: "review", label: "Review / QA" },
  { tone: "blocked", label: "Blocked" },
  { tone: "done", label: "Done" },
];
const DOT: Record<StatusTone, string> = { todo: "bg-ws-ink3", active: "bg-ws-accent", done: "bg-ws-done", review: "bg-ws-review", blocked: "bg-ws-blocked" };

export function MapKey() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ws-ink3">
      {KEY_DOTS.map((d) => (
        <span key={d.tone} className="flex items-center gap-1">
          <i className={`size-2 rounded-full ${DOT[d.tone]}`} />
          {d.label}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <i className="size-2 rounded-full border border-dashed border-ws-blocked" />
        Blocked by another ticket
      </span>
      <span className="flex items-center gap-1">
        <i className="size-2 rounded-full border-2 border-ws-pip" />
        Needs you
      </span>
      <span className="flex items-center gap-1">
        <i className="size-2 rounded-full bg-ws-pip" />
        Draft waiting
      </span>
      <span>Size shows discussion</span>
      <span aria-label="Web after 5 quiet days, spider after 7">🕸 5d+ 🕷 7d+</span>
    </div>
  );
}

export function CapNotice({ shown, total }: { shown: number; total: number }) {
  if (shown >= total) return null;
  return (
    <p role="status" className="rounded-lg bg-ws-bar px-3 py-1.5 text-sm text-ws-ink2">
      Showing {shown} of {total} tickets. Narrow the filter to see the rest.
    </p>
  );
}

export function MapView({ items }: CanvasProps) {
  const all = useWorkspace((s) => s.items);
  const containers = useWorkspace((s) => s.containers);
  const layout = useMemo(() => layoutMap(items, all, containers), [items, all, containers]);
  const order = useMemo(() => layout.nodes.map((n) => n.key), [layout]);
  const cards = useCards(items, order);
  const selected = useTabs((s) => s.selected);
  const [viewport, setViewport] = useState<Viewport>(FIT);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focusKey, setFocused] = useState<string | null>(null);
  const focused = shownKey(layout.nodes, focusKey);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => setViewport(FIT), [layout]);

  // j and k move the selection; the arrow keys carry on from wherever it lands.
  useEffect(() => {
    if (selected && layout.nodes.some((n) => n.key === selected)) setFocused(selected);
  }, [selected]);

  const unitsPerPixel = () => {
    const svg = box.current?.querySelector("svg");
    const scale = svg?.getScreenCTM()?.a;
    return scale ? 1 / scale : 1;
  };

  const zoomBy = (factor: number, at?: { clientX: number; clientY: number }) => {
    const svg = box.current?.querySelector("svg");
    const ctm = svg?.getScreenCTM();
    let px = layout.width / 2;
    let py = layout.height / 2;
    if (ctm && svg) {
      const rect = svg.getBoundingClientRect();
      const p = new DOMPoint(at?.clientX ?? rect.left + rect.width / 2, at?.clientY ?? rect.top + rect.height / 2).matrixTransform(ctm.inverse());
      px = p.x;
      py = p.y;
    }
    setViewport((vp) => zoomAt(vp, px, py, factor));
  };
  const zoomRef = useRef(zoomBy);
  zoomRef.current = zoomBy;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const step = ev.ctrlKey ? 0.01 : 0.0018;
      zoomRef.current(Math.exp(-Math.max(-50, Math.min(50, ev.deltaY)) * step), ev);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [layout.nodes.length]);

  useEffect(() => () => useTabs.getState().clearMarks(), []);

  if (!layout.total) return <p className="p-10 text-center text-ws-ink3">Nothing matches this filter.</p>;

  const onPointerDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    drag.current = { x: ev.clientX, y: ev.clientY, vx: viewport.x, vy: viewport.y, moved: false };
  };
  const onPointerMove = (ev: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = ev.clientX - d.x;
    const dy = ev.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    if (!d.moved) (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
    d.moved = true;
    const u = unitsPerPixel();
    setViewport((vp) => ({ ...vp, x: d.vx + dx * u, y: d.vy + dy * u }));
  };
  const endDrag = () => {
    suppressClick.current = drag.current?.moved ?? false;
    drag.current = null;
    setTimeout(() => (suppressClick.current = false), 0);
  };

  const pick = (key: string, how: "one" | "toggle" | "range") => {
    setFocused(key);
    const tabs = useTabs.getState();
    if (how === "one") tabs.select(key);
    else tabs.mark(key, how, order);
  };

  const onNode = (key: string, ev: MouseEvent) => {
    if (suppressClick.current) return;
    pick(key, ev.shiftKey ? "range" : ev.metaKey || ev.ctrlKey ? "toggle" : "one");
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.target !== ev.currentTarget) return;
    const dir = ARROWS[ev.key];
    if (dir) {
      ev.preventDefault();
      const next = neighbour(layout.nodes, focused ?? selected ?? "", dir);
      if (next) {
        setFocused(next);
      }
    } else if ((ev.key === "Enter" || ev.key === " ") && focused) {
      ev.preventDefault();
      pick(focused, ev.shiftKey ? "range" : ev.metaKey || ev.ctrlKey ? "toggle" : "one");
    } else if (ev.key === "+" || ev.key === "=") zoomBy(1.25);
    else if (ev.key === "-") zoomBy(0.8);
    else if (ev.key === "0") setViewport(FIT);
    else if (ev.key === "Escape" && cards.bulk.marked.length) useTabs.getState().clearMarks();
  };

  const btn = "grid h-8 min-w-8 place-items-center rounded-lg border border-ws-sep2 bg-ws-win text-ws-ink2 hover:bg-ws-hover";

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 px-6 pb-2">
        <MapKey />
        <div className="ml-auto">
          <CapNotice shown={layout.shown} total={layout.total} />
        </div>
      </div>
      <div
        ref={box}
        tabIndex={0}
        role="application"
        aria-activedescendant={focused ? nodeId(focused) : undefined}
        aria-label="Map of tickets. Arrow keys move between tickets, Enter opens one, plus and minus zoom, zero fits the view."
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(focused ?? selected ?? layout.nodes[0]?.key ?? null)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="relative mx-6 mb-2 min-h-0 flex-1 cursor-grab touch-none overflow-hidden rounded-2xl border border-ws-sep bg-ws-bar focus-visible:outline-2 focus-visible:outline-ws-pip active:cursor-grabbing"
      >
        <MapSvg
          layout={layout}
          viewport={viewport}
          selected={selected}
          marked={cards.bulk.marked}
          focused={focused}
          hovered={hovered}
          blocked={cards.blocked}
          needsMe={cards.attention.needsMe}
          now={cards.now}
          drafts={cards.counts}
          onNode={onNode}
          onHover={setHovered}
          onCluster={(key) => useTabs.getState().select(key)}
        />
        <div className="absolute top-3 right-3 flex gap-1.5" onPointerDown={(ev) => ev.stopPropagation()}>
          <button type="button" aria-label="Zoom out" className={btn} onClick={() => zoomBy(0.8)}>
            −
          </button>
          <button type="button" aria-label="Zoom in" className={btn} onClick={() => zoomBy(1.25)}>
            +
          </button>
          <button type="button" className={`${btn} px-3 text-sm whitespace-nowrap`} onClick={() => setViewport(FIT)}>
            Fit view
          </button>
        </div>
      </div>
      <CanvasFooter cards={cards} view="map" />
    </div>
  );
}
