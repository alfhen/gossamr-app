import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { footerHints } from "../lib/keys";
import { RANK_CLASS } from "./footerHints";
import { launcherStyle } from "./PipExtras";
import { ShortcutHint } from "./ShortcutHint";

describe("canvas footer hints", () => {
  it("keeps j/k first to go away last, and names only keys the table has", () => {
    for (const on of ["canvas", "work"] as const) {
      const hints = footerHints(on);
      expect(hints[0].rank).toBe(0);
      expect(hints.every((h) => h.rank in RANK_CLASS)).toBe(true);
    }
    expect(footerHints("canvas")[0]).toMatchObject({ keys: ["j", "k"], text: "move and peek" });
  });

  it("renders one left-aligned truncating line, hiding lower ranks at narrow widths, and no teaching", () => {
    const out = renderToStaticMarkup(<ShortcutHint on="canvas" />);
    expect(out).toContain("truncate");
    expect(out).not.toContain("text-center");
    expect(out).not.toContain("Drag a card");
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
