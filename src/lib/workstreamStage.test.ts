import { describe, expect, it } from "vitest";
import type { RunKind, RunState, WorkstreamStage } from "../types";
import fixtures from "./workstreamStage.fixtures.json";
import { runLabels, stage, type StagedRun } from "./workstreamStage";

interface Case {
  name: string;
  runs: { kind: string; state: string; queuedAt: string }[];
  stage: string;
  /** When given, the label of each run, in the order listed. */
  labels?: string[];
}

/** Runs as the Rust test builds them from a case: `r0`, `r1`… in the order listed. */
const runsOf = (c: Case): StagedRun[] => c.runs.map((r, n) => ({ id: `r${n}`, state: r.state as RunState, queuedAt: r.queuedAt, spec: { kind: r.kind as RunKind } }));

const run = (id: string, kind: RunKind, state: RunState, queuedAt: string): StagedRun => ({ id, state, queuedAt, spec: { kind } });

describe("workstream stage, on the fixtures the Rust side also runs", () => {
  it.each(fixtures as Case[])("$name", (c) => {
    expect(stage(runsOf(c))).toBe(c.stage as WorkstreamStage);
  });

  it("covers every stage", () => {
    const seen = new Set((fixtures as Case[]).map((c) => c.stage));
    expect([...seen].sort()).toEqual(["build", "done", "intake", "investigate", "plan", "review", "triage", "verify"]);
  });

  it("does not depend on the order runs are listed in", () => {
    for (const c of fixtures as Case[]) expect(stage(runsOf(c).reverse())).toBe(c.stage);
  });

  it.each((fixtures as Case[]).filter((c) => c.labels))("labels: $name", (c) => {
    const labels = new Map(runLabels(runsOf(c)));
    expect(runsOf(c).map((r) => labels.get(r.id))).toEqual(c.labels);
    const reversed = new Map(runLabels(runsOf(c).reverse()));
    expect(runsOf(c).map((r) => reversed.get(r.id))).toEqual(c.labels);
  });
});

describe("run labels", () => {
  it("numbers runs by queue time, then id", () => {
    const runs = [run("z", "plan", "done", "2026-09-29T10:05:00Z"), run("b", "triage", "done", "2026-09-29T10:01:00Z"), run("a", "investigate", "done", "2026-09-29T10:01:00Z")];
    expect(runLabels(runs)).toEqual([
      ["a", "R1"],
      ["b", "R2"],
      ["z", "R3"],
    ]);
  });

  it("gives no labels without runs, and leaves the list it was given alone", () => {
    expect(runLabels([])).toEqual([]);
    const runs = [run("b", "plan", "done", "2026-09-29T10:05:00Z"), run("a", "plan", "done", "2026-09-29T10:00:00Z")];
    runLabels(runs);
    expect(runs.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
