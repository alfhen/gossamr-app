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

const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, "    ").length;
const blank = (line: string) => !line.trim();

/** A fence opener as its marker and language, or null. A backtick fence's info string can't contain backticks. */
function opener(line: string): { marker: string; lang: string } | null {
  const m = line.match(FENCE);
  if (!m || (m[1][0] === "`" && m[2].includes("`"))) return null;
  return { marker: m[1], lang: m[2].trim().split(/\s+/)[0] };
}

/** Whether `line` closes a fence opened with `marker`: the same character at least as many times, and nothing after. */
function closes(line: string, marker: string): boolean {
  const m = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
  return !!m && m[1][0] === marker[0] && m[1].length >= marker.length;
}

/** Whether a table starts at `i`: a header row followed by a delimiter row with one cell per header cell. */
function tableAt(lines: string[], i: number): boolean {
  const next = lines[i + 1];
  return (
    lines[i].includes("|") &&
    next !== undefined &&
    next.includes("-") &&
    TABLE_RULE.test(next) &&
    cells(next).length === cells(lines[i]).length
  );
}

/** Splits a table row on unescaped pipes outside code spans, dropping the outer pipes. */
export function cells(row: string): string[] {
  const out: string[] = [];
  let cell = "";
  // A code span closes only on a backtick run as long as the one that opened it, as in ``a|b``. A run with no
  // matching close later in the row is plain text and doesn't hide the pipes after it. Escaped backticks are text.
  let codeTicks = 0;
  const closedLater = (from: number, run: number) =>
    [...s.slice(from).matchAll(/(?<!\\)`+/g)].some((m) => m[0].length === run);
  const s = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (c === "\\" && s[i + 1] === "`" && !codeTicks) {
      cell += "\\`";
      i++;
    } else if (c === "`") {
      let run = 1;
      while (s[i + run] === "`") run++;
      if (!codeTicks && closedLater(i + run, run)) codeTicks = run;
      else if (run === codeTicks) codeTicks = 0;
      cell += s.slice(i, i + run);
      i += run - 1;
    } else if (c === "|" && !codeTicks) {
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
    opener(l) !== null ||
    HEADING.test(l) ||
    RULE.test(l) ||
    ITEM.test(l) ||
    QUOTE.test(l) ||
    tableAt(lines, i)
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

    const fence = opener(line);
    if (fence) {
      const body: string[] = [];
      i++;
      // An unclosed fence runs to the end, which is also how a reply that's still streaming looks.
      while (i < lines.length && !closes(lines[i], fence.marker)) body.push(lines[i++]);
      i++;
      out.push({ type: "code", lang: fence.lang, text: body.join("\n") });
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

    if (tableAt(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map(alignOf);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|") && !startsBlock(lines, i)) {
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

/**
 * Inline Markdown. Inside a link's label, ticket keys and URLs stay text, since the link already decides where a
 * click goes and a link inside a link would compete with it.
 */
export function parseInline(text: string, inLink = false): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index!;
    if (at > last) out.push({ type: "text", text: text.slice(last, at) });
    const [, code, strong, strong2, del, em, label, href, url, key] = m;
    if (code !== undefined) out.push({ type: "code", text: code });
    else if (strong !== undefined || strong2 !== undefined) out.push({ type: "strong", children: parseInline(strong ?? strong2, inLink) });
    else if (del !== undefined) out.push({ type: "del", children: parseInline(del, inLink) });
    else if (em !== undefined) out.push({ type: "em", children: parseInline(em, inLink) });
    else if (inLink) out.push({ type: "text", text: m[0] });
    else if (label !== undefined) out.push({ type: "link", href, children: parseInline(label, true) });
    else if (url !== undefined) out.push({ type: "link", href: url, children: [{ type: "text", text: url }] });
    else out.push({ type: "ticket", key });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}
