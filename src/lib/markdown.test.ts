import { describe, expect, it } from "vitest";
import { cells, parseBlocks, parseInline } from "./markdown";

describe("parseBlocks", () => {
  it("reads a table right after a paragraph, with code spans and escaped pipes in cells", () => {
    const text = [
      "Only one of the follow-ups has a ticket.",
      "| Follow-up | Ticket |",
      "|---|:--:|",
      "| Bound the `a|b` client | **DEVOPS-491** |",
      "| Bulkhead \\| queues | None |",
    ].join("\n");
    expect(parseBlocks(text)).toEqual([
      { type: "paragraph", text: "Only one of the follow-ups has a ticket." },
      {
        type: "table",
        align: [null, "center"],
        head: ["Follow-up", "Ticket"],
        rows: [
          ["Bound the `a|b` client", "**DEVOPS-491**"],
          ["Bulkhead | queues", "None"],
        ],
      },
    ]);
  });

  it("pads short rows so every row has a cell per column", () => {
    const [table] = parseBlocks("| a | b |\n|---|---|\n| only |");
    expect(table).toMatchObject({ rows: [["only", ""]] });
  });

  it("reads headings, rules, quotes and fenced code", () => {
    expect(parseBlocks("## Plan\n\n---\n\n> careful\n\n```ts\nconst x = 1;\n```")).toEqual([
      { type: "heading", level: 2, text: "Plan" },
      { type: "rule" },
      { type: "quote", blocks: [{ type: "paragraph", text: "careful" }] },
      { type: "code", lang: "ts", text: "const x = 1;" },
    ]);
  });

  it("keeps an unclosed fence as code, as a reply looks while it streams", () => {
    expect(parseBlocks("```\nline one\nline two")).toEqual([{ type: "code", lang: "", text: "line one\nline two" }]);
  });

  it("nests indented lists and keeps an ordered list's start", () => {
    const [list] = parseBlocks("3. First\n   - inner a\n   - inner b\n4. Second\n   more of second");
    expect(list).toEqual({
      type: "list",
      ordered: true,
      start: 3,
      items: [
        [
          { type: "paragraph", text: "First" },
          {
            type: "list",
            ordered: false,
            start: 1,
            items: [[{ type: "paragraph", text: "inner a" }], [{ type: "paragraph", text: "inner b" }]],
          },
        ],
        [{ type: "paragraph", text: "Second\nmore of second" }],
      ],
    });
  });

  it("keeps a list going across blank lines between items, and ends it at an unindented paragraph", () => {
    const blocks = parseBlocks("- one\n\n- two\n\nAfter");
    expect(blocks.map((b) => b.type)).toEqual(["list", "paragraph"]);
    expect(blocks[0]).toMatchObject({ items: [[{ text: "one" }], [{ text: "two" }]] });
  });
});

describe("parseInline", () => {
  it("reads code, bold, italics, strikethrough, links and ticket keys", () => {
    expect(parseInline("See `x_y` and **DEVOPS-491** or *maybe* ~~not~~ [docs](https://a.io/b) CA-1.")).toEqual([
      { type: "text", text: "See " },
      { type: "code", text: "x_y" },
      { type: "text", text: " and " },
      { type: "strong", children: [{ type: "ticket", key: "DEVOPS-491" }] },
      { type: "text", text: " or " },
      { type: "em", children: [{ type: "text", text: "maybe" }] },
      { type: "text", text: " " },
      { type: "del", children: [{ type: "text", text: "not" }] },
      { type: "text", text: " " },
      { type: "link", href: "https://a.io/b", children: [{ type: "text", text: "docs" }] },
      { type: "text", text: " " },
      { type: "ticket", key: "CA-1" },
      { type: "text", text: "." },
    ]);
  });

  it("links bare URLs without the punctuation after them, and leaves snake_case alone", () => {
    expect(parseInline("Go to https://x.io/a_b, then run fire_flow_trigger")).toEqual([
      { type: "text", text: "Go to " },
      { type: "link", href: "https://x.io/a_b", children: [{ type: "text", text: "https://x.io/a_b" }] },
      { type: "text", text: ", then run fire_flow_trigger" },
    ]);
  });

  it("doesn't treat a key inside a code span as a ticket", () => {
    expect(parseInline("`CA-12`")).toEqual([{ type: "code", text: "CA-12" }]);
  });
});

describe("cells", () => {
  it("splits on pipes outside code and drops the outer ones", () => {
    expect(cells("| a | `b|c` | d \\| e |")).toEqual(["a", "`b|c`", "d | e"]);
  });
});
