import { describe, expect, it } from "vitest";
import { docFromText, docText } from "./docs";

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
});
