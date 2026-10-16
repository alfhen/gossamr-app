import { describe, expect, it } from "vitest";
import type { Intent, Proposal, Run } from "../types";
import { adoptableOf, adoptCount, adoptedText, adoptOfferText, adoptUndoneText, adoptWords, canJoinWorkstream, withWorkstream } from "./workstreamAdopt";

const ref = (key: string) => ({ connectionId: "mock", externalId: key, key });
const run = (id: string, key: string, workstream?: string): Run => ({ id, connectionId: "mock", item: ref(key), spec: { kind: "plan", ...(workstream ? { workstream } : {}) } }) as unknown as Run;
const draft = (id: string, key: string, over: Partial<Proposal> = {}): Proposal =>
  ({ id, origin: { type: "chat", requestId: "q" }, intent: { type: "comment", item: ref(key), body: { blocks: [] } } as unknown as Intent, state: { type: "pending" }, ...over }) as unknown as Proposal;
const ws = { itemKey: "CA-401", connectionId: "mock", closedAt: null };

describe("what a workstream could take in from its ticket (G17)", () => {
  it("is the ticket's runs and pending drafts that belong to no workstream, by id", () => {
    const runs = [run("r1", "CA-401"), run("r2", "CA-401", "ws-9"), run("r3", "CA-402"), { ...run("r4", "CA-401"), connectionId: "jira" }];
    const pending = [draft("d1", "CA-401"), draft("d2", "CA-401", { origin: { type: "chat", requestId: "q", workstream: "ws-9" } }), draft("d3", "CA-402"), draft("d4", "CA-401", { state: { type: "applied" } as Proposal["state"] })];
    expect(adoptableOf(ws, runs, pending)).toEqual({ runs: ["r1"], drafts: ["d1"] });
  });

  it("leaves a draft with nowhere to record a workstream, and offers nothing without a ticket or once closed", () => {
    const board = draft("d5", "CA-401", { origin: { type: "board" } as Proposal["origin"] });
    expect(canJoinWorkstream(board)).toBe(false);
    const start = draft("d6", "CA-401", { origin: { type: "board" } as Proposal["origin"], intent: { type: "startRun", item: ref("CA-401"), spec: { kind: "plan" } } as unknown as Intent });
    expect(canJoinWorkstream(start)).toBe(true);
    expect(adoptableOf(ws, [], [board, start]).drafts).toEqual(["d6"]);
    expect(adoptableOf({ ...ws, itemKey: null }, [run("r1", "CA-401")], [])).toEqual({ runs: [], drafts: [] });
    expect(adoptableOf({ ...ws, closedAt: "2026-10-01T10:00:00Z" }, [run("r1", "CA-401")], [])).toEqual({ runs: [], drafts: [] });
  });

  it("is told in counts the way the offer, the toast and the audit say it", () => {
    expect(adoptCount(2, 1)).toBe("2 runs and 1 draft");
    expect(adoptCount(1, 0)).toBe("1 run");
    expect(adoptCount(0, 3)).toBe("3 drafts");
    expect(adoptWords({ runs: ["a", "b"], drafts: ["c"] })).toBe("2 runs, 1 draft");
    expect(adoptOfferText("CA-402", 2, 1)).toBe("2 runs and 1 draft on CA-402 are under General.");
    expect(adoptOfferText("CA-402", 0, 1)).toBe("1 draft on CA-402 is under General.");
    expect(adoptedText("2 runs and 1 draft", "CA-402")).toBe("Brought 2 runs and 1 draft on CA-402 into the workstream.");
    expect(adoptUndoneText("1 run", "CA-402")).toBe("1 run on CA-402 is back under General.");
    expect(adoptUndoneText("2 runs and 1 draft", "CA-402")).toBe("2 runs and 1 draft on CA-402 are back under General.");
  });

  it("files a draft's origin or a run's spec under a workstream, and leaves the key out for none", () => {
    type Spec = { kind: string; workstream?: string | null };
    expect(withWorkstream<Spec>({ kind: "plan" }, "ws-1")).toEqual({ kind: "plan", workstream: "ws-1" });
    expect(withWorkstream<Spec>({ kind: "plan", workstream: "ws-1" }, null)).toEqual({ kind: "plan" });
  });
});
