import type { Run } from "../types";

/**
 * The ids in the order to show them. Unfrozen that is `sorted`; frozen, the ids already shown keep their places (the ones
 * that are gone drop out) and the new ones follow in their sorted order, so nothing moves under the person's pointer or focus.
 */
export function stableOrder(previous: readonly string[], sorted: readonly string[], frozen: boolean): string[] {
  if (!frozen) return [...sorted];
  const now = new Set(sorted);
  const kept = previous.filter((id) => now.has(id));
  const had = new Set(kept);
  return [...kept, ...sorted.filter((id) => !had.has(id))];
}

/**
 * Groups of runs (lanes or workstreams) as they should show. Unfrozen that is `fresh`. Frozen, every run stays in the group
 * and the place it was shown in, with its current data; runs that are gone drop out, groups left empty go, and new runs
 * join their group at its end (a group that is new comes last).
 */
export function stableGroups<G extends { runs: Run[] }>(previous: readonly G[], fresh: readonly G[], frozen: boolean, keyOf: (g: G) => string): G[] {
  if (!frozen) return [...fresh];
  const byId = new Map(fresh.flatMap((g) => g.runs).map((r) => [r.id, r]));
  const freshOf = new Map(fresh.map((g) => [keyOf(g), g]));
  const shownBefore = new Set(previous.flatMap((g) => g.runs.map((r) => r.id)));
  const out: G[] = [];
  const seen = new Set<string>();
  for (const g of previous) {
    const key = keyOf(g);
    seen.add(key);
    const now = freshOf.get(key);
    const joining = (now?.runs ?? []).filter((r) => !shownBefore.has(r.id));
    const ids = stableOrder(g.runs.map((r) => r.id), [...g.runs.map((r) => r.id).filter((id) => byId.has(id)), ...joining.map((r) => r.id)], true);
    if (ids.length) out.push({ ...(now ?? g), runs: ids.map((id) => byId.get(id) as Run) });
  }
  for (const g of fresh) {
    const runs = g.runs.filter((r) => !shownBefore.has(r.id));
    if (!seen.has(keyOf(g)) && runs.length) out.push({ ...g, runs });
  }
  return out;
}
