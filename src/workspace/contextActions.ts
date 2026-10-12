import { currentNeeds } from "./useNeeds";
import { needGroups, type Need, type NeedActionId } from "../lib/needs";
import { workstreamOf } from "../lib/proposals";
import type { Proposal, Run } from "../types";
import { useWorkspace } from "../workspaceStore";
import { contextCommands, batchCommands, type ContextDeps, type Subject } from "./contextCommands";
import type { Command } from "./commands";
import { draftDecisions, openLiveDraft } from "./DraftPreview";
import { keyPlan, openInWorkstream, openNeed } from "./needsActions";
import { usePipHome } from "./pipHomeStore";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { openOnPipHome, useWorkstreams } from "./workstreamsStore";

/**
 * The item the keyboard was on when the palette opened, which its "This item" entries act on: a Needs you row or its open
 * decision, a draft's card, a run's card or open sheet or its selection on Agents, or the workstream selected on Pip home.
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
  if (tabs.route === "agents" && runs.selectedId) return { type: "run", id: runs.selectedId };
  if (tabs.route === "pip") {
    const home = usePipHome.getState();
    if (home.deciding) return { type: "need", key: home.deciding };
    if (home.selected) return { type: "workstream", id: home.selected };
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
        return go(plan("approve"));
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
    openOnPipHome(id ?? null);
    usePipHome.getState().focus({ type: "draft", id: p.id });
  },
  openRun: (run: Run) => useRuns.getState().openRun(run.id),
  hold: (id) => void useWorkstreams.getState().hold(id),
  resume: (id) => void useWorkstreams.getState().resume(id),
  advise: (id) => void useWorkstreams.getState().setMode(id, "advise"),
  openWorkstream: openOnPipHome,
  approveSafe(group) {
    // The list's own step: its combined preview and confirm. Nothing is approved here.
    const tabs = useTabs.getState();
    if (tabs.route !== "pip") tabs.setRoute("pip");
    usePipHome.getState().previewBatch(group.workstreamId === null ? "general" : group.workstreamId);
  },
};

/**
 * The entries for the item in focus, and with Agents on the global batch ones ("Approve all safe drafts in …"), from the
 * stores as they are now. A draft's entries need no Agents; a need, a run or a workstream only exists with them.
 */
export function contextEntries(subject: Subject | null, agents: boolean): Command[] {
  const needs = agents ? currentNeeds() : [];
  const data = { needs, proposals: useWorkspace.getState().proposals, runs: useRuns.getState().runs, workstreams: useWorkstreams.getState().list };
  return [...contextCommands(subject, data, contextDeps), ...(agents ? batchCommands(needGroups(needs), contextDeps) : [])];
}

