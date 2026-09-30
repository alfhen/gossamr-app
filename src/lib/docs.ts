import type { WorkBlock, WorkDoc, WorkInline } from "../types";

function inlineText(inlines: WorkInline[]): string {
  return inlines
    .map((i) => {
      switch (i.type) {
        case "text":
        case "link":
          return i.text;
        case "mention":
          return `@${i.name}`;
        case "lineBreak":
          return "\n";
      }
    })
    .join("");
}

function blockText(b: WorkBlock): string {
  switch (b.type) {
    case "paragraph":
    case "heading":
      return inlineText(b.content);
    case "list":
      return b.items.map((item) => item.map(blockText).join("\n")).join("\n");
    case "quote":
      return b.content.map(blockText).join("\n\n");
    case "code":
      return b.text;
    case "rule":
      return "";
  }
}

/** A document as plain text for an editor: blocks are separated by a blank line, mentions keep their `@Name`. */
export function docText(doc: WorkDoc): string {
  return doc.blocks.map(blockText).join("\n\n").trim();
}

/** Plain text as paragraphs: a blank line starts a new one and a single newline is a line break. */
export function docFromText(text: string): WorkDoc {
  const paragraphs = text.trim().split(/\r?\n[ \t]*\r?\n/).filter((p) => p.trim());
  return {
    blocks: paragraphs.map((p) => ({
      type: "paragraph" as const,
      content: p.split(/\r?\n/).flatMap((line, i): WorkInline[] => [
        ...(i ? [{ type: "lineBreak" as const }] : []),
        { type: "text", text: line, marks: [] },
      ]),
    })),
  };
}

/** The doc with `excerpt` quoted after its first paragraph, the shape a reply is posted in. */
export function quoteAfterFirst(doc: WorkDoc, excerpt: string): WorkDoc {
  const quote: WorkBlock = { type: "quote", content: [{ type: "paragraph", content: [{ type: "text", text: excerpt, marks: [] }] }] };
  const blocks = [...doc.blocks];
  blocks.splice(Math.min(1, blocks.length), 0, quote);
  return { blocks };
}
