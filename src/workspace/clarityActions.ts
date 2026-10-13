import { learnedList, projectOfKey } from "../lib/clarityLearning";
import { useWorkspace } from "../workspaceStore";
import { usePrefs } from "./prefs";
import { useToasts } from "./toasts";
import { useWorkstreams } from "./workstreamsStore";

/**
 * Gives back what "Looks fine" taught the clarity notice: for one Jira project, or (with none named) all of them. The page
 * flags those gaps again from now on. It is audited in an open workstream of each project it reset (`clarity_reset`), where
 * there is one: the audit is kept per workstream, and the learning itself is the page's, in its prefs. Returns how many projects it reset.
 */
export async function giveBackClarity(project?: string): Promise<number> {
  const prefs = usePrefs.getState();
  const projects = learnedList(prefs.clarityLearning).filter((l) => !project || l.project === project);
  if (!projects.length) {
    useToasts.getState().push("Gossamr hasn't learned anything from Looks fine yet.", "info");
    return 0;
  }
  prefs.resetClarityLearning(project);
  const ws = useWorkstreams.getState();
  const backend = ws.backend ?? useWorkspace.getState().backend;
  for (const { project: p } of projects) {
    const open = ws.list.find((v) => v.workstream.closedAt === null && v.workstream.itemKey && projectOfKey(v.workstream.itemKey) === p);
    if (open && backend) await backend.workstreamsClarityNote(open.workstream.id, "clarity_reset", p).catch(() => {});
  }
  if (backend) await ws.refresh().catch(() => {});
  useToasts.getState().push(project ? `Gossamr will flag unclear ${project} tickets as before.` : "Gossamr will flag unclear tickets as before in every project.", "info");
  return projects.length;
}
