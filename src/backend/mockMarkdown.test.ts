import { describe, expect, it } from "vitest";
import { bodyChange, docFromMarkdown, markdownOf } from "./mockMarkdown";

describe("the sample build's Markdown", () => {
  it("reads headings, lists and paragraphs and writes them back", () => {
    const text = "Intro line\nsecond line\n\n## Scope\n\n- in\n- out\n\n1. first\n2. second";
    const doc = docFromMarkdown(text);
    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "list", "list"]);
    expect(markdownOf(doc)).toBe(text);
  });

  it("starts a list right after a paragraph line and ends it at the next paragraph", () => {
    const doc = docFromMarkdown("Steps:\n- a\n- b\nAfter");
    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "list", "paragraph"]);
  });

  it("makes a body change with both documents and their text", () => {
    const from = docFromMarkdown("old");
    const change = bodyChange(from, " ## New \n- a");
    expect(change.from).toBe(from);
    expect([change.fromText, change.toText]).toEqual(["old", "## New\n\n- a"]);
  });
});
