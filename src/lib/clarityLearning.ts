import type { ClarityGap } from "./ticketClarity";

/**
 * What Gossamr learns from "Looks fine": the person says a ticket looks clear enough, and each gap the notice named
 * counts once for the ticket's Jira project. Once the same gap has been dismissed `LEARN_AFTER` times in one project, the
 * page stops flagging that gap for it, until the person gives that back. It only filters what the notice and Start my day
 * say; the word check itself (`clarityGaps`) is unchanged, and Core's own check and audit don't depend on it.
 */

/** How many times the same gap is dismissed in one project before it is no longer flagged there. */
export const LEARN_AFTER = 3;

/** The dismissals counted so far, by project key then gap. */
export type ClarityLearning = Record<string, Partial<Record<ClarityGap, number>>>;

const GAPS: readonly ClarityGap[] = ["empty", "short", "done", "scope", "who"];

/** The Jira project a ticket key belongs to: its letters before the dash ("CA-408" is "CA"). */
export const projectOfKey = (key: string): string => key.split("-")[0].trim().toUpperCase();

/** The stored learning, read defensively: anything that isn't a count of a known gap is dropped. */
export function parseLearning(raw: unknown): ClarityLearning {
  const out: ClarityLearning = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [project, counts] of Object.entries(raw)) {
    if (typeof counts !== "object" || counts === null) continue;
    const kept: Partial<Record<ClarityGap, number>> = {};
    for (const gap of GAPS) {
      const n = (counts as Record<string, unknown>)[gap];
      if (typeof n === "number" && Number.isInteger(n) && n > 0) kept[gap] = Math.min(n, 99);
    }
    if (Object.keys(kept).length) out[project.toUpperCase()] = kept;
  }
  return out;
}

/** The gaps no longer flagged for `project`: dismissed `LEARN_AFTER` times or more. */
export const ignoredGaps = (learning: ClarityLearning, project: string): ClarityGap[] => GAPS.filter((g) => (learning[project]?.[g] ?? 0) >= LEARN_AFTER);

/** `gaps` without the ones learned for `project`: what the notice and Start my day still say. */
export const flaggedGaps = (gaps: readonly ClarityGap[], learning: ClarityLearning, project: string): ClarityGap[] => {
  const skip = ignoredGaps(learning, project);
  return gaps.filter((g) => !skip.includes(g));
};

/** The learning after one "Looks fine" on a ticket of `project` whose notice named `gaps`, and the gaps that reached `LEARN_AFTER` just now. */
export function dismissed(learning: ClarityLearning, project: string, gaps: readonly ClarityGap[]): { learning: ClarityLearning; learned: ClarityGap[] } {
  const counts = { ...(learning[project] ?? {}) };
  const learned: ClarityGap[] = [];
  for (const g of new Set(gaps)) {
    const n = (counts[g] ?? 0) + 1;
    counts[g] = Math.min(n, 99);
    if (n === LEARN_AFTER) learned.push(g);
  }
  return { learning: { ...learning, [project]: counts }, learned };
}

/** The learning with `project`'s (or everything's, with none named) counts forgotten; with `gaps`, only those gaps' counts of `project`. */
export function forget(learning: ClarityLearning, project?: string, gaps?: readonly ClarityGap[]): ClarityLearning {
  if (!project) return {};
  const { [project]: counts, ...rest } = learning;
  if (!gaps || !counts) return rest;
  const kept = Object.fromEntries(Object.entries(counts).filter(([g]) => !gaps.includes(g as ClarityGap)));
  return Object.keys(kept).length ? { ...rest, [project]: kept } : rest;
}

/** The gaps among `gaps` that are not flagged for `project` because "Looks fine" taught them away: what a workstream's quiet "Not flagged" note names. */
export const ignoredAmong = (gaps: readonly ClarityGap[], learning: ClarityLearning, project: string): ClarityGap[] => {
  const skip = ignoredGaps(learning, project);
  return gaps.filter((g) => skip.includes(g));
};

/** Each gap in a few words, for Settings and the "Not flagged" note, where the long `gapWords` don't fit. */
export const SHORT_GAP: Record<ClarityGap, string> = {
  empty: "no description",
  short: "short description",
  done: "no \"done\" criteria",
  scope: "no scope",
  who: "no \"who is waiting\"",
};

/** `gaps` in `SHORT_GAP` words as one phrase: "short description", "short description and no scope", "a, b and c". */
export function gapList(gaps: readonly ClarityGap[]): string {
  const words = gaps.map((g) => SHORT_GAP[g]);
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The projects that have something learned, with what: for Settings, which offers to give each back. */
export function learnedList(learning: ClarityLearning): { project: string; gaps: ClarityGap[] }[] {
  return Object.keys(learning)
    .sort()
    .map((project) => ({ project, gaps: ignoredGaps(learning, project) }))
    .filter((l) => l.gaps.length > 0);
}

/** The audit's detail for a learned gap: `who in CA`; and its words back. */
export const learnedDetail = (gap: ClarityGap, project: string) => `${gap} in ${project}`;

/** What an audit line's detail (`who in CA`) says in words: "CA tickets that don't say who is waiting on them". */
export function learnedWords(detail: string | null): string {
  const m = /^(\w+) in (\S+)$/.exec(detail ?? "");
  if (!m || !GAPS.includes(m[1] as ClarityGap)) return "a gap";
  return `${m[2]} tickets that ${TICKETS_THAT[m[1] as ClarityGap]}`;
}

const TICKETS_THAT: Record<ClarityGap, string> = {
  empty: "have no description",
  short: "have a very short description",
  done: "don't say what done looks like",
  scope: "don't say what's in or out of scope",
  who: "don't say who is waiting on them",
};

/** One gap in words, as it follows "tickets that": for Settings and the toast. */
export const gapWords = (gap: ClarityGap) => TICKETS_THAT[gap];
