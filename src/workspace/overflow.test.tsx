import { describe, expect, it } from "vitest";
import { CANVAS_MIN, RAIL_WIDTH, fitPanes } from "./paneSizes";
import boardView from "./BoardView.tsx?raw";
import itemCard from "./ItemCard.tsx?raw";

describe("nothing is wider than its pane", () => {
  it("wraps long words in card titles and lets board columns shrink", () => {
    expect(itemCard).toContain('className="my-1 font-medium [overflow-wrap:anywhere]"');
    expect(boardView).toContain("flex min-h-0 min-w-0 flex-col gap-2 rounded-xl");
  });

  it("keeps the canvas at its minimum wherever the panes can fit", () => {
    for (let width = 1000; width <= 3440; width += 40) {
      const f = fitPanes(width, 10_000, 10_000, true);
      expect(width - RAIL_WIDTH - f.pip).toBeGreaterThanOrEqual(CANVAS_MIN);
      expect(f.pip).toBeLessThanOrEqual(640);
    }
  });
});
