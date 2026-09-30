import { codeFilterMatches, CODE_FILTER_LABEL, type CodeSummary } from "./devLinks";
import type {
  ContainerRef,
  ItemRef,
  PersonRef,
  WorkBlock,
  WorkCategory,
  WorkContainer,
  WorkDoc,
  WorkFilter,
  WorkInline,
  WorkItem,
} from "../types";

/** Mirrors `Filter::matches` in src-tauri/src/domain/filter.rs; src/lib/filter.fixtures.json holds cases both sides run. */

export interface FilterContext {
  /** Every account that is the user, across connections. */
  me: PersonRef[];
  now: number;
  /** Keys (see `itemKey`) of items waiting on the user. */
  needsMe: ReadonlySet<string>;
  /** What the linked code of each item adds up to, by `itemKey`; items not read yet are missing. */
  code?: ReadonlyMap<string, CodeSummary>;
}

export const itemKey = (r: { connectionId: string; externalId: string }) => `${r.connectionId}:${r.externalId}`;
export const personKey = (p: PersonRef) => `${p.connectionId}:${p.accountId}`;
export const containerKey = (c: ContainerRef) => `${c.connectionId}:${c.externalId}`;

const DAY = 86_400_000;
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const samePerson = (a: PersonRef, b: PersonRef) => a.connectionId === b.connectionId && a.accountId === b.accountId;

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

function blockText(blocks: WorkBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "paragraph":
        case "heading":
          return `${inlineText(b.content)}\n`;
        case "list":
          return b.items.map(blockText).join("");
        case "quote":
          return blockText(b.content);
        case "code":
          return `${b.text}\n`;
        case "rule":
          return "";
      }
    })
    .join("");
}

export const plainText = (doc: WorkDoc) => blockText(doc.blocks).trimEnd();

export function needsAllItems(f: WorkFilter): boolean {
  return f.type === "blocked" || (f.type === "and" && f.filters.some(needsAllItems));
}

/** A blocker missing from `all` counts as still blocking. */
function blockedTest(all: readonly WorkItem[]) {
  const byKey = new Map(all.map((i) => [itemKey(i.item), i]));
  const incoming = new Map<string, ItemRef[]>();
  for (const i of all) {
    for (const l of i.links) {
      if (l.kind !== "blocks") continue;
      const k = itemKey(l.to);
      incoming.set(k, [...(incoming.get(k) ?? []), l.from]);
    }
  }
  const open = (r: ItemRef) => (byKey.get(itemKey(r))?.status.category ?? "todo") !== "done";
  return (item: WorkItem) => {
    const own = item.links.filter((l) => l.kind === "blocks" && itemKey(l.to) === itemKey(item.item)).map((l) => l.from);
    return [...own, ...(incoming.get(itemKey(item.item)) ?? [])].some(open);
  };
}

/** A predicate for `f`, built once so a list is filtered without rescanning links per item. */
export function compileFilter(f: WorkFilter, all: readonly WorkItem[], ctx: FilterContext): (item: WorkItem) => boolean {
  const blocked = needsAllItems(f) ? blockedTest(all) : () => false;
  const go = (f: WorkFilter): ((i: WorkItem) => boolean) => {
    switch (f.type) {
      case "needsMe":
        return (i) => ctx.needsMe.has(itemKey(i.item));
      case "mine":
        return (i) => !!i.assignee && ctx.me.some((m) => samePerson(m, i.assignee!));
      case "unassigned":
        return (i) => i.assignee === null;
      case "blocked":
        return (i) => i.status.category !== "done" && blocked(i);
      case "open":
        return (i) => i.status.category !== "done";
      case "assignee":
        return (i) => !!i.assignee && samePerson(i.assignee, f.person);
      case "status": {
        const name = asciiLower(f.name);
        return (i) => asciiLower(i.status.name) === name;
      }
      case "category":
        return (i) => i.status.category === f.category;
      case "stale":
        return (i) => i.status.category !== "done" && ctx.now - Date.parse(i.updated) >= f.days * DAY;
      case "container":
        return (i) => containerKey(i.container) === containerKey(f.container);
      case "parent":
        return (i) => !!i.parent && itemKey(i.parent) === itemKey(f.item);
      case "label": {
        const label = asciiLower(f.label);
        return (i) => i.labels.some((l) => asciiLower(l) === label);
      }
      case "text": {
        const needle = f.text.toLowerCase();
        return (i) =>
          i.title.toLowerCase().includes(needle) ||
          i.item.key.toLowerCase().includes(needle) ||
          plainText(i.body).toLowerCase().includes(needle);
      }
      case "items": {
        const keys = new Set(f.items.map(itemKey));
        return (i) => keys.has(itemKey(i.item));
      }
      case "code":
        return (i) => codeFilterMatches(f.check, ctx.code?.get(itemKey(i.item)));
      case "and": {
        const parts = f.filters.map(go);
        return (i) => parts.every((p) => p(i));
      }
    }
  };
  return go(f);
}

