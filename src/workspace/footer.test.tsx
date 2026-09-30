import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { footerHints, RANK_CLASS } from "./footerHints";
import { launcherStyle } from "./PipExtras";
import { ShortcutHint } from "./ShortcutHint";
import { VIEW_MODES } from "./tabsStore";

describe("canvas footer hints", () => {
  it("keeps j/k first to go away last, and puts the canvas-specific lead first in the line", () => {
    const board = footerHints("board");
    expect(board[0].id).toBe("drag");
    expect(footerHints("list")[0].id).toBe("move");
    for (const view of VIEW_MODES) {
      const hints = footerHints(view);
      expect(hints.find((h) => h.id === "move")?.rank).toBe(0);
      expect(hints.every((h) => h.rank in RANK_CLASS)).toBe(true);
    }
  });

  it("renders one left-aligned truncating line, hiding lower ranks at narrow widths", () => {
    const out = renderToStaticMarkup(<ShortcutHint view="map" />);
    expect(out).toContain("truncate");
    expect(out).not.toContain("text-center");
    expect(out).toContain("Scroll to zoom");
    expect(out).toContain("hidden @md:inline");
    expect(out).toContain("⌘J");
  });
});

describe("launcherStyle", () => {
  it("sits above the footer and clears the peek with an inset from the edge", () => {
    expect(launcherStyle()).toEqual({ right: "calc(0px + 1.25rem)", bottom: "calc(var(--ws-footer-h, 2rem) + 0.75rem)" });
    expect(launcherStyle(520).right).toBe("calc(520px + 1.25rem)");
  });
});
