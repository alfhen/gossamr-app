import { describe, expect, it } from "vitest";
import type { DiffSide } from "../types";
import fixtures from "./diffHunks.fixtures.json";
import { commentable, hunkAround, parsePatch, parseWhere } from "./diffHunks";

const patches = fixtures.patches as Record<string, string>;

describe("diff hunks, on the fixtures the Rust side also runs", () => {
  it.each(fixtures.parse)("parses the $patch patch", (c) => {
    const got = parsePatch(patches[c.patch]).map((h) => ({ leftStart: h.leftStart, leftLines: h.leftLines, rightStart: h.rightStart, rightLines: h.rightLines, lines: h.lines.map((l) => [l.kind, l.left, l.right]) }));
    expect(got).toEqual(c.hunks);
  });

  it.each(fixtures.commentable)("commentable: $name", (c) => {
    expect(commentable(patches[c.patch], c.line, c.side as DiffSide)).toBe(c.expect);
  });

  it.each(fixtures.hunkAround)("hunk around: $name", (c) => {
    expect(hunkAround(patches[c.patch], c.line, c.side as DiffSide, c.context)).toBe(c.expect);
  });

  it.each(fixtures.where)("where: $text", (c) => {
    expect(parseWhere(c.text)).toEqual(c.expect);
  });

  it("keeps the hunk's own lines when the patch is cut short", () => {
    const [cut] = parsePatch(patches.cut);
    expect([cut.rightLines, cut.lines.length]).toEqual([8, 3]);
  });
});
