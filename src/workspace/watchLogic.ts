import { containerKey } from "../lib/filter";
import type { CatalogEntry, ConnectionInfo, ContainerRef, Footprint, Stray, WatchChange, WatchRow, WatchState, WorkContainer } from "../types";

export const GRACE_DAYS = 14;
export const RAIL_BADGES = 8;
const DAY_MS = 86_400_000;

export interface Noun {
  one: string;
  many: string;
}

const NOUNS: Record<string, Noun> = {
  jira: { one: "project", many: "projects" },
  mock: { one: "project", many: "projects" },
};

/** What a connection calls its containers, so shared components never hard-code a tracker's word. */
export const nounFor = (kind: ConnectionInfo["kind"] | string | undefined): Noun => NOUNS[kind ?? ""] ?? { one: "container", many: "containers" };

export const count = (n: number, noun: Noun) => `${n} ${n === 1 ? noun.one : noun.many}`;

export function toggled(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

export const suggestedIds = (suggestions: readonly Footprint[]): Set<string> => new Set(suggestions.map((f) => f.container.externalId));

/** The hints under a suggested row, such as "4 assigned · 2 reported". */
export function activityHint(f: Footprint): string | null {
  const parts = [
    f.assigned && `${f.assigned} assigned`,
    f.reported && `${f.reported} reported`,
    f.watching && `${f.watching} watching`,
    f.commented && `${f.commented} commented`,
    f.mentioned && `${f.mentioned} mentioned`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The changes that start watching `selected`. The suggested ones come first and are pinned first, up to `pinLimit`. */
export function choiceChanges(selected: Iterable<string>, suggestions: readonly Footprint[], pinLimit = RAIL_BADGES): WatchChange[] {
  const chosen = new Set(selected);
  const fromFootprint = suggestions.map((f) => f.container.externalId).filter((id) => chosen.has(id));
  const rest = [...chosen].filter((id) => !fromFootprint.includes(id));
  const fp = new Set(fromFootprint);
  return [...fromFootprint, ...rest].map((containerId, i) => ({ containerId, watched: true, pinned: i < pinLimit, source: fp.has(containerId) ? "footprint" : "manual" }));
}

export function mergeEntries(have: readonly CatalogEntry[], more: readonly CatalogEntry[]): CatalogEntry[] {
  const seen = new Set(have.map((e) => e.ref.externalId));
  return [...have, ...more.filter((e) => !seen.has(e.ref.externalId))];
}

/** Whole days left before an unwatched container's cached data is removed; 0 on the last day. */
export function graceDaysLeft(unwatchedAt: string, now: Date): number {
  const elapsed = (now.getTime() - new Date(unwatchedAt).getTime()) / DAY_MS;
  return Math.min(GRACE_DAYS, Math.max(0, Math.ceil(GRACE_DAYS - elapsed)));
}

export function graceLine(days: number): string {
  return days === 0 ? "Unwatched, removed from sync today" : `Unwatched, removed from sync in ${days} ${days === 1 ? "day" : "days"}`;
}

export interface SettingsRow {
  container: ContainerRef;
  key: string;
  name: string;
  depth: WatchRow["depth"];
  pinned: boolean;
  unwatchedAt: string | null;
  inaccessible: boolean;
  cachedItems: number;
}

const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);

/** The rows Settings lists: watched ones by key, then those in their grace period. In everything mode the watched containers without a row of their own are listed too. */
export function settingsRows(state: WatchState, containers: readonly WorkContainer[], cachedItems: (c: ContainerRef) => number = () => 0): SettingsRow[] {
  const rows: SettingsRow[] = state.watches.map((w) => ({
    container: w.container,
    key: w.key,
    name: w.name,
    depth: w.depth,
    pinned: w.pinned,
    unwatchedAt: w.unwatchedAt,
    inaccessible: w.inaccessible,
    cachedItems: w.cachedItems,
  }));
  if (state.mode !== "selected") {
    const have = new Set(rows.map((r) => containerKey(r.container)));
    for (const c of containers) {
      if (c.ref.connectionId !== state.connectionId || have.has(containerKey(c.ref))) continue;
      rows.push({ container: c.ref, key: c.key, name: c.name, depth: "involved", pinned: false, unwatchedAt: null, inaccessible: false, cachedItems: cachedItems(c.ref) });
    }
  }
  const active = rows.filter((r) => r.unwatchedAt === null).sort(byKey);
  const grace = rows.filter((r) => r.unwatchedAt !== null).sort((a, b) => b.unwatchedAt!.localeCompare(a.unwatchedAt!));
  return [...active, ...grace];
}

export function matchesQuery(r: { key: string; name: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || r.key.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
}

/** Suggestions the person isn't watching yet, for the chips in Settings. */
export function suggestionChips(suggestions: readonly Footprint[], watched: ReadonlySet<string>, limit = 6): Footprint[] {
  return suggestions.filter((f) => !watched.has(f.container.externalId)).slice(0, limit);
}

export interface RailSplit {
  badges: WorkContainer[];
  rest: WorkContainer[];
}

/**
 * Pinned containers become badges. With none pinned, the first `limit` stand in so the rail is never empty. The one on
 * screen always gets a badge.
 */
export function railSplit(containers: readonly WorkContainer[], watch: readonly WatchState[], current: ContainerRef | null, limit = RAIL_BADGES): RailSplit {
  const sorted = [...containers].sort(byKey);
  const pinned = new Set(watch.flatMap((w) => w.watches.filter((r) => r.pinned && r.unwatchedAt === null).map((r) => containerKey(r.container))));
  let badges = sorted.filter((c) => pinned.has(containerKey(c.ref)));
  if (!badges.length) badges = sorted.slice(0, limit);
  const showing = current && sorted.find((c) => containerKey(c.ref) === containerKey(current));
  if (showing && !badges.includes(showing)) badges = [...badges, showing];
  return { badges, rest: sorted.filter((c) => !badges.includes(c)) };
}

export function strayText(s: Stray): string {
  const first = s.keys[0] ?? "a ticket";
  const what = s.keys.length > 1 ? `${first} and ${s.keys.length - 1} more` : first;
  return `You were assigned ${what} in ${s.containerName}, which you're not watching`;
}

/** Strays that are new, or have more tickets than before. */
export function newStrays(before: readonly Stray[], after: readonly Stray[]): Stray[] {
  const had = new Map(before.map((s) => [containerKey(s.container), s.keys.length]));
  return after.filter((s) => s.keys.length > (had.get(containerKey(s.container)) ?? 0));
}

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** The upper-cased key when the text looks like a ticket key, such as "web-101". */
export const ticketKeyOf = (text: string): string | null => (KEY_PATTERN.test(text.trim()) ? text.trim().toUpperCase() : null);
