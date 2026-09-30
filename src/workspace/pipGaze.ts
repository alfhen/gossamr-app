export interface Point {
  x: number;
  y: number;
}

const PUPIL_TRAVEL = 1.5;
const FULL_TILT_DISTANCE = 60;

/** How far a pupil sits off-centre when `target` is where the eye looks from `eye`: it leans further the farther away the target is, up to a limit. */
export function pupilOffset(eye: Point, target: Point): Point {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const distance = Math.hypot(dx, dy) || 1;
  const lean = Math.min(PUPIL_TRAVEL, distance / FULL_TILT_DISTANCE);
  return { x: (dx / distance) * lean, y: (dy / distance) * lean };
}

type Listener = (target: Point) => void;

const listeners = new Set<Listener>();
let target: Point | null = null;
let frame = 0;

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const centre = (el: Element): Point => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

function aim(next: Point) {
  target = next;
  if (frame || reducedMotion() || document.hidden) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (target) listeners.forEach((l) => l(target!));
  });
}

const onMove = (ev: MouseEvent) => aim({ x: ev.clientX, y: ev.clientY });
const onFocus = (ev: FocusEvent) => {
  if (ev.target instanceof Element && !ev.target.closest("[data-pip-avatar]")) aim(centre(ev.target));
};

/** Points every avatar's eyes at `el`, for example the nudge that just appeared; the next mouse move or focus change takes over. */
export function lookAt(el: Element | null) {
  if (el) aim(centre(el));
}

/** Calls `cb` with where the eyes should look as the pointer moves or focus changes; the page listeners exist only while someone watches. */
export function watchGaze(cb: Listener): () => void {
  if (!listeners.size) {
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("focusin", onFocus);
  }
  listeners.add(cb);
  if (target && !reducedMotion()) cb(target);
  return () => {
    listeners.delete(cb);
    if (!listeners.size) {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("focusin", onFocus);
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}
