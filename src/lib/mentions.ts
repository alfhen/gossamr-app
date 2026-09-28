import type { Person, Ticket } from "../types";

export interface Mention {
  accountId: string;
  name: string;
}

export interface ActiveQuery {
  /** Index of the `@` that starts the mention. */
  start: number;
  query: string;
}

// A mention starts at the beginning of the text or after whitespace/an opening bracket, and may span one space so
// "@Mette L" still matches "Mette Lund".
const TRIGGER = /(?:^|[\s([{"'])@([\p{L}\p{N}._'-]*(?: [\p{L}\p{N}._'-]*)?)$/u;

/** The mention being typed at `caret`, if any. */
export function activeQuery(text: string, caret: number): ActiveQuery | null {
  const before = text.slice(0, caret);
  const m = TRIGGER.exec(before);
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

// Letters like ø, æ and ß don't decompose under NFD, so "soren" wouldn't find "Søren" without these.
const LETTERS: Record<string, string> = { ø: "o", æ: "ae", œ: "oe", ß: "ss", đ: "d", ł: "l", þ: "th" };
export const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[øæœßđłþ]/g, (c) => LETTERS[c]);

/** People whose first, last or full name starts with the query, keeping the given order (most relevant first). */
export function rankPeople(people: Person[], query: string, limit = 6): Person[] {
  const q = fold(query.trim());
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const p of people) {
    if (seen.has(p.accountId)) continue;
    const name = fold(p.name);
    const matches = !q || name.startsWith(q) || name.split(/\s+/).some((part) => part.startsWith(q));
    if (!matches) continue;
    seen.add(p.accountId);
    out.push(p);
    if (out.length === limit) break;
  }
  return out;
}

/** Everyone involved in a ticket, most relevant first: commenters (latest first), assignee, reporter, then editors. */
export function participants(t: Ticket, me: string): Person[] {
  const people = [
    ...[...t.comments].reverse().map((c) => c.author),
    t.assignee,
    t.reporter,
    ...[...t.changes].reverse().map((c) => c.author),
  ].filter((p): p is Person => !!p && p.accountId !== me);
  return rankPeople(people, "", Number.MAX_SAFE_INTEGER);
}

/** Replaces the typed `@query` with `@Full Name ` and returns the new text and caret. */
export function insertMention(text: string, q: ActiveQuery, caret: number, person: Mention) {
  const inserted = `@${person.name} `;
  const after = text.slice(caret).replace(/^ /, "");
  return { text: text.slice(0, q.start) + inserted + after, caret: q.start + inserted.length };
}

export interface Segment {
  text: string;
  mention?: Mention;
}

/** Splits text into plain runs and `@Name` runs for the mentions it still contains, longest names first. */
export function segments(text: string, mentions: Mention[]): Segment[] {
  const byLength = [...mentions].sort((a, b) => b.name.length - a.name.length);
  const out: Segment[] = [];
  let plain = "";
  for (let i = 0; i < text.length; ) {
    const startsToken = i === 0 || /[\s([{"']/u.test(text[i - 1]);
    const hit =
      text[i] === "@" && startsToken && byLength.find((m) => text.startsWith(`@${m.name}`, i) && isBoundary(text[i + m.name.length + 1]));
    if (hit) {
      if (plain) out.push({ text: plain });
      plain = "";
      out.push({ text: `@${hit.name}`, mention: hit });
      i += hit.name.length + 1;
    } else {
      plain += text[i++];
    }
  }
  if (plain) out.push({ text: plain });
  return out;
}

function isBoundary(ch: string | undefined) {
  return ch === undefined || !/[\p{L}\p{N}_]/u.test(ch);
}

/** The mentions still present in the text, each once. */
export function liveMentions(text: string, mentions: Mention[]): Mention[] {
  const found = new Map<string, Mention>();
  for (const s of segments(text, mentions)) if (s.mention) found.set(s.mention.accountId, s.mention);
  return [...found.values()];
}

/**
 * Turns `@First` or `@Full Name` in drafted text (e.g. from Claude) into real mentions of people on the ticket,
 * rewriting first names to full names. Ambiguous names, first or full, are left as plain text.
 */
export function autoLink(text: string, people: Person[]): { text: string; mentions: Mention[] } {
  const mentions = new Map<string, Mention>();
  let out = text;
  const owners = (name: string) => new Set(people.filter((p) => p.name === name).map((p) => p.accountId)).size;
  for (const p of people) {
    if (owners(p.name) > 1) continue;
    const full = `@${p.name}`;
    if (containsToken(out, full)) mentions.set(p.accountId, { accountId: p.accountId, name: p.name });
  }
  const firsts = new Map<string, Person[]>();
  for (const p of people) {
    const first = p.name.split(/\s+/)[0];
    firsts.set(first, [...(firsts.get(first) ?? []), p]);
  }
  for (const [first, owners] of firsts) {
    if (owners.length !== 1 || owners[0].name === first) continue;
    const p = owners[0];
    const re = new RegExp(`@${escapeRe(first)}(?![\\p{L}\\p{N}]| ${escapeRe(p.name.slice(first.length + 1))})`, "gu");
    if (re.test(out)) {
      out = out.replace(re, `@${p.name}`);
      mentions.set(p.accountId, { accountId: p.accountId, name: p.name });
    }
  }
  return { text: out, mentions: [...mentions.values()] };
}

function containsToken(text: string, token: string) {
  let i = text.indexOf(token);
  while (i >= 0) {
    if (isBoundary(text[i + token.length])) return true;
    i = text.indexOf(token, i + 1);
  }
  return false;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
