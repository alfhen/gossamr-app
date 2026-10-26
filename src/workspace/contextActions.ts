import { currentNeeds } from "./useNeeds";
import { needGroups, type Need, type NeedActionId } from "../lib/needs";
import { workstreamOf } from "../lib/proposals";
import type { Proposal, Run } from "../types";
import { useWorkspace } from "../workspaceStore";
import { contextCommands, batchCommands, type ContextDeps, type Subject } from "./contextCommands";
import type { Command } from "./commands";
import { draftDecisions, openLiveDraft } from "./DraftPreview";
import { groupId, keyPlan, openInWorkstream, openNeed, showGroup } from "./needsActions";
import { NO_WORKSTREAM_ID, useWorkView } from "./workViewStore";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { openOnAgents, useWorkstreams } from "./workstreamsStore";

/**
 * The item the keyboard was on when the palette opened, which its "This item" entries act on: a Needs you row or its open
 * decision, a draft's card, a run's card or open sheet or its selection on Agents, or the workstream whose detail is open there.
 */
export function focusedSubject(active: Element | null): Subject | null {
  const el = active instanceof Element ? active : null;
  const row = el?.closest("[data-need-key]")?.getAttribute("data-need-key") ?? el?.closest("[data-needs-pane]")?.getAttribute("data-needs-pane");
  if (row) return { type: "need", key: row };
  const draft = el?.closest("article[data-draft]")?.getAttribute("data-draft");
  if (draft) return { type: "draft", id: draft };
  const run = el?.closest("[data-run-id]")?.getAttribute("data-run-id");
  if (run) return { type: "run", id: run };
  const runs = useRuns.getState();
  if (runs.sheet?.type === "run") return { type: "run", id: runs.sheet.id };
  const tabs = useTabs.getState();
  if (tabs.route === "agents") {
    if (runs.selectedId) return { type: "run", id: runs.selectedId };
    const view = useWorkView.getState();
    if (view.deciding) return { type: "need", key: view.deciding };
    if (view.selected && view.selected !== NO_WORKSTREAM_ID) return { type: "workstream", id: view.selected };
  }
  return null;
}

/**
 * The palette's entries run what the buttons run. A need's own button is the plan its key makes (`keyPlan`): what asks for
 * Enter on the keyboard is done by the palette's own Enter, since choosing the entry is the deliberate step; Skip and Dismiss
 * offer Undo as they do everywhere; what opens a decision opens it.
 */
export const contextDeps: ContextDeps = {
  needAct(need: Need, id: NeedActionId) {
    const plan = (key: "approve" | "dismiss" | "skip") => keyPlan(need, key);
    const go = (p: ReturnType<typeof keyPlan>) => (p && p.type !== "open" ? p.run() : openNeed(need));
    switch (id) {
      case "approve":
      case "allow":
      case "retry":
      case "resume":
      case "askReporter":
        return go(plan("approve"));
      // The palette's own Enter is the deliberate step: it records the person's choice, which only the person can make.
      case "answerSelf":
        return need.workstreamId ? void useWorkstreams.getState().answerSelf(need.workstreamId) : openNeed(need);
      case "planAnyway":
        return need.workstreamId ? void useWorkstreams.getState().planAnyway(need.workstreamId) : openNeed(need);
      case "deny":
      case "dismiss":
        return go(plan("dismiss"));
      case "edit":
        return openNeed(need, { edit: true });
      case "answer":
      case "open":
        return openNeed(need);
    }
  },
  openInWorkstream,
  approveDraft: (p: Proposal) => draftDecisions(p.id, p).approve(),
  openDraft: (p: Proposal) => openLiveDraft(p),
  skipDraft: (p: Proposal) => draftDecisions(p.id, p).skip(),
  draftInWorkstream(p: Proposal) {
    const id = workstreamOf(p);
    // A draft outside any workstream has no detail to show it in: its own card opens instead.
    if (!id) return openLiveDraft(p);
    openOnAgents(id);
    useWorkView.getState().focus({ type: "draft", id: p.id });
  },
  openRun: (run: Run) => useRuns.getState().openRun(run.id),
  pause: (id) => void useWorkstreams.getState().pause(id),
  resume: (id) => void useWorkstreams.getState().resume(id),
  openWorkstream: openOnAgents,
  approveSafe(group) {
    // The workstream's own step: its combined preview and confirm. Nothing is approved here.
    showGroup(group.workstreamId);
    useWorkView.getState().previewBatch(groupId(group.workstreamId));
  },
};

/** The entries for the item in focus and the global batch ones ("Approve all safe drafts in …"), from the stores as they are now. */
export function contextEntries(subject: Subject | null): Command[] {
  const needs = currentNeeds();
  const data = { needs, proposals: useWorkspace.getState().proposals, runs: useRuns.getState().runs, workstreams: useWorkstreams.getState().list };
  return [...contextCommands(subject, data, contextDeps), ...batchCommands(needGroups(needs), contextDeps)];
}

