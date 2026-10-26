import { readAs } from "../lib/permission";
import type { Need } from "../lib/needs";
import { useWorkspace } from "../workspaceStore";
import { draftKeyAction } from "./draftKeys";
import { liveDraft } from "./draftLive";
import { keptEditsOfDraft } from "./DraftCard";
import { draftDecisions } from "./DraftPreview";
import { inlineStartable, useInlineStarts } from "./InlineStart";
import { NO_WORKSTREAM_ID, setPaneIntent, takePaneIntent, useWorkView } from "./workViewStore";
import { usePrefs } from "./prefs";
import { ALL } from "./agentsLogic";
import { useRuns } from "./runsStore";
import { currentNeeds } from "./useNeeds";
import { useTabs } from "./tabsStore";
import { useWorkstreams } from "./workstreamsStore";
import { useToasts } from "./toasts";

/**
 * What the Needs you list's keys and buttons do. Everything here reaches the stores through the same commands the cards
 * use (`draftDecisions`, the runs store, the workstreams store), so a decision made from the list is the one the card makes.
 */

/** The id a workstream has in the Needs you stack and the detail: its own, or the one for no workstream. */
export const groupId = (workstreamId: string | null) => workstreamId ?? NO_WORKSTREAM_ID;

/** Leaves the peek and shows the Agents view, from any other route. */
function showAgents() {
  const tabs = useTabs.getState();
  if (tabs.route !== "agents") tabs.setRoute("agents");
  else if (tabs.selected !== null) tabs.select(null);
}

/** The Agents view with the Needs you filter on and the detail of workstream `workstreamId` (null: No workstream) open. */
export function showGroup(workstreamId: string | null) {
  showAgents();
  // Needs are the workstreams' own: the State grouping has no heading to find them under.
  usePrefs.getState().setAgentsGroup("workstream");
  useRuns.getState().setFilter({ needs: true, lane: ALL });
  useWorkView.getState().openWorkstream(groupId(workstreamId));
}

/**
 * Opens need `need`'s decision: the Agents view with the Needs you filter on, the need's workstream (or No workstream) open
 * with the need open at the top of its detail. The rail's popover, a notification, a run's pill and the palette all end here.
 */
export function openNeed(need: Need, opts: { edit?: boolean } = {}) {
  showGroup(need.workstreamId);
  const view = useWorkView.getState();
  // The intent is read by the need as it opens; one already open is remounted to read it.
  setPaneIntent(opts.edit ? "edit" : "card");
  const open = view.deciding === need.key;
  view.decide(need.key);
  if (open) (opts.edit ? view.redecide : view.refocus)();
}

/**
 * Shows what the need is about where it lives: its workstream's detail (No workstream's for a need outside any), the card
 * brought into view, the run's sheet over it for a run. It decides nothing itself and leaves the filters as they are.
 */
export function openInWorkstream(need: Need) {
  showAgents();
  const view = useWorkView.getState();
  view.openWorkstream(groupId(need.workstreamId));
  if (need.workstreamId) view.focus(need.target);
  if (need.target.type === "run") useRuns.getState().openRun(need.target.id, { stay: true });
}

/** A run from a notification: its need when it holds one, else its sheet. */
export function openRunOrNeed(runId: string) {
  const need = currentNeeds().find((n) => n.runId === runId);
  if (need) openNeed(need);
  else useRuns.getState().openRun(runId);
}

/**
 * The keys of the list that act on a need, as the one model names them (`keyMap.ts`): a approves or allows its primary, d
 * dismisses or denies, s skips a draft, e edits.
 */
export type NeedKey = "approve" | "dismiss" | "skip" | "edit";

/**
 * What a key does: asks for Enter first (`ask`), acts at once (`do`: what can be undone, which offers Undo as it does), or
 * opens the decision, with the pane's first move (`open`).
 */
export type KeyPlan = { type: "ask"; text: string; run(): void } | { type: "do"; run(): void } | { type: "open"; edit: boolean; /** Why a key that approves opened the card instead: said aloud, so the key does not read as dead. */ note?: string };

/** What a (approve) says when it opens a draft's card rather than asking for Enter: the card holds an edit, or its words would stop at the posting pause. */
export const OPENED_NOT_POSTED = "Not posted. This draft holds an edit or would pause, so its card opens to read first.";

/** Says `plan.note`, if it has one, as a status; for the keys that open a card where they would otherwise have approved. */
export function sayOpenNote(plan: KeyPlan): void {
  if (plan.type === "open" && plan.note) useToasts.getState().push(plan.note, "info");
}

