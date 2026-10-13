import { learnedDetail, learnedList, projectOfKey, SHORT_GAP } from "../lib/clarityLearning";
import type { ClarityGap } from "../lib/ticketClarity";
import { useWorkspace } from "../workspaceStore";
import { usePrefs } from "./prefs";
import { useToasts } from "./toasts";
import { useWorkstreams } from "./workstreamsStore";

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
  const toasts = useToasts.getState();
  // What it said it learned is no longer so: a note still waiting to say it would contradict the one below.
  for (const t of toasts.toasts.filter((x) => x.text.startsWith(`Gossamr will stop flagging ${project ? `${project} ` : ""}`))) toasts.dismiss(t.id);
  if (failed.length) toasts.push(`Couldn't note the reset in the audit, so ${failed.join(", ")} wasn't reset. Try again.`, "error");
  if (reset.length && gaps && project) toasts.push(`Gossamr will flag ${project} tickets with ${gaps.map((g) => SHORT_GAP[g]).join(" or ")} as before.`, "info");
  else if (reset.length) toasts.push(project ? `Gossamr will flag unclear ${project} tickets as before.` : "Gossamr will flag unclear tickets as before in every project.", "info");
  return reset.length;
}
