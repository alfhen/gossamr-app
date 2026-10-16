import { describe, expect, it } from "vitest";
import { clarityOf } from "./mockWorkstreams";
import type { Clarity, Run, Workstream, WorkstreamEvent } from "../types";

const ws = { id: "w", itemKey: "CA-1", closedAt: null } as unknown as Workstream;
const gaps = ["short", "done"] as unknown as Clarity["gaps"];
const ev = (seq: number, actor: WorkstreamEvent["actor"], action: string, proposalId: string | null, detail: string | null = null): WorkstreamEvent => ({
  workstreamId: "w",
  seq,
  at: new Date(Date.UTC(2026, 9, 12, 12, seq)).toISOString(),
  actor,
  action,
  runId: null,
  proposalId,
  digest: null,
  detail,
});

describe("the clarity notice after asking the reporter", () => {
  const asked = ev(1, "person", "clarity_asked", "c1");
  it("stays away while the ask is pending or posted", () => {
    expect(clarityOf(ws, [], [], gaps, [], [asked])).toBeNull();
    expect(clarityOf(ws, [], [], gaps, [], [asked, ev(2, "person", "draft_approved", "c1")])).toBeNull();
  });
  it("comes back when the ask draft was skipped or retired, and goes again when Undo brings it back", () => {
    const skipped = [asked, ev(2, "person", "draft_skipped", "c1")];
    expect(clarityOf(ws, [], [], gaps, [], skipped)).not.toBeNull();
    expect(clarityOf(ws, [], [], gaps, [], [asked, ev(2, "supervisor", "draft_retired", "c1")])).not.toBeNull();
    expect(clarityOf(ws, [], [], gaps, [], [...skipped, ev(3, "person", "undone", "c1", "draft_skipped")])).toBeNull();
  });
});

describe("the clarity notice after work on the ticket", () => {
  const run = (kind: string, key: string, workstream: string | null) => ({ item: { key }, spec: { kind, workstream } }) as unknown as Run;
  it("goes when a Triage, Plan or Build ran on the ticket, in General or in another workstream", () => {
    for (const kind of ["triage", "plan", "build"]) expect(clarityOf(ws, [], [run(kind, "CA-1", null)], gaps, [], [])).toBeNull();
    expect(clarityOf(ws, [], [run("plan", "CA-1", "other")], gaps, [], [])).toBeNull();
  });
  it("stays for a Plan on another ticket or an Investigate alone", () => {
    expect(clarityOf(ws, [], [run("plan", "CA-2", null)], gaps, [], [])).not.toBeNull();
    expect(clarityOf(ws, [], [run("investigate", "CA-1", null)], gaps, [], [])).not.toBeNull();
  });
});
