/**
 * A free, deterministic check of a ticket's description for what a plan needs: what done looks like, what is in and out of
 * scope, and who is waiting on it. It reads words, never judges, and runs no agent: it only makes Pip and the page speak up
 * early about a ticket that looks thin. The Triage's verdict (`Ready to plan:`) stays the authority. As `clarity_gaps` in
 * src-tauri/src/domain/clarity.rs; both run `ticketClarity.fixtures.json`.
 */

/** One thing a ticket's description leaves out. `empty` stands alone: a description that isn't there has nothing to read. */
export type ClarityGap = "empty" | "short" | "done" | "scope" | "who";

/** A description shorter than this (trimmed, in characters) is very short. */
export const SHORT_LIMIT = 80;

const DONE_WORDS = ["acceptance", "criteria", "done when", "definition of done", "should", "must", "checklist"];
const SCOPE_WORDS = ["scope", "out of", "only", "not include", "won't", "exclude", "excluding", "non-goal"];
const WHO_WORDS = ["asked", "requested", "waiting", "stakeholder", "needs it", "needed by", "team", "customer"];
const CHECKLIST = ["[ ]", "[x]", "☐", "☑"];

const alnum = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Whether `word` is in `text` (lower case) as whole words, not inside a longer word. */
function hasWord(text: string, word: string): boolean {
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    const before = [...text.slice(0, at)].pop();
    const after = [...text.slice(at + word.length)][0];
    if (!alnum(before) && !alnum(after)) return true;
  }
  return false;
}

const mentions = (text: string, words: readonly string[]) => words.some((w) => hasWord(text, w));

/** What the description `text` of a ticket leaves out, in the order the gaps are listed: none when it says all three. */
export function clarityGaps(text: string | null | undefined): ClarityGap[] {
  const t = (text ?? "").trim();
  if (!t) return ["empty"];
  const lower = t.toLowerCase();
  const gaps: ClarityGap[] = [];
  if ([...t].length < SHORT_LIMIT) gaps.push("short");
  if (!mentions(lower, DONE_WORDS) && !CHECKLIST.some((c) => lower.includes(c))) gaps.push("done");
  if (!mentions(lower, SCOPE_WORDS)) gaps.push("scope");
  if (!mentions(lower, WHO_WORDS)) gaps.push("who");
  return gaps;
}

const PHRASE: Record<ClarityGap, string> = {
  empty: "has no description",
  short: "has a very short description",
  done: "doesn't say what done looks like",
  scope: "doesn't say what's in or out of scope",
  who: "doesn't say who is waiting on it",
};

const QUESTION: Record<ClarityGap, string> = {
  empty: "What is the goal?",
  short: "What is the goal?",
  done: "What has to be true for this to be done (the acceptance criteria)?",
  scope: "What is in scope, and what is out?",
  who: "Who asked for it, and who is waiting on it?",
};

/** The gaps as one phrase after "it": `has no description`, or `doesn't say a, doesn't say b, and doesn't say c`. */
export function gapsPhrase(gaps: readonly ClarityGap[]): string {
  const p = gaps.map((g) => PHRASE[g]);
  if (p.length <= 1) return p[0] ?? "";
  if (p.length === 2) return `${p[0]} and ${p[1]}`;
  return `${p.slice(0, -1).join(", ")}, and ${p[p.length - 1]}`;
}

/** What the notice on a workstream says: `CA-408 may be unclear: it has a very short description and doesn't say …`. */
export const clarityText = (key: string, gaps: readonly ClarityGap[]) => `${key} may be unclear: it ${gapsPhrase(gaps)}.`;

/** What the notice says once the reporter answered on the ticket (`WorkstreamView.reporterReplied`) and the thin description is still thin: the answer, not the gaps, is news. */
export const clarityRepliedText = (key: string) => `${key}: the reporter replied; read it, then Looks fine or ask again.`;

/** What "Ask the reporter now" asks: one question per gap, none twice; an empty description asks all four things a ticket needs. */
export function clarityQuestions(gaps: readonly ClarityGap[]): string[] {
  const wanted: readonly ClarityGap[] = gaps.includes("empty") ? ["short", "done", "scope", "who"] : gaps;
  return [...new Set(wanted.map((g) => QUESTION[g]))];
}
