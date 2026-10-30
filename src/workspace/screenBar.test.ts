import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./glass.css", import.meta.url), "utf8");
const block = (selector: string) => css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));

describe("the screen bar's css", () => {
  it("is solid at rest and blurs only its controls once content is under it", () => {
    expect(block(".ws-bar {")).toContain("background: var(--color-ws-win)");
    expect(block(".ws-bar[data-under] :is(")).toContain("backdrop-filter: var(--glass-filter)");
    expect(block(".ws-bar[data-under] {")).not.toContain("backdrop-filter");
  });

  it("stays solid and unblurred under reduced transparency", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-transparency: reduce) {\n    .ws-bar[data-under] {"));
    expect(reduced).toContain("--glass-filter: none");
    expect(reduced).toContain("background: var(--color-ws-win)");
    expect(css).toContain(':root[data-transparency="reduce"] .ws-bar[data-under] {');
  });
});
