import { describe, expect, it } from "vitest";
import { docFromText, docText, quoteAfterFirst } from "./docs";

describe("docText", () => {
  it("keeps paragraphs apart with a blank line and line breaks as newlines", () => {
    const doc = docFromText("First line\nsecond line\n\nNext paragraph");
    expect(doc.blocks).toHaveLength(2);
    expect(docText(doc)).toBe("First line\nsecond line\n\nNext paragraph");
  });

  it("writes a mention as @Name", () => {
    const doc = {
      blocks: [
        {
          type: "paragraph" as const,
          content: [
            { type: "text" as const, text: "Thanks ", marks: [] },
            { type: "mention" as const, person: { connectionId: "c", accountId: "a" }, name: "Sam" },
          ],
        },
      ],
    };
    expect(docText(doc)).toBe("Thanks @Sam");
  });

  it("is empty for a document with nothing in it", () => {
    expect(docText({ blocks: [] })).toBe("");
    expect(docFromText("  \n ").blocks).toEqual([]);
  });

  it("reads a quote block into the text between the paragraphs around it, and keeps it when quoting into a doc", () => {
    const doc = quoteAfterFirst(docFromText("@Sam\n\nAgreed"), "Ready for a look");
    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "quote", "paragraph"]);
    expect(docText(doc)).toBe("@Sam\n\nReady for a look\n\nAgreed");
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});
