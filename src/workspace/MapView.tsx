import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { summaryLine, type CodeSummary } from "../lib/devLinks";
import { useWorkspace } from "../workspaceStore";
import { daysQuiet } from "./boardLogic";
import { ageLevel, statusTone, type StatusTone } from "./canvasShared";
import { CanvasFooter } from "./CanvasFooter";
import type { CanvasProps } from "./canvases";
import { FIT, layoutMap, mapZoomKey, neighbour, placeKeyLabels, shownKey, textWidth, zoomAt, type Direction, type MapCluster, type MapEdge, type MapLayout, type Viewport } from "./mapLayout";
import { useTabs } from "./tabsStore";
import { useCards } from "./useCards";

const PR_FILL = { open: "fill-ws-done", draft: "fill-ws-ink3", merged: "fill-ws-review", closed: "fill-ws-ink3 opacity-60" } as const;
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
  /** What the code linked to each ticket adds up to, once read; a pull request marks the node's lower corner. */
  code?: ReadonlyMap<string, CodeSummary>;
  /** Screen pixels per map unit at zoom 1; ticket keys appear once zoom makes them readable. */
  scale?: number;
  hoveredCluster?: string | null;
  onNode(key: string, ev: MouseEvent): void;
  onHover(key: string | null): void;
  onHoverCluster?(key: string | null): void;
  onCluster(parentKey: string): void;
}

const KEYS_FROM = 0.85;
const ASPECTS = [1, 1.4, 1.8, 2.3, 3];

/** The layout's target shape for a pane of this size, snapped so a small resize does not reshuffle the map. */
const aspectBucket = (w: number, h: number) => (w && h ? ASPECTS.reduce((best, a) => (Math.abs(Math.log(a / (w / h))) < Math.abs(Math.log(best / (w / h))) ? a : best)) : 1.8);
const VIEW_PAD = 24;
const TITLE_LEADING = 15;
const clusterText = (c: MapCluster) => `${c.label} (${c.sub})`;

function ClusterTip({ cluster }: { cluster: MapCluster }) {
  const text = cluster.label.length > 90 ? `${cluster.label.slice(0, 89)}…` : cluster.label;
  const w = Math.max(textWidth(text, 12) + 20, 80);
  const y = cluster.box.y - 34;
  return (
    <g pointerEvents="none" data-cluster-tip>
      <rect x={cluster.x - w / 2} y={y} width={w} height={24} rx={6} className="fill-ws-win stroke-ws-sep2" />
      <text x={cluster.x} y={y + 16} textAnchor="middle" className="fill-ws-ink text-[12px] font-semibold">
        {text}
      </text>
    </g>
  );
}

const touches = (e: MapEdge, key: string | null) => key !== null && (e.from === key || e.to === key);

