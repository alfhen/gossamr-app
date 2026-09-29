import { beforeAll, describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import { containerRef } from "../backend/mockConnector";
import { describeFilter, filterChips } from "../lib/filter";
import type { WorkFilter } from "../types";
import { queryLookup, useWorkspace } from "../workspaceStore";
import { projectOf, refine, withoutChip, withProject } from "./filters";

beforeAll(async () => {
  await useWorkspace.getState().init(new MockBackend());
});

const lookup = () => queryLookup(useWorkspace.getState());
const ALL: WorkFilter = { type: "and", filters: [] };

describe("filter box", () => {
  it("turns known words into chips and unknown words into text", () => {
    const f = refine(ALL, "stale blocked frobnicate", lookup());
    expect(filterChips(f).map((c) => describeFilter(c, lookup()))).toEqual(["No update for 5d+", "Blocked", "“frobnicate”"]);
  });

  it("adds to the filter already in place", () => {
    const f = refine({ type: "mine" }, "assignee:me stale", lookup());
    expect(filterChips(f).map((c) => c.type)).toEqual(["mine", "mine", "stale"]);
  });

  it("removes one chip by position", () => {
    const f = refine(ALL, "stale blocked", lookup());
    expect(filterChips(withoutChip(f, 0)).map((c) => c.type)).toEqual(["blocked"]);
    expect(withoutChip({ type: "blocked" }, 0)).toEqual(ALL);
  });
});

describe("project filter", () => {
  const web = containerRef("WEB");

  it("replaces the project and keeps the other chips", () => {
    const f = withProject(withProject({ type: "blocked" }, containerRef("DEVOPS")), web);
    expect(filterChips(f)).toEqual([{ type: "blocked" }, { type: "container", container: web }]);
    expect(projectOf(f)).toEqual(web);
  });

  it("drops the project when switching to all", () => {
    expect(projectOf(withProject({ type: "container", container: web }, null))).toBeNull();
  });
});
