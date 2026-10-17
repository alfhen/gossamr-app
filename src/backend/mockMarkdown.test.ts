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

  it("keeps a code block whole: lines inside it that look like headings or list items stay code", () => {
    const text = "Before\n\n```sh\n# not a heading\n- not a list\n\nls\n```\n\nAfter";
    const doc = docFromMarkdown(text);
    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "code", "paragraph"]);
    expect(doc.blocks[1]).toEqual({ type: "code", language: "sh", text: "# not a heading\n- not a list\n\nls" });
    expect(markdownOf(doc)).toBe(text);
    expect(docFromMarkdown(markdownOf(doc))).toEqual(doc);
  });

  it("closes a fence by the same rules as the backend: same mark, long enough, at most three columns in", () => {
    const code = (text: string) => docFromMarkdown(text).blocks;
    expect(code("~~~\n    ~~~\nstill code\n~~~\nafter")).toEqual([{ type: "code", language: null, text: "    ~~~\nstill code" }, expect.objectContaining({ type: "paragraph" })]);
    for (const lead of ["\t", " \t", "  \t", "\t\t"]) expect(code(`\`\`\`\n${lead}\`\`\`\nstill code\n\`\`\``)[0], JSON.stringify(lead)).toEqual({ type: "code", language: null, text: `${lead}\`\`\`\nstill code` });
    expect(code("```\ncode\n   ```\nafter")).toHaveLength(2);
    expect(code("```\n~~~\n```")).toEqual([{ type: "code", language: null, text: "~~~" }]);
    expect(code("````\n```\n````")).toEqual([{ type: "code", language: null, text: "```" }]);
    expect(code("```\nnever closed\n# still code")).toEqual([{ type: "code", language: null, text: "never closed\n# still code" }]);
  });

  it("opens a fence only within three columns and, for backticks, without a backtick in the info string", () => {
    const kinds = (text: string) => docFromMarkdown(text).blocks.map((b) => b.type);
    expect(kinds("    ```\nnot code\n    ```")).toEqual(["paragraph"]);
    expect(kinds("\t~~~\nnot code")).toEqual(["paragraph"]);
    expect(kinds("```a`b\nnot code")).toEqual(["paragraph"]);
    expect(docFromMarkdown("~~~a`b\ncode\n~~~").blocks).toEqual([{ type: "code", language: "a`b", text: "code" }]);
    expect(docFromMarkdown("   ```rust\ncode\n```").blocks).toEqual([{ type: "code", language: "rust", text: "code" }]);
    expect(markdownOf({ blocks: [{ type: "code", language: "a`b", text: "x" }] })).toBe("```\nx\n```");
  });

  it("writes a longer fence around code that holds backtick lines, so they come back as code", () => {
    for (const text of ["  ```", "    `````", "a\n  ````\nb", "~~~"]) {
      const doc = { blocks: [{ type: "code" as const, language: null, text }] };
      expect(docFromMarkdown(markdownOf(doc)), JSON.stringify(text)).toEqual(doc);
    }
  });

  it("makes a body change with both documents and their text", () => {
    const from = docFromMarkdown("old");
    const change = bodyChange(from, " ## New \n- a");
    expect(change.from).toBe(from);
    expect([change.fromText, change.toText]).toEqual(["old", "## New\n\n- a"]);
  });
});

describe("collapsible sections", () => {
  const text = "Intro\n\n<details>\n<summary>Gossamr Plan</summary>\n\n## Steps\n\n- one\n\n```\n</details>\n```\n\n<details>\n<summary>Inner &amp; more</summary>\n\ndeep\n\n</details>\n\n</details>\n\nAfter";

  it("reads <details> into an expand, keeps nesting and fenced tags, and writes the same text back", () => {
    const doc = docFromMarkdown(text);
    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "expand", "paragraph"]);
    const expand = doc.blocks[1];
    if (expand.type !== "expand") throw new Error("expand expected");
    expect(expand.title).toBe("Gossamr Plan");
    expect(expand.content.map((b) => b.type)).toEqual(["heading", "list", "code", "expand"]);
    expect(markdownOf(doc)).toBe(text);
  });

  it("shows an expand's lines in a description change", () => {
    const change = bodyChange(docFromMarkdown(text), text.replace("deep", "deeper"));
    expect(change.fromText).toContain("<summary>Gossamr Plan</summary>");
    expect(change.toText).toContain("deeper");
  });
});
