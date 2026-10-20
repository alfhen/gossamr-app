import { describe, expect, it } from "vitest";
import type { Run } from "../types";
import { stableGroups, stableOrder } from "./stableOrder";

const run = (id: string, state = "working") => ({ id, state }) as unknown as Run;
const group = (key: string, ...runs: Run[]) => ({ key, runs });
const ids = (groups: { key: string; runs: Run[] }[]) => groups.map((g) => `${g.key}:${g.runs.map((r) => r.id).join(",")}`);
const keyOf = (g: { key: string }) => g.key;

describe("stableOrder", () => {
  it("is the sorted order when not frozen", () => {
    expect(stableOrder(["a", "b", "c"], ["c", "a", "b"], false)).toEqual(["c", "a", "b"]);
  });

  it("keeps the shown order when frozen, whatever the sort says now", () => {
    expect(stableOrder(["a", "b", "c"], ["c", "b", "a"], true)).toEqual(["a", "b", "c"]);
  });

  it("drops what is gone and appends what is new in sorted order", () => {
    expect(stableOrder(["a", "b", "c"], ["z", "c", "y", "a"], true)).toEqual(["a", "c", "z", "y"]);
  });

  it("starts from the sorted order when nothing was shown", () => {
    expect(stableOrder([], ["b", "a"], true)).toEqual(["b", "a"]);
  });
});

describe("stableGroups", () => {
  it("is the fresh groups when not frozen", () => {
    const fresh = [group("done", run("b"))];
    expect(stableGroups([group("running", run("b"))], fresh, false, keyOf)).toEqual(fresh);
  });

  it("keeps a run in its group and place when it changes state or sorts elsewhere, with its current data", () => {
    const before = [group("running", run("a"), run("b")), group("done", run("c"))];
    const after = [group("running", run("a")), group("done", run("b", "done"), run("c"))];
    const shown = stableGroups(before, after, true, keyOf);
    expect(ids(shown)).toEqual(["running:a,b", "done:c"]);
    expect(shown[0].runs[1].state).toBe("done");
  });

  it("drops removed runs and groups left empty, and appends new runs and groups", () => {
    const before = [group("running", run("a"), run("b")), group("done", run("c"))];
    const after = [group("needs", run("n")), group("running", run("x"), run("a"))];
    expect(ids(stableGroups(before, after, true, keyOf))).toEqual(["running:a,x", "needs:n"]);
  });

  it("keeps a group that has no run yet, as a workstream with none is, in its place while frozen, and shows a new one", () => {
    const before = [group("w1"), group("w2", run("a"))];
    expect(ids(stableGroups(before, [group("w2", run("a")), group("w1"), group("w3")], true, keyOf))).toEqual(["w1:", "w2:a", "w3:"]);
    // Gone, it goes; with a run it has joined, it shows it.
    expect(ids(stableGroups(before, [group("w2", run("a"))], true, keyOf))).toEqual(["w2:a"]);
    expect(ids(stableGroups(before, [group("w1", run("n")), group("w2", run("a"))], true, keyOf))).toEqual(["w1:n", "w2:a"]);
  });
});
