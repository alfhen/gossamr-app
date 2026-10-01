import { describe, expect, it } from "vitest";
import type { StatusDef, WorkCategory } from "../types";
import { applyOrder, defaultOrder, gapAt, landingIndex, moveTo, movedMessage, parseColumnOrders } from "./columnOrder";

const st = (name: string, category: WorkCategory): StatusDef => ({ id: name.toLowerCase().replace(/\W/g, ""), name, category });
const names = (list: StatusDef[]) => list.map((s) => s.name);

const CA = [st("To Do", "todo"), st("Done", "done"), st("In Progress", "active"), st("Won't Do", "done")];

describe("default order", () => {
  it("puts to do, in progress, then done, keeping the workflow's order inside a category", () => {
    expect(names(defaultOrder(CA))).toEqual(["To Do", "In Progress", "Done", "Won't Do"]);
    expect(names(defaultOrder([st("B", "active"), st("A", "active"), st("Z", "todo")]))).toEqual(["Z", "B", "A"]);
  });
});

describe("applying a saved order", () => {
  const ids = (...n: string[]) => n.map((x) => x.toLowerCase().replace(/\W/g, ""));

  it("uses the default when nothing is saved", () => {
    expect(names(applyOrder(CA, undefined))).toEqual(["To Do", "In Progress", "Done", "Won't Do"]);
    expect(names(applyOrder(CA, []))).toEqual(["To Do", "In Progress", "Done", "Won't Do"]);
  });

  it("follows the saved order", () => {
    expect(names(applyOrder(CA, ids("Won't Do", "Done", "In Progress", "To Do")))).toEqual(["Won't Do", "Done", "In Progress", "To Do"]);
  });

  it("drops saved statuses that no longer exist and ignores repeats", () => {
    expect(names(applyOrder(CA, ids("Done", "Gone", "Done", "To Do", "In Progress", "Won't Do")))).toEqual(["Done", "To Do", "In Progress", "Won't Do"]);
  });

  it("puts a status added later after the one before it in the default order", () => {
    const withNew = [...CA, st("Review", "active")];
    expect(names(applyOrder(withNew, ids("Won't Do", "Done", "In Progress", "To Do")))).toEqual(["Won't Do", "Done", "In Progress", "Review", "To Do"]);
    const first = [st("Triage", "todo"), ...CA];
    expect(names(applyOrder(first, ids("Done", "To Do", "In Progress", "Won't Do")))[0]).toBe("Triage");
  });
});

describe("moving columns", () => {
  it("moves one entry to an index and clamps", () => {
    expect(moveTo(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveTo(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveTo(["a", "b"], 0, 9)).toEqual(["b", "a"]);
    expect(moveTo(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });

  it("lands a dragged column where the gap it was dropped in leaves room", () => {
    expect(landingIndex(1, 0)).toBe(0);
    expect(landingIndex(1, 1)).toBe(1);
    expect(landingIndex(1, 2)).toBe(1);
    expect(landingIndex(1, 4)).toBe(3);
  });

  it("finds the gap nearest the pointer", () => {
    const edges = [0, 100, 200].map((left) => ({ left, right: left + 90 }));
    expect([-5, 40, 60, 160, 260, 999].map((x) => gapAt(x, edges))).toEqual([0, 0, 1, 2, 3, 3]);
  });

  it("announces the new position", () => {
    expect(movedMessage("Done", 2, 4)).toBe("Done moved to position 3 of 4");
  });
});

describe("stored orders", () => {
  it("keeps lists of ids and ignores everything else", () => {
    expect(parseColumnOrders({ "mock:CA": ["a", "b"], bad: "x", worse: [1, 2], empty: [] })).toEqual({ "mock:CA": ["a", "b"] });
    for (const raw of [null, undefined, "x", 4, ["a"]]) expect(parseColumnOrders(raw)).toEqual({});
  });
});
