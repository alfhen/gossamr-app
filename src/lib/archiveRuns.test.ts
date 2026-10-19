import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import type { ClearFilter, Proposal, Run, RunState } from "../types";
import { ARCHIVABLE, archiveControl, clearSentence, keptText, runsWithPendingDrafts, selectClearable, sizeText } from "./archiveRuns";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const DAY = 86_400_000;
const base = new MockBackend().runs.list()[0];
const run = (id: string, state: RunState, daysAgo: number, over: Partial<Run> = {}): Run => ({ ...base, id, state, archivedAt: null, endedAt: new Date(NOW - daysAgo * DAY).toISOString(), queuedAt: new Date(NOW - (daysAgo + 1) * DAY).toISOString(), ...over });
const filter = (olderThanDays: number | null, states: RunState[], keep: string[] = []): ClearFilter => ({ olderThanDays, states, keep });
const pick = (runs: Run[], f: ClearFilter, drafts: string[] = []) => selectClearable(runs, new Set(drafts), f, NOW);

describe("which finished runs Clear finished selects", () => {
  const runs = [run("done-old", "done", 10), run("done-new", "done", 2), run("failed-old", "failed", 10), run("stopped-old", "stopped", 10)];

  it("takes the chosen states that ended before the age, and counts them by state", () => {
    const p = pick(runs, filter(7, ["done", "failed"]));
    expect(p.ids).toEqual(["done-old", "failed-old"]);
    expect(p.byState).toEqual({ done: 1, failed: 1 });
    expect(pick(runs, filter(null, ["done"])).ids).toEqual(["done-old", "done-new"]);
    expect(pick(runs, filter(7, [])).ids).toEqual([]);
  });

  it("ages a run from when it was queued while it has no end", () => {
    expect(pick([run("r", "unknown", 0, { endedAt: null, queuedAt: new Date(NOW - 10 * DAY).toISOString() })], filter(7, ["unknown"])).ids).toEqual(["r"]);
  });

  it("never takes a run that is running or waiting on the person, whatever is asked", () => {
    const live: RunState[] = ["queued", "launching", "working", "needsAnswer", "needsPermission", "systemBlocked"];
    const all = [...live, ...ARCHIVABLE];
    expect(pick(live.map((s) => run(s, s, 90)), filter(null, all)).ids).toEqual([]);
  });

  it("keeps a run with a draft still to approve, and one that is in Needs you, and says how many", () => {
    const p = pick([run("plan", "done", 30), run("needs", "failed", 30), run("plain", "done", 30)], filter(7, ["done", "failed"], ["needs"]), ["plan"]);
    expect(p.ids).toEqual(["plain"]);
    expect(p.kept).toEqual({ draft: 1, needsYou: 1 });
    expect(keptText(p.kept)).toBe("Kept: 1 with a draft to approve, 1 in Needs you.");
    expect(keptText({ draft: 0, needsYou: 0 })).toBeNull();
  });

  it("skips runs already archived", () => {
    expect(pick([run("a", "done", 30, { archivedAt: new Date(NOW).toISOString() })], filter(null, ["done"])).ids).toEqual([]);
  });
});

describe("what the popover says", () => {
  it("reads the choice as a sentence with a live count", () => {
    expect(clearSentence({ ids: Array(12).fill("x") }, filter(7, ["done", "failed", "stopped"]))).toBe("Archive 12 runs older than 7 days: done, failed, stopped");
    expect(clearSentence({ ids: ["x"] }, filter(1, ["done"]))).toBe("Archive 1 run older than 1 day: done");
    expect(clearSentence({ ids: ["x", "y"] }, filter(null, ["failed"]))).toBe("Archive 2 runs: failed");
    expect(clearSentence({ ids: [] }, filter(7, ["done"]))).toBe("Nothing to archive with these choices.");
  });

  it("gives a folder's size in plain units", () => {
    expect([512, 2048, 5 * 1024 * 1024, 3 * 1024 ** 3].map(sizeText)).toEqual(["512 B", "2.0 KB", "5.0 MB", "3.0 GB"]);
  });
});

describe("what can be archived", () => {
  it("is a run that is over; a running or waiting one says to stop it first", () => {
    for (const s of ARCHIVABLE) expect(archiveControl({ state: s }).enabled).toBe(true);
    for (const s of ["queued", "launching", "working", "needsAnswer", "needsPermission", "systemBlocked"] as const) {
      expect(archiveControl({ state: s })).toEqual({ enabled: false, title: "Stop it first, then archive it." });
    }
  });

  it("finds the runs with a pending draft", () => {
    const draft = (id: string, runId: string, state: "pending" | "applied") => ({ id, state: { type: state }, origin: { type: "run", runId, shortId: null, workstream: null } }) as unknown as Proposal;
    const chat = { id: "c", state: { type: "pending" }, origin: { type: "chat", requestId: "q", workstream: null } } as unknown as Proposal;
    expect([...runsWithPendingDrafts([draft("a", "r1", "pending"), draft("b", "r2", "applied"), chat])]).toEqual(["r1"]);
  });
});
