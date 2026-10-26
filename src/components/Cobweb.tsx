import { useEffect, useRef, useState } from "react";
import type { WitherLevel } from "../lib/views";

const SIZE = 40;
const SPOKES = [0, 22, 45, 68, 90];
/** Each move with how long its animation runs, in ms. */
const MOVES = [
  ["drop", 2400],
  ["climb", 2000],
  ["swing", 2200],
  ["turn", 1600],
  ["twitch", 700],
] as const;
type Move = (typeof MOVES)[number][0];
const PAUSE_MS: [number, number] = [5000, 18000];
/** How often a spider walks to another spot rather than making one of the moves above. */
const CRAWL_CHANCE = 0.45;
/** Matches the lift transition in index.css. */
const LIFT_MS = 500;
const MS_PER_UNIT = 150;

/** A point `r` from the top-right corner, `deg` degrees from the top edge towards the right edge. */
function at(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [SIZE - r * Math.cos(a), r * Math.sin(a)];
}

/** Rings sag a little towards the corner between spokes, like silk under its own weight. */
function ring(r: number): string {
  const [x0, y0] = at(r, SPOKES[0]);
  let d = `M${x0.toFixed(1)} ${y0.toFixed(1)}`;
  for (let i = 1; i < SPOKES.length; i++) {
    const [cx, cy] = at(r * 0.8, (SPOKES[i - 1] + SPOKES[i]) / 2);
    const [x, y] = at(r, SPOKES[i]);
    d += ` Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

const WEB = {
  2: { reach: 26, rings: [8, 15, 22], px: 34 },
  3: { reach: 38, rings: [8, 15, 23, 31], px: 44 },
} as const;

interface Perch {
  at: [number, number];
  /** Perches one silk line away: the next spoke on the same ring, or the next ring on the same spoke. */
  next: number[];
}

/**
 * Where spokes cross rings on the big web, keeping only spots a spider can hang from without its thread and body
 * leaving the web's box.
 */
const PERCHES: Perch[] = (() => {
  const spots = WEB[3].rings.slice(1).flatMap((r, ri) =>
    SPOKES.map((deg, si) => ({ ri, si, at: at(r, deg) })).filter(({ at: [x, y] }) => x >= 5 && x <= 36 && y <= 22),
  );
  return spots.map((p) => ({
    at: p.at,
    next: spots.flatMap((q, i) =>
      (q.ri === p.ri && Math.abs(q.si - p.si) === 1) || (q.si === p.si && Math.abs(q.ri - p.ri) === 1) ? [i] : [],
    ),
  }));
})();

const between = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

/**
 * A spider that starts on a random free perch and, after each random pause, either walks along the silk to a
 * neighbouring perch or makes one of the small moves in place. `taken` is shared by the web's spiders so they never
 * sit on the same perch. It holds still when reduced motion is asked for or the window is hidden.
 */
function Spider({ taken }: { taken: Set<number> }) {
  const [home] = useState(() => {
    const free = PERCHES.map((_, i) => i).filter((i) => !taken.has(i));
    const start = pick(free.length ? free : PERCHES.map((_, i) => i));
    taken.add(start);
    return start;
  });
  const [perch, setPerch] = useState(home);
  const [move, setMove] = useState<Move | null>(null);
  const [lifted, setLifted] = useState(false);
  const [facing, setFacing] = useState(0);
  const [travelMs, setTravelMs] = useState(0);
  const here = useRef(home);

  useEffect(() => {
    taken.add(here.current);
    let timer = 0;
    const after = (ms: number, then: () => void) => {
      timer = window.setTimeout(then, ms);
    };
    const rest = () => after(between(PAUSE_MS), act);

    const crawl = () => {
      const from = PERCHES[here.current];
      const options = from.next.filter((i) => !taken.has(i));
      if (!options.length) return rest();
      const to = pick(options);
      const [[x0, y0], [x1, y1]] = [from.at, PERCHES[to].at];
      const ms = Math.max(900, Math.hypot(x1 - x0, y1 - y0) * MS_PER_UNIT);
      taken.delete(here.current);
      taken.add(to);
      here.current = to;
      setLifted(true);
      after(LIFT_MS, () => {
        // The body is drawn head up, so it turns by the heading plus a quarter turn.
        setFacing((Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI + 90);
        setTravelMs(ms);
        setPerch(to);
        after(ms, () => {
          setFacing(0);
          setLifted(false);
          after(LIFT_MS, rest);
        });
      });
    };

    const act = () => {
      if (document.hidden) return after(PAUSE_MS[0], act);
      if (Math.random() < CRAWL_CHANCE) return crawl();
      const [next, runs] = pick(MOVES);
      setMove(next);
      after(runs, () => {
        setMove(null);
        rest();
      });
    };

    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) after(between([1500, PAUSE_MS[1]]), act);
    return () => {
      window.clearTimeout(timer);
      taken.delete(here.current);
    };
  }, [taken]);

  const [x, y] = PERCHES[perch].at;
  return (
    <g style={{ transform: `translate(${x}px, ${y}px)`, transition: `transform ${travelMs}ms ease-in-out` }}>
      <g className={`spider-rig ${move ? `move-${move}` : ""} ${lifted ? "lifted" : ""}`}>
        <line className="spider-thread" x1={0} y1={0} x2={0} y2={9} stroke="currentColor" strokeWidth={0.55} />
        <g className="spider-lift">
          <g transform="translate(0 11.5) scale(1.25)" fill="var(--color-ink-2)" stroke="var(--color-ink-2)">
            <g className="spider">
              <g className="spider-face" style={{ transform: `rotate(${facing}deg)` }}>
                <g className="spider-legs" strokeWidth={0.55} strokeLinecap="round" fill="none">
                  <path d="M-1 -.5 L-3.4 -2.6 M-1 0 L-3.8 -.3 M-1 .5 L-3.6 2 M-.8 1 L-2.8 3.6" />
                  <path d="M1 -.5 L3.4 -2.6 M1 0 L3.8 -.3 M1 .5 L3.6 2 M.8 1 L2.8 3.6" />
                </g>
                <circle cy={-1.9} r={1} />
                <ellipse cy={0.6} rx={1.5} ry={1.9} />
              </g>
            </g>
          </g>
        </g>
      </g>
    </g>
  );
}

/** A web in the row's top-right corner from withering level 2, growing at level 3, with a spider more per level from there. */
export function Cobweb({ level }: { level: WitherLevel }) {
  const taken = useRef(new Set<number>()).current;
  if (level < 2) return null;
  const web = WEB[level === 2 ? 2 : 3];
  return (
    <svg aria-hidden viewBox={`0 0 ${SIZE} ${SIZE}`} width={web.px} height={web.px} className="cobweb">
      <g fill="none" stroke="currentColor" strokeWidth={0.7} strokeLinecap="round">
        {SPOKES.map((deg) => {
          const [x, y] = at(web.reach, deg);
          return <line key={deg} x1={SIZE} y1={0} x2={x.toFixed(1)} y2={y.toFixed(1)} />;
        })}
        {web.rings.map((r) => (
          <path key={r} d={ring(r)} />
        ))}
      </g>
      {Array.from({ length: Math.max(0, level - 2) }, (_, i) => (
        <Spider key={i} taken={taken} />
      ))}
    </svg>
  );
}
