import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { useWorkspace, childrenOf } from "../workspaceStore";
import { parentCrumb, stepKey, subtasksOf } from "./peekLogic";

describe("stepKey", () => {
  const order = ["a", "b", "c"];

  it("moves one place and stops at the ends", () => {
    expect(stepKey(order, "a", 1)).toBe("b");
    expect(stepKey(order, "c", 1)).toBe("c");
    expect(stepKey(order, "a", -1)).toBe("a");
    expect(stepKey(order, "c", -1)).toBe("b");
  });

  it("starts at the first or last item when nothing, or something not shown, is selected", () => {
    expect(stepKey(order, null, 1)).toBe("a");
    expect(stepKey(order, null, -1)).toBe("c");
    expect(stepKey(order, "gone", 1)).toBe("a");
  });

  it("has nowhere to go in an empty canvas", () => {
    expect(stepKey([], "a", 1)).toBeNull();
  });
});

describe("epic and subtasks", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    await useWorkspace.getState().init(new MockBackend());
  });

  const items = () => useWorkspace.getState().items;

  it("names the parent with its title when it is cached", () => {
    const crumb = parentCrumb(items()["mock:DEVOPS-490"], items());
    expect(crumb?.ref.key).toBe("DEVOPS-480");
    expect(crumb?.title).toBe("Shopify event pipeline");
    expect(parentCrumb(items()["mock:DEVOPS-480"], items())).toBeNull();
  });

  it("lists children in key order and counts the finished ones", () => {
    const epic = items()["mock:DEVOPS-480"];
    const { rows, done } = subtasksOf(childrenOf(useWorkspace.getState(), epic.item));
    expect(rows.map((r) => r.ref.key)).toEqual(["DEVOPS-473", "DEVOPS-474", "DEVOPS-490", "DEVOPS-491", "DEVOPS-492", "DEVOPS-493"]);
    expect(done).toBe(rows.filter((r) => r.status.category === "done").length);
    expect(done).toBeGreaterThan(0);
  });

  it("has none for an item without children", () => {
    expect(subtasksOf([])).toEqual({ rows: [], done: 0 });
  });
});
