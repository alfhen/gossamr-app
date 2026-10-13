import { useEffect, useMemo } from "react";
import { useClaude } from "../claudeStore";
import { inWorkstreamPane } from "../lib/proposals";
import { isJiraWrite, workstreamWither, type WorkstreamWither } from "../lib/workstreamWither";
import type { Proposal, Run, WorkstreamEvent, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { useRuns } from "./runsStore";
import { workstreamConversation } from "../lib/conversations";
import { useWorkstreams } from "./workstreamsStore";

const NONE: readonly never[] = [];

/** What the cobwebs are worked out from, as the stores hold it. */
export interface WitherParts {
  events: Readonly<Record<string, readonly WorkstreamEvent[]>>;
  byTicket: Readonly<Record<string, { turns: readonly { at?: string }[] } | undefined>>;
  runs: readonly Run[];
  proposals: Readonly<Record<string, Proposal | undefined>>;
}

/** The cobweb of each of the `open` workstreams that has one, by id, at `now` (ms): `workstreamWither` over what the stores hold. */
export function withersOf(open: readonly WorkstreamView[], { events, byTicket, runs, proposals }: WitherParts, now: number): Record<string, WorkstreamWither> {
  const out: Record<string, WorkstreamWither> = {};
  for (const v of open) {
    const id = v.workstream.id;
    const turns = byTicket[workstreamConversation(id)]?.turns;
    const w = workstreamWither(
      events[id] ?? NONE,
      runs.filter((r) => r.spec.workstream === id),
      new Date(now),
      { draft: (pid) => proposals[pid], turns: turns && turns.length ? turns : null, openedAt: v.workstream.createdAt },
    );
    const draftWaiting = Object.values(proposals).some((p) => !!p && p.state.type === "pending" && isJiraWrite(p.intent) && inWorkstreamPane(p, v.workstream));
    if (w.level > 0) out[id] = { ...w, draftWaiting };
  }
  return out;
}

/**
 * Each open workstream's cobweb (`workstreamWither`), by id, at `now` (ms): the workstreams' audits and conversations are
 * read for every open one while the list is on screen, and the audits again when a draft is applied, which is what a post
 * to Jira is. Only workstreams with a cobweb to show are in the result.
 */
export function useWorkstreamWithers(open: readonly WorkstreamView[], now: number): Record<string, WorkstreamWither> {
  const events = useWorkstreams((s) => s.events);
  const byTicket = useClaude((s) => s.byTicket);
  const proposals = useWorkspace((s) => s.proposals);
  const runs = useRuns((s) => s.runs);
  const ids = open.map((v) => v.workstream.id).join(" ");
  // What the person posted is a draft applied, so the audits are read again when one is.
  const applied = useMemo(() => Object.values(proposals).filter((p) => p?.state.type === "applied").length, [proposals]);
  useEffect(() => {
    for (const id of ids.split(" ").filter(Boolean)) void useClaude.getState().load(workstreamConversation(id));
  }, [ids]);
  useEffect(() => {
    for (const id of ids.split(" ").filter(Boolean)) void useWorkstreams.getState().loadEvents(id);
  }, [ids, applied]);
  // `open` changes with the list; the rest are what the cobwebs are worked out from.
  return useMemo(() => withersOf(open, { events, byTicket, runs, proposals }, now), [open, events, byTicket, runs, proposals, now]);
}