export function matchesFilter(f: WorkFilter, item: WorkItem, all: readonly WorkItem[], ctx: FilterContext): boolean {
  return compileFilter(f, all, ctx)(item);
}

/** Items that match, in input order. */
export function selectItems(f: WorkFilter, items: readonly WorkItem[], ctx: FilterContext): WorkItem[] {
  return items.filter(compileFilter(f, items, ctx));
}

/** Whether any part of the filter looks at linked code, which has to be read before the filter can answer. */
export const usesCode = (f: WorkFilter): boolean => filterChips(f).some((c) => c.type === "code");

/** The filter without its client-only parts, which is all the backend can read. */
export const withoutCode = (f: WorkFilter): WorkFilter => and(...filterChips(f).filter((c) => c.type !== "code"));

export const ALL: WorkFilter = { type: "and", filters: [] };

export function and(...filters: WorkFilter[]): WorkFilter {
  const flat = filters.flatMap((f) => (f.type === "and" ? f.filters : [f]));
  return flat.length === 1 ? flat[0] : { type: "and", filters: flat };
}

/** The chips a filter shows as: an `and` is its parts, anything else is one chip. */
export const filterChips = (f: WorkFilter): WorkFilter[] => (f.type === "and" ? f.filters.flatMap(filterChips) : [f]);

export interface QueryLookup {
  containers: readonly WorkContainer[];
  people: readonly { ref: PersonRef; name: string }[];
  me: readonly PersonRef[];
  items?: readonly WorkItem[];
}

const CATEGORIES: Record<string, WorkCategory> = {
  todo: "todo",
  active: "active",
  progress: "active",
  doing: "active",
  done: "done",
  closed: "done",
};

const STALE_DAYS = 5;

