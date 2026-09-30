import { and } from "../lib/filter";
import type { WorkFilter } from "../types";
import type { ItemScene } from "./pipScene";
import type { Route } from "./tabsStore";

export type NudgeKind = "empty-filter" | "large-list" | "unassigned-view" | "waiting" | "blocked" | "stale" | "unowned";

export type NudgeAction = { type: "open" } | { type: "ask"; prompt: string } | { type: "filter"; filter: WorkFilter; note: string };

export interface Nudge {
  /** What dismissal is remembered under: the kind, plus the ticket for the ones about a ticket. */
  id: string;
  kind: NudgeKind;
  text: string;
  action: NudgeAction;
}

export interface NudgeScene {
  route: Route;
  filter: WorkFilter;
  count: number;
  chips: number;
  item: ItemScene | null;
  unassignedInView: number;
}

export const LARGE_LIST = 25;
export const UNASSIGNED_WORTH_A_NUDGE = 3;

/** Wait this long on the same screen before a suggestion appears, so browsing past tickets stays quiet. */
export const NUDGE_DWELL_MS = 1200;
/** At least this long between one suggestion appearing and the next. */
export const NUDGE_GAP_MS = 30_000;
export const NUDGE_SHOWN_MS = 9000;
const MAX_REMEMBERED = 200;

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

function forTicket(i: ItemScene): Nudge[] {
  if (!i.open) return [];
  const at = (kind: NudgeKind, text: string, prompt: string): Nudge => ({ id: `${kind}:${i.key}`, kind, text, action: { type: "ask", prompt } });
  return [
    ...(i.waitingOn ? [at("waiting", `${i.waitingOn} is waiting on you in ${i.key}. Want a reply drafted?`, `Draft a reply on ${i.key}`)] : []),
    ...(i.blockedBy ? [at("blocked", `${i.key} is blocked by ${i.blockedBy}. Want to see the chain?`, `What is blocking ${i.key}, and who can unblock it?`)] : []),
    ...(i.staleDays !== null ? [at("stale", `${i.key} has been quiet for ${days(i.staleDays)}. Want a nudge drafted?`, `Draft a nudge on ${i.key}`)] : []),
    ...(i.unassigned ? [at("unowned", `${i.key} has no owner yet. Want a suggestion for who should take it?`, `Who should own ${i.key}?`)] : []),
  ];
}

/** Every suggestion that fits what is on screen, most useful first. */
export function nudgeCandidates(s: NudgeScene): Nudge[] {
  if (s.item) return forTicket(s.item);
  if (s.route !== "workspace") return [];
  const out: Nudge[] = [];
  if (s.count === 0 && s.chips > 0) out.push({ id: "empty-filter", kind: "empty-filter", text: "Nothing matches this filter. Want me to find what you meant?", action: { type: "open" } });
  if (s.unassignedInView >= UNASSIGNED_WORTH_A_NUDGE)
    out.push({
      id: "unassigned-view",
      kind: "unassigned-view",
      text: `${s.unassignedInView} tickets here have no owner. Want me to show them?`,
      action: { type: "filter", filter: and(s.filter, { type: "unassigned" }), note: "Tickets with no owner" },
    });
  if (s.count >= LARGE_LIST)
    out.push({ id: "large-list", kind: "large-list", text: "I can help you filter tasks in this view. Just tell me what to show.", action: { type: "open" } });
  return out;
}

/** The first candidate the person hasn't closed and hasn't already been shown this session. */
export const pickNudge = (candidates: readonly Nudge[], dismissed: readonly string[], seen: readonly string[]): Nudge | null =>
  candidates.find((n) => !dismissed.includes(n.id) && !seen.includes(n.id)) ?? null;

/** How long to hold a suggestion back: the dwell on the screen, stretched to keep the gap since the last one. */
export const nudgeDelay = (now: number, lastShownAt: number): number => Math.max(NUDGE_DWELL_MS, lastShownAt + NUDGE_GAP_MS - now);

export const remember = (list: readonly string[], id: string): string[] => (list.includes(id) ? [...list] : [...list, id].slice(-MAX_REMEMBERED));
