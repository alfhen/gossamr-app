/**
 * The Markdown Claude writes in replies, parsed into plain data for React to render. It covers what Claude uses:
 * headings, paragraphs, lists (nested by indentation), GFM tables, fenced code, quotes and rules, and inline code,
 * bold, italics, strikethrough, links and Jira ticket keys. There is no raw HTML: anything else stays text.
 */

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "table"; align: Align[]; head: string[]; rows: string[][] }
  | { type: "quote"; blocks: Block[] }
  | { type: "rule" };

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "ticket"; key: string };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, "    ").length;
const blank = (line: string) => !line.trim();

/** Splits a table row on unescaped pipes outside code spans, dropping the outer pipes. */
export function cells(row: string): string[] {
  const out: string[] = [];
  let cell = "";
  let inCode = false;
  const s = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (c === "`") {
      inCode = !inCode;
      cell += c;
    } else if (c === "|" && !inCode) {
      out.push(cell.trim());
      cell = "";
    } else {
      cell += c;
    }
  }
  out.push(cell.trim());
  return out;
}

function alignOf(spec: string): Align {
  const s = spec.trim();
  if (s.startsWith(":") && s.endsWith(":")) return "center";
  if (s.endsWith(":")) return "right";
  if (s.startsWith(":")) return "left";
  return null;
}

/** Whether a line starts some block other than a paragraph, which ends the paragraph before it. */
function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i];
  return (
    FENCE.test(l) ||
    HEADING.test(l) ||
    RULE.test(l) ||
    ITEM.test(l) ||
    QUOTE.test(l) ||
    (l.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-"))
  );
}

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      i++;
      // An unclosed fence runs to the end, which is also how a reply that's still streaming looks.
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push({ type: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      out.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push({ type: "rule" });
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map(alignOf);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) {
        const row = cells(lines[i++]);
        rows.push(head.map((_, c) => row[c] ?? ""));
      }
      out.push({ type: "table", align: head.map((_, c) => align[c] ?? null), head, rows });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)![1]);
      out.push({ type: "quote", blocks: parseBlocks(body.join("\n")) });
      continue;
    }

    const item = line.match(ITEM);
    if (item) {
      const [list, next] = parseList(lines, i);
      out.push(list);
      i = next;
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines, i)) para.push(lines[i++].trim());
    out.push({ type: "paragraph", text: para.join("\n") });
  }
  return out;
}

/**
 * A list starting at `start`, with each item's own lines (continuations and nested lists, dedented) parsed as blocks.
 * Returns the list and the index of the first line after it.
 */
function parseList(lines: string[], start: number): [Block, number] {
  const first = lines[start].match(ITEM)!;
  const base = indentOf(first[1]);
  const ordered = first[3] !== undefined;
  const items: string[][] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(ITEM);
    if (m && Math.abs(indentOf(m[1]) - base) < 2) {
      if ((m[3] !== undefined) !== ordered) break;
      items.push([m[4]]);
      i++;
      continue;
    }
    if (blank(line)) {
      // A blank line stays in the list only if the list, or the current item, carries on after it.
      const next = lines.slice(i + 1).find((l) => !blank(l));
      if (next === undefined || indentOf(next) <= base && !ITEM.test(next)) break;
      items[items.length - 1].push("");
      i++;
      continue;
    }
    if (indentOf(line) > base || !startsBlock(lines, i)) {
      items[items.length - 1].push(line.slice(Math.min(indentOf(line), base + 2)));
      i++;
      continue;
    }
    break;
  }
  return [{ type: "list", ordered, start: ordered ? Number(first[3]) : 1, items: items.map((l) => parseBlocks(l.join("\n"))) }, i];
}

const INLINE =
  /`([^`\n]+)`|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*(?=\S)(.+?)(?<=\S)\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_])|\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index!;
    if (at > last) out.push({ type: "text", text: text.slice(last, at) });
    const [, code, strong, strong2, del, em, label, href, url, key] = m;
    if (code !== undefined) out.push({ type: "code", text: code });
    else if (strong !== undefined || strong2 !== undefined) out.push({ type: "strong", children: parseInline(strong ?? strong2) });
    else if (del !== undefined) out.push({ type: "del", children: parseInline(del) });
    else if (em !== undefined) out.push({ type: "em", children: parseInline(em) });
    else if (label !== undefined) out.push({ type: "link", href, children: parseInline(label) });
    else if (url !== undefined) out.push({ type: "link", href: url, children: [{ type: "text", text: url }] });
    else out.push({ type: "ticket", key });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}