/** The map itself, with no state of its own: the same props always draw the same picture. */
export function MapSvg({ layout, viewport, selected, marked, focused, hovered, blocked, needsMe, now, drafts, code, scale = 1, hoveredCluster = null, onNode, onHover, onHoverCluster, onCluster }: MapSvgProps) {
  const active = hovered ?? focused;
  const clusters = new Map(layout.clusters.map((c) => [c.key, c]));
  const near = new Set(layout.edges.filter((e) => touches(e, active)).flatMap((e) => [e.from, e.to]));
  const clusterOf = new Map(layout.nodes.map((n) => [n.key, n.cluster]));
  const readable = scale * viewport.k >= KEYS_FROM;
  const priority = [active, selected, ...layout.nodes.filter((n) => needsMe.has(n.key)).map((n) => n.key), ...layout.nodes.filter((n) => blocked.has(n.key)).map((n) => n.key), ...marked].filter((k): k is string => k !== null);
  const keyLabels = placeKeyLabels(layout.nodes, readable ? [...priority, ...layout.nodes.map((n) => n.key)] : priority, new Set([active, selected, ...marked].filter((k): k is string => k !== null)));
  const tipNode = active ? layout.nodes.find((n) => n.key === active) : undefined;
  const tipCluster = hoveredCluster ? clusters.get(hoveredCluster) : undefined;
  return (
    <svg viewBox={`${-VIEW_PAD} ${-VIEW_PAD} ${layout.width + 2 * VIEW_PAD} ${layout.height + 2 * VIEW_PAD}`} role="presentation" className="h-full w-full select-none">
      <defs>
        <marker id="map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L8 4L0 8z" className="fill-ws-blocked" />
        </marker>
      </defs>
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.k})`}>
        {layout.clusters.map((c) => (
          <g key={c.key} data-cluster={c.key}>
            <circle cx={c.x} cy={c.y} r={c.r} className="fill-ws-accent-soft stroke-ws-sep2" strokeDasharray="4 5" fillOpacity={0.5} />
            <g
              data-cluster-label
              tabIndex={c.parentKey ? 0 : undefined}
              role={c.parentKey ? "button" : undefined}
              aria-label={c.parentKey ? `Open ${clusterText(c)}` : undefined}
              className={`outline-none focus-visible:[&_text]:fill-ws-pip ${c.parentKey ? "cursor-pointer" : ""}`}
              onClick={c.parentKey ? () => onCluster(c.parentKey!) : undefined}
              onKeyDown={c.parentKey ? (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), ev.stopPropagation(), onCluster(c.parentKey!)) : undefined}
              onPointerEnter={() => onHoverCluster?.(c.key)}
              onPointerLeave={() => onHoverCluster?.(null)}
              onFocus={() => onHoverCluster?.(c.key)}
              onBlur={() => onHoverCluster?.(null)}
            >
              <title>{clusterText(c)}</title>
              <rect x={c.box.x} y={c.box.y} width={c.box.w} height={c.box.h + 4} fill="transparent" />
              {c.box.lines.map((line, i) => (
                <text
                  key={i}
                  x={c.x}
                  y={c.y - c.r - 24 - (c.box.lines.length - 1 - i) * TITLE_LEADING}
                  textAnchor="middle"
                  className={`fill-ws-ink2 text-[13px] font-bold ${c.parentKey ? "hover:fill-ws-ink" : ""}`}
                >
                  {line}
                </text>
              ))}
              <text x={c.x} y={c.y - c.r - 9} textAnchor="middle" className="fill-ws-ink3 text-[10px]">
                {c.box.sub}
              </text>
            </g>
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
              opacity={active === null ? (clusterOf.get(e.from) === clusterOf.get(e.to) ? 0.7 : 0.4) : lit ? 1 : 0.12}
              className={blocks ? "stroke-ws-blocked" : "stroke-ws-ink3"}
            />
          );
        })}
        {layout.nodes.map((n) => {
          const isSelected = selected === n.key;
          const isMarked = marked.includes(n.key);
          const isBlocked = blocked.has(n.key);
          const dim = active !== null && !near.has(n.key) && active !== n.key;
          const keyLabel = keyLabels.get(n.key);
          const cluster = clusters.get(n.cluster);
          const tone = statusTone(n.item.status);
          const days = daysQuiet(n.item, now);
          const stale = tone === "done" ? 0 : ageLevel(days);
          const pulses = needsMe.has(n.key);
          const sum = code?.get(n.key);
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
              <title>{`${n.item.item.key} · ${n.item.title} · ${n.item.status.name}${sum && summaryLine(sum) ? ` · ${summaryLine(sum)}` : ""}`}</title>
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
              {sum && sum.prs > 0 && sum.state && (
                <circle
                  cx={n.x + n.r * 0.75}
                  cy={n.y + n.r * 0.75}
                  r={4.5}
                  strokeWidth={sum.failing ? 2 : 1.5}
                  strokeDasharray={sum.state === "draft" ? "2 1.5" : undefined}
                  className={`${PR_FILL[sum.state]} ${sum.failing ? "stroke-ws-blocked" : "stroke-ws-win"}`}
                  data-pr={sum.state}
                  data-checks={sum.failing ? "failing" : undefined}
                />
              )}
              {drafts[n.key] ? <circle cx={n.x + n.r * 0.75} cy={n.y - n.r * 0.75} r={4.5} strokeWidth={1.5} className="fill-ws-pip stroke-ws-win" data-draft /> : null}
              {keyLabel && (
                <text x={n.x} y={keyLabel.y + 9.5} textAnchor="middle" strokeWidth={3} paintOrder="stroke" className="fill-ws-ink2 stroke-ws-bar font-mono text-[10px] font-bold" data-key-label>
                  {n.item.item.key}
                </text>
              )}
            </g>
          );
        })}
        {tipCluster?.box.truncated && <ClusterTip cluster={tipCluster} />}
        {tipNode && (
          <g pointerEvents="none" data-tip>
            <text x={tipNode.x} y={tipNode.y - tipNode.r - 9} textAnchor="middle" strokeWidth={5} paintOrder="stroke" className="fill-ws-ink stroke-ws-win text-[11px] font-semibold">
              {tipNode.item.title.length > 48 ? `${tipNode.item.title.slice(0, 47)}…` : tipNode.item.title}
            </text>
          </g>
        )}
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
  const [size, setSize] = useState({ w: 0, h: 0 });
  const aspect = aspectBucket(size.w, size.h);
  const layout = useMemo(() => layoutMap(items, all, containers, undefined, aspect), [items, all, containers, aspect]);
  const scale = size.w && size.h ? Math.min(size.w / (layout.width + 2 * VIEW_PAD), size.h / (layout.height + 2 * VIEW_PAD)) : 1;
  const [hoveredCluster, setHoveredCluster] = useState<string | null>(null);
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

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout.nodes.length > 0]);

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
    } else if (mapZoomKey(ev) === "in") zoomBy(1.25);
    else if (mapZoomKey(ev) === "out") zoomBy(0.8);
    else if (mapZoomKey(ev) === "fit") setViewport(FIT);
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
          code={cards.code}
          scale={scale}
          hoveredCluster={hoveredCluster}
          onHoverCluster={setHoveredCluster}
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
