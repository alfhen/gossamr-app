import { docFromText } from "../lib/docs";
import type { BodyChange, WorkBlock, WorkDoc, WorkInline } from "../types";

/** The part of the backend's Markdown the sample build understands: headings, bullet and numbered lists, quotes, code and paragraphs. */
function inlines(content: WorkInline[]): string {
  return content
    .map((i) => {
      switch (i.type) {
        case "text":
          return i.text;
        case "link":
          return `[${i.text}](${i.href})`;
        case "mention":
          return `@${i.name}`;
        case "lineBreak":
          return "\n";
      }
    })
    .join("");
}

function block(b: WorkBlock): string {
  switch (b.type) {
    case "paragraph":
      return inlines(b.content);
    case "heading":
      return `${"#".repeat(b.level)} ${inlines(b.content).replace(/\n/g, " ")}`;
    case "list":
      return b.items.map((item, n) => `${b.ordered ? `${n + 1}.` : "-"} ${item.map(block).join("\n")}`).join("\n");
    case "quote":
      return b.content
        .map(block)
        .join("\n\n")
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    case "code":
      return `\`\`\`${b.language ?? ""}\n${b.text}\n\`\`\``;
    case "rule":
      return "---";
  }
}

export const markdownOf = (doc: WorkDoc): string => doc.blocks.map(block).join("\n\n").trim();

const para = (lines: string[]): WorkBlock => docFromText(lines.join("\n")).blocks[0];

export function docFromMarkdown(text: string): WorkDoc {
  const blocks: WorkBlock[] = [];
  let run: string[] = [];
  let list: { ordered: boolean; items: WorkBlock[][] } | null = null;
  const flush = () => {
    if (run.length) blocks.push(para(run));
    if (list) blocks.push({ type: "list", ...list });
    run = [];
    list = null;
  };
  for (const line of text.replace(/\r\n/g, "\n").trim().split("\n")) {
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    const item = /^(?:([-*+])|(\d+)[.)]) (.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length, content: [{ type: "text", text: heading[2].trim(), marks: [] }] });
    } else if (item) {
      const ordered = item[2] !== undefined;
      if (run.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push([{ type: "paragraph", content: [{ type: "text", text: item[3], marks: [] }] }]);
    } else {
      if (list) flush();
      run.push(line);
    }
  }
  flush();
  return { blocks };
}

/** A description change as the backend sends it: both documents with their Markdown. */
export function bodyChange(from: WorkDoc, toText: string): BodyChange {
  const to = docFromMarkdown(toText);
  return { from, to, fromText: markdownOf(from), toText: markdownOf(to) };
}