const proposalOf = (need: Need) => (need.target.type === "draft" ? useWorkspace.getState().proposals[need.target.id] : undefined);
const runOf = (need: Need) => (need.runId ? useRuns.getState().runs.find((r) => r.id === need.runId) : undefined);

/**
 * Whether approving `p` from the list would skip what its card shows: the card holds an edit the draft doesn't, or the words
 * would stop at the posting pause. A card not on screen counts its kept edits.
 */
function needsCard(p: NonNullable<ReturnType<typeof proposalOf>>): boolean {
  const live = liveDraft(p.id);
  if (live) return live.edited || live.risky;
  // Words typed into a card that has since closed are kept for it, and only the card posts them.
  return !!keptEditsOfDraft(p.id);
}

/** "this comment", "this move": what an approval would approve, for the line that asks for Enter. */
const thing = (need: Need) => (need.kind === "question" ? "this reply" : need.kind === "review" ? "this review" : "this draft");

/**
 * What key `which` does on `need`. Anything that writes, posts, starts or answers an agent asks for Enter first, as a draft's
 * own card does ("a" then Enter): any other key cancels. Skipping a draft and dismissing a run touch nothing outside Gossamr,
 * so they act at once and offer Undo. What needs reading before it is decided (a rewrite's diff, a run's prompt) or has nothing to write opens its decision instead. Null when the key means nothing here.
 */
export function keyPlan(need: Need, which: NeedKey): KeyPlan | null {
  const all = [need.primary, ...need.secondary];
  const p = proposalOf(need);
  const run = runOf(need);
  if (which === "edit") return all.some((a) => a.id === "edit") || need.primary.id === "answer" ? { type: "open", edit: true } : null;
  if (which === "approve") {
    switch (need.primary.id) {
      case "approve":
        // A draft its card approves in place (unless the card holds an edit or a pause, which only the card's own Post handles); a rewrite, a review the token can't be known to post and the rest open.
        if (p && draftKeyAction(p, "a") === "approve" && !needsCard(p)) {
          const decide = draftDecisions(p.id, p);
          return { type: "ask", text: `${need.kind === "question" ? "send" : "approve"} ${thing(need)}`, run: decide.approve };
        }
        // An edit or a pause is why a approves nothing here: the card does, so say so.
        return { type: "open", edit: false, ...(p && draftKeyAction(p, "a") === "approve" ? { note: OPENED_NOT_POSTED } : {}) };
      case "allow":
        return run ? { type: "ask", text: "allow this once in Terminal", run: () => void useRuns.getState().allowPermissionOnce(run.id, readAs(run.needs)) } : null;
      case "retry":
        return run ? { type: "ask", text: "retry this run", run: () => void useRuns.getState().retryLaunch(run.id) } : null;
      case "resume":
        return need.kind === "paused" && need.workstreamId
          ? { type: "ask", text: "resume this workstream", run: () => void useWorkstreams.getState().resume(need.workstreamId!) }
          : { type: "open", edit: false };
      default:
        // A run draft that needs nothing chosen is read in place, which starts nothing.
        if (p && inlineStartable(p)) void useInlineStarts.getState().open(p.id);
        return { type: "open", edit: false };
    }
  }
  if (which === "skip") return p && all.some((a) => a.id === "dismiss") ? { type: "do", run: draftDecisions(p.id, p).skip } : null;
  const stop = all.find((a) => a.id === "deny" || a.id === "dismiss");
  if (!stop) return null;
  // A deny reaches the agent, so it keeps its Enter; the rest are the person's own and can be undone.
  if (stop.id === "deny") return run ? { type: "ask", text: "deny it; Claude carries on without it", run: () => void useRuns.getState().denyPermission(run.id, readAs(run.needs)) } : null;
  if (p) return { type: "do", run: draftDecisions(p.id, p).skip };
  return run ? { type: "do", run: () => useRuns.getState().dismiss(run.id) } : null;
}

/** What the next Enter does, once a key asked for it; cleared when it is confirmed or cancelled. */
let armed: { key: string; run(): void } | null = null;

/** Asks for Enter on `need`: the row says what it would do, and any other key cancels. */
export function arm(need: Need, plan: Extract<KeyPlan, { type: "ask" }>) {
  armed = { key: need.key, run: plan.run };
  useWorkView.getState().ask({ key: need.key, text: `↵ ${plan.text} · any other key cancels` });
}

/** Enter on a row that asked: does what it said. */
export function confirmArmed() {
  const doIt = armed;
  disarm();
  doIt?.run();
}

export function disarm() {
  armed = null;
  if (useWorkView.getState().asking) useWorkView.getState().ask(null);
}

export { setPaneIntent, takePaneIntent };
