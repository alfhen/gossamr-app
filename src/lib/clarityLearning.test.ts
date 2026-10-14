import { describe, expect, it } from "vitest";
import { dismissed, flaggedGaps, forget, ignoredAmong, ignoredGaps, learnedDetail, learnedList, learnedWords, LEARN_AFTER, parseLearning, projectOfKey, SHORT_GAP, type ClarityLearning } from "./clarityLearning";

describe("what Looks fine teaches the clarity notice", () => {
  it("counts each gap the notice named, per Jira project, and learns it on the third time", () => {
    expect(LEARN_AFTER).toBe(3);
    let learning: ClarityLearning = {};
    const one = () => {
      const next = dismissed(learning, "CA", ["done", "who"]);
      learning = next.learning;
      return next.learned;
    };
    expect(one()).toEqual([]);
    expect(one()).toEqual([]);
    expect(ignoredGaps(learning, "CA")).toEqual([]);
    expect(one()).toEqual(["done", "who"]);
    expect(ignoredGaps(learning, "CA")).toEqual(["done", "who"]);
    // Learned once: a fourth dismissal doesn't say it again.
    expect(one()).toEqual([]);
  });

  it("is per project and per gap: three dismissals of one gap in two projects teach neither, and a different gap starts at one", () => {
    let l = dismissed({}, "CA", ["who"]).learning;
    l = dismissed(l, "CE", ["who"]).learning;
    l = dismissed(l, "CA", ["who", "scope"]).learning;
    l = dismissed(l, "CE", ["scope"]).learning;
    expect(ignoredGaps(l, "CA")).toEqual([]);
    expect(ignoredGaps(l, "CE")).toEqual([]);
    l = dismissed(l, "CA", ["who"]).learning;
    expect(ignoredGaps(l, "CA")).toEqual(["who"]);
    expect(ignoredGaps(l, "CE")).toEqual([]);
  });

  it("stops flagging a learned gap for that project only, and the rest of the notice stands", () => {
    const taught: ClarityLearning = { CA: { who: 3, done: 2 } };
    expect(flaggedGaps(["short", "done", "who"], taught, "CA")).toEqual(["short", "done"]);
    expect(flaggedGaps(["short", "done", "who"], taught, "CE")).toEqual(["short", "done", "who"]);
    expect(flaggedGaps(["who"], taught, "CA")).toEqual([]);
  });

  it("is given back for one project or for all of them", () => {
    const taught: ClarityLearning = { CA: { who: 3 }, CE: { scope: 4 } };
    expect(forget(taught, "CA")).toEqual({ CE: { scope: 4 } });
    expect(forget(taught)).toEqual({});
    expect(learnedList(taught)).toEqual([
      { project: "CA", gaps: ["who"] },
      { project: "CE", gaps: ["scope"] },
    ]);
    expect(learnedList({ CA: { who: 2 } })).toEqual([]);
  });

  it("gives back one gap of a project and leaves its other gaps, other projects and an emptied project right", () => {
    const taught: ClarityLearning = { CA: { who: 3, scope: 4, done: 1 }, CE: { scope: 4 } };
    expect(forget(taught, "CA", ["who"])).toEqual({ CA: { scope: 4, done: 1 }, CE: { scope: 4 } });
    expect(forget(taught, "CA", ["who", "scope"])).toEqual({ CA: { done: 1 }, CE: { scope: 4 } });
    expect(forget({ CE: { scope: 4 } }, "CE", ["scope"])).toEqual({});
    expect(forget(taught, "WEB", ["who"])).toEqual(taught);
    expect(taught.CA).toEqual({ who: 3, scope: 4, done: 1 });
  });

  it("names the gaps of a ticket that are taught away, and says each gap in a few words", () => {
    const taught: ClarityLearning = { CA: { who: 3, scope: 2, done: 5 } };
    expect(ignoredAmong(["short", "done", "scope", "who"], taught, "CA")).toEqual(["done", "who"]);
    expect(ignoredAmong(["short", "done"], taught, "CE")).toEqual([]);
    expect(Object.keys(SHORT_GAP).sort()).toEqual(["done", "empty", "scope", "short", "who"]);
    for (const g of Object.values(SHORT_GAP)) expect(g.length).toBeLessThan(26);
  });

  it("reads a ticket's project from its key, and a stored value defensively", () => {
    expect(projectOfKey("ca-408")).toBe("CA");
    expect(projectOfKey("CRM-1")).toBe("CRM");
    expect(parseLearning({ ca: { who: 3, nope: 2, done: -1, scope: 1.5 }, CE: "x", CX: null })).toEqual({ CA: { who: 3 } });
    expect(parseLearning(null)).toEqual({});
    expect(parseLearning([1, 2])).toEqual({});
  });

  it("says a learned gap in the audit's words", () => {
    expect(learnedDetail("who", "CA")).toBe("who in CA");
    expect(learnedWords("who in CA")).toBe("CA tickets that don't say who is waiting on them");
    expect(learnedWords("short in CE")).toBe("CE tickets that have a very short description");
    expect(learnedWords("garbage")).toBe("a gap");
    expect(learnedWords(null)).toBe("a gap");
  });
});
