export const RAIL_WIDTH = 58;
export const CANVAS_MIN = 360;

export const PEEK_DEFAULT = 520;
export const PEEK_MIN = 320;
export const PIP_DEFAULT = 380;
export const PIP_MIN = 300;
export const PIP_MAX = 640;

export const STEP = 16;
export const BIG_STEP = 64;

export interface Limits {
  min: number;
  max: number;
}

export function clampWidth(value: number, { min, max }: Limits): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}

export function pipLimits(windowWidth: number): Limits {
  return { min: PIP_MIN, max: Math.min(PIP_MAX, windowWidth - RAIL_WIDTH - CANVAS_MIN) };
}

/** The peek overlays the canvas, so it is bounded by what is left after the rail and the Pip pane. */
export function peekLimits(windowWidth: number, pipWidth: number): Limits {
  return { min: PEEK_MIN, max: Math.min(windowWidth * 0.7, windowWidth - RAIL_WIDTH - pipWidth - CANVAS_MIN) };
}

export interface PaneWidths {
  peek: number;
  pip: number;
  peekLimits: Limits;
  pipLimits: Limits;
}

export function fitPanes(windowWidth: number, peek: number, pip: number, pipOpen: boolean): PaneWidths {
  const pl = pipLimits(windowWidth);
  const fittedPip = pipOpen ? clampWidth(pip, pl) : 0;
  const kl = peekLimits(windowWidth, fittedPip);
  return { peek: clampWidth(peek, kl), pip: clampWidth(pip, pl), peekLimits: kl, pipLimits: pl };
}

/** Both panes grow leftwards, so ArrowLeft widens and ArrowRight narrows. */
export function keyboardWidth(key: string, shift: boolean, current: number, limits: Limits, fallback: number): number | null {
  const step = shift ? BIG_STEP : STEP;
  switch (key) {
    case "ArrowLeft":
      return clampWidth(current + step, limits);
    case "ArrowRight":
      return clampWidth(current - step, limits);
    case "Home":
      return limits.min;
    case "End":
      return clampWidth(limits.max, limits);
    case "Enter":
      return clampWidth(fallback, limits);
    default:
      return null;
  }
}

export function dragWidth(startWidth: number, startX: number, x: number, limits: Limits): number {
  return clampWidth(startWidth + (startX - x), limits);
}

export function storedWidth(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 200 && value <= 4000 ? Math.round(value) : fallback;
}
