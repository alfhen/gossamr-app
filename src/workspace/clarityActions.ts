import { learnedDetail, learnedList, projectOfKey, SHORT_GAP } from "../lib/clarityLearning";
import type { Proposal } from "../types";
import type { ClarityGap } from "../lib/ticketClarity";
import { useWorkspace } from "../workspaceStore";
import { usePrefs } from "./prefs";
import { PIP_INPUT_ID } from "./draftKeys";
import { useWorkView } from "./workViewStore";
import { pushLearning, retireLearning, useToasts } from "./toasts";
import { useWorkstreams } from "./workstreamsStore";

/**
 * The clarity notice unmounts with the button that was pressed (Looks fine, Ask the reporter now, Flag again) and the keyboard
 * would fall to <body>. Once the page has settled, when it has, the keyboard goes to the comment to the reporter that Ask the
 * reporter now drafted, else to what is left of the notice: the quiet note's Flag again, a notice that came back, else the
 * workstream's other buttons, never its Manage switch (a toggle that would be flipped by the next Space). Focus that already moved on is left alone.
 */
export function settleClarityFocus(workstreamId: string) {
  let frames = 0;
  const settle = () => {
    const at = document.activeElement;
    if (at && at !== document.body && at.isConnected) return;
    const id = CSS.escape(workstreamId);
    const box = document.querySelector<HTMLElement>(`[data-workstream-controls="${id}"]`);
    const deciding = useWorkView.getState().deciding;
    const draft = deciding?.startsWith("draft:") ? document.querySelector<HTMLElement>(`article[data-draft="${CSS.escape(deciding.slice("draft:".length))}"]`) : null;
    const next = draft ?? document.querySelector<HTMLElement>(`[data-clarity-quiet="${id}"] button, [data-clarity-notice="${id}"] button`) ?? box?.querySelector<HTMLElement>("button, input:not([role=switch])");
    if (next) next.focus();
    else if (++frames < 3) requestAnimationFrame(settle);
  };
  requestAnimationFrame(() => requestAnimationFrame(settle));
}

/** The pending drafts to start an agent that are not among `before`, on ticket `key` when one is named, newest last. */
export function newStartDrafts(before: ReadonlySet<string>, proposals: Record<string, Proposal>, key?: string): string[] {
  return Object.values(proposals)
    .filter((p) => p.intent.type === "startRun" && p.state.type === "pending" && !before.has(p.id) && (!key || p.intent.item?.key === key))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((p) => p.id);
}

/** The ticket an Investigate chip names ("Investigate CA-408" is CA-408), if it names one. */
export const investigateKey = (chip: string): string | undefined => /^Investigate (\S+)$/.exec(chip)?.[1];

/** How long the keyboard waits on the composer for the draft an Investigate chip asked for: as long as Pip's answer may take. */
export const DRAFT_WAIT_MS = 60_000;

/**
 * A suggestion chip that asked Pip to start something (Investigate CA-408) unmounts when pressed, and the keyboard would
 * fall to <body>: it goes to the composer at once, and to the new "Start an agent" draft's card once that renders, if the
 * person has not moved or typed since. It waits as long as Pip may take to answer (`DRAFT_WAIT_MS`), then the composer keeps it.
 */
export function settleDraftFocus(before: ReadonlySet<string>, key?: string, doc: Document = document, frame: (cb: () => void) => unknown = requestAnimationFrame, now: () => number = Date.now, waitMs = DRAFT_WAIT_MS) {
  const composer = () => doc.getElementById(PIP_INPUT_ID) as HTMLInputElement | null;
  const parked = () => {
    const at = doc.activeElement;
    return !at || at === doc.body || (at === composer() && !composer()?.value);
  };
  composer()?.focus();
  const until = now() + waitMs;
  const watch = () => {
    if (!parked()) return;
    // The draft is the one on the ticket the chip named: another ticket's new draft is not where the person was going.
    const id = newStartDrafts(before, useWorkspace.getState().proposals, key)[0];
    const card = id ? doc.querySelector<HTMLElement>(`article[data-draft="${CSS.escape(id)}"]`) : null;
    if (card) card.focus();
    else if (now() < until) frame(watch);
  };
  frame(watch);
}

