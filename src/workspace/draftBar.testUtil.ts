import { expect } from "vitest";

/** The static markup of a draft card's action bar, and whatever the card renders after it. */
export function actionBarOf(html: string): { bar: string; after: string } {
  const start = html.lastIndexOf("<div data-draft-actions");
  if (start < 0) return { bar: "", after: html };
  let depth = 0;
  const tag = /<(\/?)div\b[^>]*>/g;
  tag.lastIndex = start;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { bar: html.slice(start, tag.lastIndex), after: html.slice(tag.lastIndex) };
  }
  return { bar: html.slice(start), after: "" };
}

/** The bar is pinned to the bottom of its card, opaque, with a rule above it, and nothing of the card comes after it. */
export function expectPinnedBar(html: string) {
  const { bar, after } = actionBarOf(html);
  const open = bar.slice(0, bar.indexOf(">") + 1);
  for (const cls of ["sticky", "bottom-0", "bg-ws-win", "border-t"]) expect(open).toMatch(new RegExp(`class="[^"]*(?<![\\w-])${cls}(?![\\w-])`));
  // Only the closing tags of the card's body and the card itself follow the bar.
  expect(after).toBe("</div></article>");
}