function tokenize(q: string): string[] {
  const out: string[] = [];
  for (const m of q.matchAll(/(?:[^\s"]+:)?"([^"]*)"|\S+/g)) {
    const whole = m[0];
    out.push(m[1] !== undefined ? whole.replace(/"/g, "") : whole);
  }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();

function findContainer(lookup: QueryLookup, word: string): WorkContainer | undefined {
  const w = norm(word);
  return lookup.containers.find((c) => norm(c.key) === w || norm(c.name) === w);
}

function findPerson(lookup: QueryLookup, word: string): PersonRef | undefined {
  const w = norm(word);
  const exact = lookup.people.find((p) => norm(p.ref.accountId) === w || norm(p.name) === w);
  return (exact ?? lookup.people.find((p) => norm(p.name).split(/\s+/).some((part) => part === w)))?.ref;
}

function findItem(lookup: QueryLookup, word: string): ItemRef | undefined {
  const w = norm(word);
  return lookup.items?.find((i) => norm(i.item.key) === w)?.item;
}

function term(token: string, lookup: QueryLookup): WorkFilter {
  const colon = token.indexOf(":");
  const name = colon > 0 ? norm(token.slice(0, colon)) : norm(token);
  const value = colon > 0 ? token.slice(colon + 1) : "";
  const text: WorkFilter = { type: "text", text: token };
  if (colon < 0) {
    switch (name) {
      case "blocked":
        return { type: "blocked" };
      case "stale":
        return { type: "stale", days: STALE_DAYS };
      case "open":
        return { type: "open" };
      case "unassigned":
        return { type: "unassigned" };
      case "mine":
        return { type: "mine" };
      case "needsme":
      case "needs-me":
        return { type: "needsMe" };
      case "done":
        return { type: "category", category: "done" };
      case "pr":
        return { type: "code", check: "has" };
      default:
        return text;
    }
  }
  const v = norm(value);
  if (!v) return text;
  switch (name) {
    case "assignee":
    case "owner": {
      if (v === "me") return { type: "mine" };
      if (v === "none" || v === "unassigned") return { type: "unassigned" };
      const person = findPerson(lookup, value);
      return person ? { type: "assignee", person } : text;
    }
    case "status":
      return { type: "status", name: value };
    case "category":
      return CATEGORIES[v] ? { type: "category", category: CATEGORIES[v] } : text;
    case "project":
    case "container": {
      const c = findContainer(lookup, value);
      return c ? { type: "container", container: c.ref } : text;
    }
    case "label":
      return { type: "label", label: value };
    case "stale": {
      const days = Number(v);
      return Number.isInteger(days) && days >= 0 ? { type: "stale", days } : text;
    }
    case "parent":
    case "epic": {
      const item = findItem(lookup, value);
      return item ? { type: "parent", item } : text;
    }
    case "needs":
      return v === "me" ? { type: "needsMe" } : text;
    case "has":
      return v === "pr" ? { type: "code", check: "has" } : text;
    case "no":
      return v === "pr" ? { type: "code", check: "none" } : text;
    case "pr":
      return v === "open" || v === "merged" ? { type: "code", check: v } : text;
    case "checks":
      return v === "failing" ? { type: "code", check: "failing" } : text;
    default:
      return text;
  }
}

/**
 * Turns the words in a filter box into a filter: `assignee:me`, `status:"in review"`, `project:web`, `label:api`,
 * `stale`, `stale:7`, `blocked`, and so on. Anything unrecognised searches the text, so no word is dropped.
 */
export function parseQuery(q: string, lookup: QueryLookup): WorkFilter {
  return and(...tokenize(q).map((t) => term(t, lookup)));
}

const CATEGORY_LABEL: Record<WorkCategory, string> = { todo: "to do", active: "in progress", done: "done" };

/** A short label for a chip. */
export function describeFilter(f: WorkFilter, lookup: Pick<QueryLookup, "containers" | "people" | "items">): string {
  switch (f.type) {
    case "needsMe":
      return "Needs me";
    case "mine":
      return "Assigned to me";
    case "unassigned":
      return "Unassigned";
    case "blocked":
      return "Blocked";
    case "open":
      return "Not done";
    case "assignee":
      return `Assignee: ${lookup.people.find((p) => samePerson(p.ref, f.person))?.name ?? f.person.accountId}`;
    case "status":
      return `Status: ${f.name}`;
    case "category":
      return `Status: ${CATEGORY_LABEL[f.category]}`;
    case "stale":
      return `No update for ${f.days}d+`;
    case "container":
      return `Project: ${lookup.containers.find((c) => containerKey(c.ref) === containerKey(f.container))?.name ?? f.container.externalId}`;
    case "parent":
      return `Under ${lookup.items?.find((i) => itemKey(i.item) === itemKey(f.item))?.title ?? f.item.key}`;
    case "label":
      return `Label: ${f.label}`;
    case "text":
      return `“${f.text}”`;
    case "items":
      return `${f.items.length} picked`;
    case "code":
      return CODE_FILTER_LABEL[f.check];
    case "and":
      return f.filters.length ? f.filters.map((g) => describeFilter(g, lookup)).join(", ") : "Everything";
  }
}