/**
 * Gives back what "Looks fine" taught the clarity notice: for one Jira project, or (with none named) all of them. The page
 * flags those gaps again from now on. It is audited in an open workstream of each project it reset (`clarity_reset`), where
 * there is one: the audit is kept per workstream, and the learning itself is the page's, in its prefs. Returns how many projects it reset.
 * With `gaps` (and a `project`) only those gaps are given back, each audited as `clarity_reset` with its own detail (`who in CA`).
 */
export async function giveBackClarity(project?: string, gaps?: readonly ClarityGap[]): Promise<number> {
  const prefs = usePrefs.getState();
  const some = (g: readonly ClarityGap[]) => !gaps || g.some((x) => gaps.includes(x));
  const projects = learnedList(prefs.clarityLearning).filter((l) => (!project || l.project === project) && some(l.gaps));
  const given = (p: string) => (gaps ? (learnedList(prefs.clarityLearning).find((l) => l.project === p)?.gaps ?? []).filter((g) => gaps.includes(g)) : []);
  if (!projects.length) {
    useToasts.getState().push("Gossamr hasn't learned anything from Looks fine yet.", "info");
    return 0;
  }
  const ws = useWorkstreams.getState();
  const backend = ws.backend ?? useWorkspace.getState().backend;
  // Where there is an open workstream the audit line is written first, and the learning is given back only once it is
  // there: a reset with no record of it is worse than one that has to be tried again. With no open workstream there is
  // nowhere to write it, so the page's prefs are cleared with no audit, as documented above.
  const reset: string[] = [];
  const failed: string[] = [];
  for (const { project: p } of projects) {
    const open = ws.list.find((v) => v.workstream.closedAt === null && v.workstream.itemKey && projectOfKey(v.workstream.itemKey) === p);
    if (open) {
      if (!backend) {
        failed.push(p);
        continue;
      }
      try {
        // One line per gap given back, or one for the project when all of it is.
        for (const g of gaps ? given(p) : [null]) await backend.workstreamsClarityNote(open.workstream.id, "clarity_reset", g ? learnedDetail(g, p) : p);
      } catch {
        failed.push(p);
        continue;
      }
    }
    reset.push(p);
  }
  // Everything is reset at once when nothing failed, which also drops the counts not yet learned; otherwise only what was audited.
  if (gaps) for (const p of reset) prefs.resetClarityLearning(p, gaps);
  else if (!failed.length) prefs.resetClarityLearning(project);
  else for (const p of reset) prefs.resetClarityLearning(p);
  if (backend && reset.length) await ws.refresh().catch(() => {});
  // What it said it learned is no longer so: a note still waiting to say it would contradict the one below.
  // Only for the projects that were reset: one whose audit write failed still stands as learned.
  retireLearning(reset);
  if (failed.length) useToasts.getState().push(`Couldn't note the reset in the audit, so ${failed.join(", ")} wasn't reset. Try again.`, "error");
  if (reset.length && gaps && project) pushLearning(project, `Gossamr will flag ${project} tickets with ${gaps.map((g) => SHORT_GAP[g]).join(" or ")} as before.`);
  // "Every project" only when every project was reset: one whose audit write failed keeps what it learned.
  // About every project it reset, so a later note about any of them takes its place.
  else if (reset.length) pushLearning(reset, project ? `Gossamr will flag new unclear ${project} tickets as before.` : failed.length ? `Gossamr will flag new unclear ${reset.join(", ")} tickets as before.` : "Gossamr will flag new unclear tickets as before in every project.");
  return reset.length;
}
