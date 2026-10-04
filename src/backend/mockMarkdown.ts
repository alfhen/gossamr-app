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
    case "code": {
      // The parser closes a block at a line that is only backticks once trimmed, so the fence must outrun every such run.
      const longest = Math.max(0, ...b.text.split("\n").map((l) => /^\s*(`*)/.exec(l)![1].length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      const info = b.language && !/[`\n]/.test(b.language) ? b.language : "";
      return `${fence}${info}\n${b.text}\n${fence}`;
    }
    case "rule":
      return "---";
  }
}

export const markdownOf = (doc: WorkDoc): string => doc.blocks.map(block).join("\n\n").trim();

const para = (lines: string[]): WorkBlock => docFromText(lines.join("\n")).blocks[0];

/** Leading whitespace in columns, a tab advancing to the next multiple of four. */
const columns = (line: string) => {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4 - (n % 4);
    else break;
  }
  return n;
};

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
  // Leading blank lines go, but not the indentation of the first line: it decides whether a fence opens.
  const lines = text.replace(/\r\n/g, "\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd().split("\n");
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at];
    // An opening fence sits within three columns, and a backtick fence's info string holds no backtick.
    const fence = columns(line) <= 3 ? /^\s*(`{3,}|~{3,})(.*)$/.exec(line) : null;
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      flush();
      const [mark, size] = [fence[1][0], fence[1].length];
      const body: string[] = [];
      for (at++; at < lines.length; at++) {
        const closing = lines[at].trim();
        // A closing fence is indented by at most three columns; four make it code.
        if (columns(lines[at]) <= 3 && closing.length >= size && [...closing].every((c) => c === mark)) break;
        body.push(lines[at]);
      }
      const language = fence[2].trim();
      blocks.push({ type: "code", language: language || null, text: body.join("\n") });
      continue;
    }
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
