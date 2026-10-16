import { targetOf, workstreamOf } from "./proposals";
import type { Adoptable, Proposal, Run, Workstream } from "../types";

/** Why bringing a ticket's runs and drafts in is refused when there are none (any more), as `NOTHING_TO_ADOPT` in src-tauri/src/inbox/workstreams.rs. */
export const NOTHING_TO_ADOPT = "There is nothing on this ticket to bring into the workstream.";

/** Whether a draft can be put in a workstream after it was made, as `can_join_workstream`: Pip's, a run's and any run start record one. */
export const canJoinWorkstream = (p: Proposal) => p.origin.type === "chat" || p.origin.type === "run" || p.intent.type === "startRun";

/**
 * What an open workstream on a ticket could take in, as `adoptable_of`: the ticket's runs in `itemRuns` and the pending
 * drafts in `pending` that are in no workstream, by id. A draft with nowhere to record a workstream stays in General.
 */
export function adoptableOf(ws: Pick<Workstream, "itemKey" | "connectionId" | "closedAt">, itemRuns: readonly Run[], pending: readonly Proposal[]): Adoptable {
  const key = ws.itemKey;
  if (!key || ws.closedAt !== null) return { runs: [], drafts: [] };
  return {
    runs: itemRuns.filter((r) => r.connectionId === ws.connectionId && !r.spec.workstream && r.item?.key === key).map((r) => r.id),
    drafts: pending
      .filter((p) => p.state.type === "pending" && !workstreamOf(p) && canJoinWorkstream(p) && targetOf(p.intent)?.key === key && targetOf(p.intent)?.connectionId === ws.connectionId)
      .map((p) => p.id),
  };
}

/** "2 runs and 1 draft", for the line that offers them and the toast that says they moved (`runs`/`drafts` are counts). */
export function adoptCount(runs: number, drafts: number): string {
  const part = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return runs && drafts ? `${part(runs, "run")} and ${part(drafts, "draft")}` : runs ? part(runs, "run") : part(drafts, "draft");
}

/** The line that offers them: "2 runs and 1 draft on CA-402 are under General." */
export const adoptOfferText = (key: string, runs: number, drafts: number) => `${adoptCount(runs, drafts)} on ${key} ${runs + drafts === 1 ? "is" : "are"} under General.`;

/** The toast that says they moved, and the one that says Undo put them back. `count` is `adoptCount`'s words. */
export const adoptedText = (count: string, key: string) => `Brought ${count} on ${key} into the workstream.`;
export const adoptUndoneText = (count: string, key: string) => `${count} on ${key} ${/^1 \w+$/.test(count) ? "is" : "are"} back under General.`;

/** "2 runs, 1 draft": what the `adopted` audit line says, as `Adoptable::words`. */
export const adoptWords = (a: Adoptable) => adoptCount(a.runs.length, a.drafts.length).replace(" and ", ", ");

/** `o` filed under workstream `workstream`, or with none (the key left out) for null: a draft's origin, or the spec of a run it would start. */
export function withWorkstream<T extends { workstream?: string | null }>(o: T, workstream: string | null): T {
  const { workstream: _, ...rest } = o;
  return (workstream ? { ...rest, workstream } : rest) as T;
}
