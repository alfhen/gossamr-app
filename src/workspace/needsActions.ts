import { readAs } from "../lib/permission";
import { quietKey, type Need } from "../lib/needs";
import { ALLOW_MORE_STEPS } from "../types";
import { useWorkspace } from "../workspaceStore";
import { draftKeyAction } from "./draftKeys";
import { docText } from "../lib/docs";
import { isAnswersDraft } from "../lib/proposals";
import { newRisks } from "../lib/riskyText";
import { liveDraft } from "./draftLive";
import { keptEditsOfDraft } from "./DraftCard";
import { draftDecisions } from "./DraftPreview";
import { inlineStartable, useInlineStarts } from "./InlineStart";
import { setPaneIntent, takePaneIntent, usePipHome } from "./pipHomeStore";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { useWorkstreams } from "./workstreamsStore";

/**
 * What the Needs you list's keys and buttons do. Everything here reaches the stores through the same commands the cards
 * use (`draftDecisions`, the runs store, the workstreams store), so a decision made from the list is the one the card makes.
 */

/** The id a workstream's row has in the list: its own, or "general". */
export const groupId = (workstreamId: string | null) => workstreamId ?? "general";

/** Opens need `need`'s decision in Pip home's middle column, going to Pip home from any other route. */
export function openNeed(need: Need, opts: { edit?: boolean } = {}) {
  const tabs = useTabs.getState();
  if (tabs.route !== "pip") tabs.setRoute("pip");
  const home = usePipHome.getState();
  // The intent is read by the pane as it mounts; one already open for this need is remounted to read it. Anything but Edit clears it.
  setPaneIntent(opts.edit ? "edit" : null);
  const open = home.deciding === need.key;
  home.decide(need.key, need.workstreamId);
  if (open && opts.edit) home.redecide();
}

/**
 * The pane's "Open in workstream": shows what the need is about where it lives, the card to bring into view, the run's
 * sheet over it for a run. It decides nothing itself, and closes the decision so the conversation has the room.
 */
export function openInWorkstream(need: Need) {
  const tabs = useTabs.getState();
  if (tabs.route !== "pip") tabs.setRoute("pip");
  const home = usePipHome.getState();
  home.closeDecision();
  if (need.workstreamId) home.openWorkstream(need.workstreamId);
  else home.openGeneral();
  home.focus(need.target);
  if (need.target.type === "run") useRuns.getState().openRun(need.target.id, { stay: true });
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
export type KeyPlan = { type: "ask"; text: string; run(): void } | { type: "do"; run(): void } | { type: "open"; edit: boolean };

const proposalOf = (need: Need) => (need.target.type === "draft" ? useWorkspace.getState().proposals[need.target.id] : undefined);
const runOf = (need: Need) => (need.runId ? useRuns.getState().runs.find((r) => r.id === need.runId) : undefined);

/**
 * Whether approving `p` from the list would skip what its card shows: the card holds an edit the draft doesn't, or the words
 * would stop at the posting pause. A card not on screen counts its kept edits, and an answers draft's words are checked here, as the card checks them.
 */
function needsCard(p: NonNullable<ReturnType<typeof proposalOf>>): boolean {
  const live = liveDraft(p.id);
  if (live) return live.edited || live.risky;
  // Words typed into a card that has since closed are kept for it, and only the card posts them.
  if (keptEditsOfDraft(p.id)) return true;
  return p.intent.type === "comment" && isAnswersDraft(p) && newRisks("", docText(p.intent.body)).length > 0;
}

/** "this comment", "this move": what an approval would approve, for the line that asks for Enter. */
const thing = (need: Need) => (need.kind === "question" ? "this reply" : need.kind === "review" ? "this review" : "this draft");

/**
 * What key `which` does on `need`. Anything that writes, posts, starts or answers an agent asks for Enter first, as a draft's
 * own card does ("a" then Enter): any other key cancels. Skipping a draft and dismissing a run touch nothing outside Gossamr,
 * so they act at once and offer Undo. What needs reading before it is decided (a rewrite's diff, a run's prompt, a hold's
 * cause) or has nothing to write opens its decision instead. Null when the key means nothing here.
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
        return { type: "open", edit: false };
      case "allow":
        return run ? { type: "ask", text: "allow this once in Terminal", run: () => void useRuns.getState().allowPermissionOnce(run.id, readAs(run.needs)) } : null;
      case "retry":
        return run ? { type: "ask", text: "retry this run", run: () => void useRuns.getState().retryLaunch(run.id) } : null;
      case "allowMore":
        return need.workstreamId ? { type: "ask", text: `allow ${ALLOW_MORE_STEPS} more automatic steps`, run: () => void useWorkstreams.getState().allowMore(need.workstreamId!) } : null;
      case "askReporter":
        return need.workstreamId ? { type: "ask", text: "draft a comment to the reporter with the open questions; nothing is posted until you approve it", run: () => void useWorkstreams.getState().askReporter(need.workstreamId!) } : null;
      case "resume":
        return need.kind === "hold" && need.workstreamId
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
  // A quiet run is kept waiting for this spell only, so a failure or a new quiet spell still needs the person.
  return run ? { type: "do", run: () => useRuns.getState().dismiss(need.kind === "quiet" ? quietKey(run) : run.id) } : null;
}

/** What the next Enter does, once a key asked for it; cleared when it is confirmed or cancelled. */
let armed: { key: string; run(): void } | null = null;

/** Asks for Enter on `need`: the row says what it would do, and any other key cancels. */
export function arm(need: Need, plan: Extract<KeyPlan, { type: "ask" }>) {
  armed = { key: need.key, run: plan.run };
  usePipHome.getState().ask({ key: need.key, text: `↵ ${plan.text} · any other key cancels` });
}

/** Enter on a row that asked: does what it said. */
export function confirmArmed() {
  const doIt = armed;
  disarm();
  doIt?.run();
}

export function disarm() {
  armed = null;
  if (usePipHome.getState().asking) usePipHome.getState().ask(null);
}

export { setPaneIntent, takePaneIntent };
