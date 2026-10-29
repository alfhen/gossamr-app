import { describe, expect, it } from "vitest";
import type { StatusDef, WorkCategory } from "../types";
import { defaultOrder } from "./columnOrder";

const st = (name: string, category: WorkCategory): StatusDef => ({ id: name.toLowerCase().replace(/\W/g, ""), name, category });
const names = (list: StatusDef[]) => list.map((s) => s.name);

const CA = [st("To Do", "todo"), st("Done", "done"), st("In Progress", "active"), st("Won't Do", "done")];

describe("default order", () => {
  it("puts to do, in progress, then done, keeping the workflow's order inside a category", () => {
    expect(names(defaultOrder(CA))).toEqual(["To Do", "In Progress", "Done", "Won't Do"]);
    expect(names(defaultOrder([st("B", "active"), st("A", "active"), st("Z", "todo")]))).toEqual(["Z", "B", "A"]);
  });
});
