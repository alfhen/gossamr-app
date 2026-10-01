import { docText } from "../lib/docs";
import { itemKey } from "../lib/filter";
import type { Mention } from "../lib/mentions";
import type { ItemRef, WorkBlock, WorkDoc, WorkEvent, WorkItem } from "../types";

export type LinkKind = "blocks" | "blockedBy" | "relates" | "duplicates" | "duplicatedBy";

export interface LinkRow {
  kind: LinkKind;
  label: string;
  ref: ItemRef;
  /** The linked item's title when it is cached. */
  title: string | null;
}

const LABEL: Record<LinkKind, string> = {
  blocks: "Blocks",
  blockedBy: "Blocked by",
  relates: "Relates to",
  duplicates: "Duplicates",
  duplicatedBy: "Duplicated by",
};

/** Links as seen from `item`: its own, plus those other items hold that point at it. */
export function linkRows(item: WorkItem, all: Record<string, WorkItem>): LinkRow[] {
  const me = itemKey(item.item);
  const rows = new Map<string, LinkRow>();
  const add = (kind: LinkKind, other: ItemRef) => {
    const id = `${kind}:${itemKey(other)}`;
    if (!rows.has(id)) rows.set(id, { kind, label: LABEL[kind], ref: other, title: all[itemKey(other)]?.title ?? null });
  };
  const seen = (l: WorkItem["links"][number]) => {
    const outgoing = itemKey(l.from) === me;
    if (!outgoing && itemKey(l.to) !== me) return;
    const other = outgoing ? l.to : l.from;
    if (l.kind === "relates") add("relates", other);
    else if (l.kind === "blocks") add(outgoing ? "blocks" : "blockedBy", other);
    else add(outgoing ? "duplicates" : "duplicatedBy", other);
  };
  item.links.forEach(seen);
  for (const other of Object.values(all)) if (other !== item) other.links.forEach(seen);
  const order: LinkKind[] = ["blockedBy", "blocks", "relates", "duplicates", "duplicatedBy"];
  return [...rows.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export interface Note {
  id: string;
  at: string;
  who: string;
  text: string;
  /** The structured body, when there is one; `text` is its plain reading. */
  doc?: WorkDoc;
  /** Written by the signed-in person. */
  mine?: boolean;
  /** The author's account, for @mentioning them in a reply. */
  accountId?: string | null;
  /** Set on a comment that opens with a quote of another comment. */
  reply?: ReplyInfo;
}

export interface ReplyInfo {
  /** The quoted text, as plain text. */
  quote: string;
  /** Who the reply answers: the matched comment's author, else the person @mentioned above the quote. */
  replyingTo: string | null;
  /** The earlier comment the quote was matched to. */
  targetId: string | null;
  /** What the author wrote below the quote. */
  body: WorkDoc;
}

export const EXCERPT_LENGTH = 200;

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** The first `max` characters of `text` on one line, cut at a word boundary where there is one. */
export function excerpt(text: string, max = EXCERPT_LENGTH): string {
  const flat = squash(text);
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const comparable = (text: string) => squash(text).replace(/(…|\.\.\.)$/, "").trimEnd().toLowerCase();

const isMentionLead = (b: WorkBlock): string | null => {
  if (b.type !== "paragraph") return null;
  const mentions = b.content.filter((i) => i.type === "mention");
  const onlyMentions = b.content.every((i) => i.type === "mention" || (i.type === "text" && !i.text.trim()));
  return onlyMentions && mentions[0]?.type === "mention" ? mentions[0].name : null;
};

interface Opening {
  mentioned: string | null;
  quote: string;
  body: WorkDoc;
}

/** A comment body that opens with a quote block, optionally after a paragraph holding only an @mention. */
function opening(doc: WorkDoc | undefined): Opening | null {
  if (!doc) return null;
  const mentioned = doc.blocks[0] ? isMentionLead(doc.blocks[0]) : null;
  const at = mentioned === null ? 0 : 1;
  const block = doc.blocks[at];
  if (block?.type !== "quote") return null;
  return { mentioned, quote: squash(docText({ blocks: [block] })), body: { blocks: doc.blocks.slice(at + 1) } };
}

/** What a comment says of its own: for a reply, the text below the quote. */
export const ownText = (n: Note): string => (n.reply ? docText(n.reply.body) : n.text);

/**
 * Marks the comments that answer another one. Jira comments are a flat list, so a reply is a comment that opens
 * with a quote; it is tied to the comment whose text starts with that quote, preferring the @mentioned author and
 * an earlier comment, and is still a reply when nothing matches.
 */
export function withReplies(notes: readonly Note[]): Note[] {
  const found = notes.map((n) => opening(n.doc));
  const own = notes.map((n, i) => comparable(found[i] ? docText(found[i]!.body) : n.text));
  return notes.map((n, i) => {
    const o = found[i];
    if (!o) return n;
    const wanted = comparable(o.quote);
    const hits = wanted ? notes.flatMap((_, j) => (j !== i && own[j].startsWith(wanted) ? [j] : [])) : [];
    const pick = (list: number[]) => list.find((j) => notes[j].who === o.mentioned) ?? list[0];
    const earlier = hits.filter((j) => j < i).reverse();
    const target = pick(earlier) ?? pick(hits);
    const reply: ReplyInfo = {
      quote: o.quote,
      replyingTo: target !== undefined ? notes[target].who : o.mentioned,
      targetId: target !== undefined && target < i ? notes[target].id : null,
      body: o.body,
    };
    return { ...n, reply };
  });
}

/** The order comments are shown in. Replies are matched to what they answer in the order they were written, so this comes after `withReplies`. */
export const newestFirst = (notes: readonly Note[]): Note[] => [...notes].reverse();

export interface ReplyDraft {
  /** The comment being answered. */
  to: { id: string; who: string };
  /** What the composer starts with: the @mention on its own line above where the answer goes. */
  text: string;
  mentions: Mention[];
  /** The quoted excerpt that is posted between the mention and the answer. */
  quote: string;
}

/** How the composer starts when answering `note`. Someone whose name isn't known is quoted but not @mentioned. */
export function replyDraft(note: Note): ReplyDraft {
  const person = note.accountId && note.who !== "Someone" ? { accountId: note.accountId, name: note.who } : null;
  return {
    to: { id: note.id, who: note.who },
    text: person ? `@${person.name}\n\n` : "",
    mentions: person ? [person] : [],
    quote: excerpt(ownText(note)),
  };
}

export type PeekSectionId = "description" | "links" | "development" | "comments" | "history";

export const SECTION_TITLE: Record<PeekSectionId, string> = {
  description: "Description",
  links: "Links",
  development: "Development",
  comments: "Comments",
  history: "History",
};

export interface SectionChip {
  id: PeekSectionId;
  title: string;
  count?: number;
}

/** The sections that have something to jump to, in reading order. Description and Comments are always there; Development is there while a code host is connected. */
export function sectionChips(n: { links: number; comments: number; history: number; development?: number }): SectionChip[] {
  const chips: SectionChip[] = [{ id: "description", title: SECTION_TITLE.description }];
  if (n.links > 0) chips.push({ id: "links", title: SECTION_TITLE.links, count: n.links });
  if (n.development !== undefined) chips.push({ id: "development", title: SECTION_TITLE.development, count: n.development });
  chips.push({ id: "comments", title: SECTION_TITLE.comments, count: n.comments });
  if (n.history > 0) chips.push({ id: "history", title: SECTION_TITLE.history, count: n.history });
  return chips;
}

export type Collapsed = Partial<Record<PeekSectionId, boolean>>;

export const isCollapsed = (collapsed: Collapsed, id: PeekSectionId) => collapsed[id] === true;

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = Array.from(words[0])[0];
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : "";
  return (first + last).toUpperCase();
}

const OPAQUE_ID = /^[0-9a-f]{8,}$|:|^[0-9a-z-]{24,}$/i;

/** A person's name, or "Someone" when only an opaque account id is known. */
export function displayName(names: Record<string, string>, accountId: string | null): string {
  if (!accountId) return "Someone";
  const known = names[accountId];
  if (known) return known;
  return OPAQUE_ID.test(accountId) ? "Someone" : accountId;
}

const textOf = (payload: unknown): string => {
  const t = (payload as { text?: unknown } | null)?.text;
  return typeof t === "string" ? t : "";
};

const ARROW = " → ";

/** Where a status event moved from and to. Events stored before the payload carried them only have the "From → To" text. */
export function statusMove(payload: unknown): { from: string; to: string } | null {
  const p = payload as { from?: unknown; to?: unknown } | null;
  if (typeof p?.from === "string" && typeof p?.to === "string" && p.from && p.to) return { from: p.from, to: p.to };
  const text = textOf(payload);
  const at = text.indexOf(ARROW);
  if (at <= 0) return null;
  const from = text.slice(0, at).trim();
  const to = text.slice(at + ARROW.length).trim();
  return from && to ? { from, to } : null;
}

const assignedLine = (payload: unknown): string => {
  const p = payload as { from?: unknown; to?: unknown } | null;
  const to = typeof p?.to === "string" && p.to ? p.to : null;
  const from = typeof p?.from === "string" && p.from ? p.from : null;
  if (to && from) return `changed the assignee from ${from} to ${to}`;
  if (to) return `assigned it to ${to}`;
  return /^assigned to you$/i.test(textOf(payload).trim()) ? "assigned it to you" : "changed the assignee";
};

/** What a field event did, as a clause: "set the priority to High", "changed the labels from a to b", "cleared the due date". */
export function fieldLine(payload: unknown): string {
  const p = payload as { field?: unknown; from?: unknown; to?: unknown } | null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const field = str(p?.field)?.toLowerCase();
  const [from, to] = [str(p?.from), str(p?.to)];
  if (!field) return "updated a field";
  if (from && to) return `changed the ${field} from ${from} to ${to}`;
  if (to) return `set the ${field} to ${to}`;
  if (from) return `cleared the ${field} (was ${from})`;
  return `changed the ${field}`;
}

type Mine = (accountId: string | null) => boolean;

/** Comments recorded as events, oldest first. */
export function commentNotes(events: readonly WorkEvent[], nameOf: (accountId: string | null) => string, isMine: Mine = () => false): Note[] {
  return events
    .filter((e) => e.kind === "commentAdded" && textOf(e.payload))
    .map((e) => ({ id: e.id, at: e.at, who: nameOf(e.actor?.accountId ?? null), text: textOf(e.payload), mine: isMine(e.actor?.accountId ?? null) }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Everything but comments, newest first, as one line each. */
export function historyNotes(events: readonly WorkEvent[], nameOf: (accountId: string | null) => string, isMine: Mine = () => false): Note[] {
  const line = (e: WorkEvent): string => {
    switch (e.kind) {
      case "statusChanged": {
        const move = statusMove(e.payload);
        return move ? `moved from ${move.from} to ${move.to}` : "changed the status";
      }
      case "assigned":
        return assignedLine(e.payload);
      case "itemCreated":
        return "created it";
      case "prOpened":
        return "opened a pull request";
      case "prMerged":
        return "merged a pull request";
      case "checkFailed":
        return "had a check fail";
      case "reviewRequested":
        return "asked for a review";
      case "prClosed":
        return "closed a pull request";
      case "prReadyForReview":
        return "marked a pull request ready for review";
      case "reviewSubmitted":
        return "reviewed a pull request";
      case "prMentioned":
        return "mentioned you on a pull request";
      case "fieldChanged":
        return fieldLine(e.payload);
      case "commentAdded":
        return "";
    }
  };
  return events
    .flatMap((e) => (line(e) ? [{ id: e.id, at: e.at, who: nameOf(e.actor?.accountId ?? null), text: line(e), mine: isMine(e.actor?.accountId ?? null) }] : []))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export interface Crumb {
  ref: ItemRef;
  title: string | null;
}

/** The parent (an epic, or a story above a subtask) with its title when it is cached. */
export function parentCrumb(item: WorkItem, all: Record<string, WorkItem>): Crumb | null {
  if (!item.parent) return null;
  return { ref: item.parent, title: all[itemKey(item.parent)]?.title ?? null };
}

export interface SubtaskRow {
  ref: ItemRef;
  title: string;
  status: WorkItem["status"];
  done: boolean;
}

export interface Subtasks {
  rows: SubtaskRow[];
  done: number;
}

/** Children in key order, with how many are finished. */
export function subtasksOf(children: readonly WorkItem[]): Subtasks {
  const rows = children
    .map((c): SubtaskRow => ({ ref: c.item, title: c.title, status: c.status, done: c.status.category === "done" }))
    .sort((a, b) => a.ref.key.localeCompare(b.ref.key, undefined, { numeric: true }));
  return { rows, done: rows.filter((r) => r.done).length };
}

/** The key `step` places from `current` in `order`, stopping at the ends. Starts at the first (or last) key when nothing is selected. */
export function stepKey(order: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (!order.length) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return order[step > 0 ? 0 : order.length - 1];
  return order[Math.max(0, Math.min(order.length - 1, at + step))];
}
