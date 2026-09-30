import { describe, expect, it } from "vitest";
import { CANVAS_MIN, PEEK_DEFAULT, PIP_DEFAULT, RAIL_WIDTH, clampWidth, dragWidth, fitPanes, keyboardWidth, peekLimits, pipLimits, storedWidth } from "./paneSizes";

const L = { min: 320, max: 800 };

describe("clampWidth", () => {
  it("bounds and rounds", () => {
    expect(clampWidth(100, L)).toBe(320);
    expect(clampWidth(900, L)).toBe(800);
    expect(clampWidth(400.6, L)).toBe(401);
  });
  it("lets min win when the window is too small for max", () => {
    expect(clampWidth(500, { min: 320, max: 200 })).toBe(320);
  });
});

describe("limits", () => {
  it("caps Pip at 640 on wide windows and keeps the canvas on narrow ones", () => {
    expect(pipLimits(2000)).toEqual({ min: 300, max: 640 });
    expect(pipLimits(900).max).toBe(900 - RAIL_WIDTH - CANVAS_MIN);
  });
  it("caps peek at 70 percent or what the canvas leaves", () => {
    expect(peekLimits(2000, 0).max).toBe(1400);
    expect(peekLimits(1000, 0).max).toBe(1000 - RAIL_WIDTH - CANVAS_MIN);
    expect(peekLimits(1000, 380).max).toBe(1000 - RAIL_WIDTH - 380 - CANVAS_MIN);
  });
});

describe("fitPanes", () => {
  it("keeps the defaults in a roomy window", () => {
    const f = fitPanes(1600, PEEK_DEFAULT, PIP_DEFAULT, true);
    expect([f.peek, f.pip]).toEqual([PEEK_DEFAULT, PIP_DEFAULT]);
  });
  it("re-clamps when the window shrinks, never starving the canvas", () => {
    const f = fitPanes(1000, 700, 600, true);
    expect(1000 - RAIL_WIDTH - f.pip).toBeGreaterThanOrEqual(CANVAS_MIN);
    expect(f.pip).toBe(1000 - RAIL_WIDTH - CANVAS_MIN);
    expect(f.peek).toBe(320);
  });
  it("leaves room for the peek minimum when it is open", () => {
    const f = fitPanes(1280, 520, 640, true, true);
    expect(f.pip).toBe(1280 - RAIL_WIDTH - CANVAS_MIN - 320);
    expect(f.peek).toBe(f.peekLimits.max);
    expect(1280 - RAIL_WIDTH - f.pip - f.peek).toBeGreaterThanOrEqual(CANVAS_MIN);
  });
  it("ignores Pip width when the pane is closed", () => {
    expect(fitPanes(1000, 900, 600, false).peek).toBe(1000 - RAIL_WIDTH - CANVAS_MIN);
  });
});

describe("keyboardWidth", () => {
  it("grows leftwards in 16px steps, 64 with shift", () => {
    expect(keyboardWidth("ArrowLeft", false, 400, L, 520)).toBe(416);
    expect(keyboardWidth("ArrowRight", false, 400, L, 520)).toBe(384);
    expect(keyboardWidth("ArrowLeft", true, 400, L, 520)).toBe(464);
  });
  it("clamps at the limits", () => {
    expect(keyboardWidth("ArrowRight", true, 330, L, 520)).toBe(320);
    expect(keyboardWidth("ArrowLeft", true, 790, L, 520)).toBe(800);
  });
  it("jumps with Home and End and resets with Enter", () => {
    expect(keyboardWidth("Home", false, 500, L, 520)).toBe(320);
    expect(keyboardWidth("End", false, 500, L, 520)).toBe(800);
    expect(keyboardWidth("Enter", false, 500, L, 520)).toBe(520);
    expect(keyboardWidth("Enter", false, 500, { min: 320, max: 450 }, 520)).toBe(520);
  });
  it("ignores other keys", () => {
    expect(keyboardWidth("a", false, 500, L, 520)).toBeNull();
  });
});

describe("dragWidth", () => {
  it("dragging left widens", () => {
    expect(dragWidth(400, 1000, 950, L)).toBe(450);
    expect(dragWidth(400, 1000, 1100, L)).toBe(320);
    expect(dragWidth(400, 1000, 0, L)).toBe(800);
  });
});

describe("storedWidth", () => {
  it("falls back on anything unusable", () => {
    expect(storedWidth(undefined, 380)).toBe(380);
    expect(storedWidth("500", 380)).toBe(380);
    expect(storedWidth(NaN, 380)).toBe(380);
    expect(storedWidth(5, 380)).toBe(380);
    expect(storedWidth(455.4, 380)).toBe(455);
  });
});
