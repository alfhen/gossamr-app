import { describe, expect, it } from "vitest";
import { HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_PERSON, HELD_QUOTA, HELD_RESTART, TRIPWIRE, TRIPWIRES, WORKSTREAM_RULES } from "../types";
import type { Workstream } from "../types";
import { budgetLevel, budgetView, heldText, ruleText } from "./workstreamHold";

describe("heldText", () => {
  it("says nothing for a workstream that isn't held", () => {
    expect(heldText(null)).toBeNull();
    expect(heldText(undefined)).toBeNull();
    expect(heldText("")).toBeNull();
  });

  it("names every hold reason", () => {
    expect(heldText(HELD_RESTART)).toBe("Held after a restart");
    expect(heldText(HELD_PERSON)).toBe("Held by you");
    expect(heldText(HELD_ALL)).toBe("Held: Hold all");
    expect(heldText(HELD_BUDGET)).toBe("Budget used up. Say carry on to continue");
    expect(heldText(HELD_DAILY)).toBe("Held: today's Pip turns are used up");
    expect(heldText(HELD_QUOTA)).toBe("Paused: quota");
  });

  it("names every tripwire, and an unknown reason still reads as held", () => {
    const texts = TRIPWIRES.map((k) => heldText(`${TRIPWIRE}${k}`));
    expect(texts.every((t) => t?.startsWith("Held: "))).toBe(true);
    expect(new Set(texts).size).toBe(TRIPWIRES.length);
    expect(heldText("tripwire:marker")).toContain("data markers");
    expect(heldText("tripwire:other")).toBe("Held");
    expect(heldText("something newer")).toBe("Held");
  });

  it("says what changed in Jira for a basis-drift hold", () => {
    const drift = `${TRIPWIRE}basis_drift`;
    expect(heldText(drift, ["description"])).toBe("Held: the ticket's description changed in Jira");
    expect(heldText(drift, ["summary"])).toBe("Held: the ticket's summary changed in Jira");
    expect(heldText(drift, ["summary", "description"])).toBe("Held: the ticket's summary and description changed in Jira");
    expect(heldText(drift, ["description", "summary"])).toBe("Held: the ticket's summary and description changed in Jira");
    expect(heldText(drift, ["status"])).toBe("Held: the ticket was moved to Done");
    expect(heldText(drift, ["description", "status"])).toBe("Held: the ticket's description changed and it was moved to Done");
    expect(heldText(drift, [])).toBe("Held: the ticket changed since the workstream opened");
    expect(heldText(drift)).toBe("Held: the ticket changed since the workstream opened");
    expect(heldText("tripwire:marker", ["description"])).toContain("data markers");
    expect(heldText(HELD_PERSON, ["description"])).toBe("Held by you");
  });

  it("names every rule", () => {
    const names = WORKSTREAM_RULES.map(ruleText);
    expect(new Set(names).size).toBe(WORKSTREAM_RULES.length);
    expect(ruleText("triage_plan")).toBe("Triage → Plan");
  });
});

describe("budgetLevel", () => {
  const ws = (autoTurns: number, wakes: number, limits: { autoTurns: number | null; wakes: number | null } = { autoTurns: 100, wakes: 100 }): Workstream => ({
    id: "ws-1",
    connectionId: "mock",
    itemKey: null,
    repo: null,
    title: "t",
    pipSession: null,
    mode: "manage",
    heldReason: null,
    notes: null,
    createdAt: "2026-10-01T10:00:00Z",
    closedAt: null,
    budget: { ...limits, tokens: null },
    spent: { autoTurns, wakes, tokens: 0 },
    rules: {},
    basis: null,
  });

  it("is amber from 80% of either limit and spent at 100%, as the backend works it out", () => {
    expect(budgetLevel(ws(79, 0))).toBe("ok");
    expect(budgetLevel(ws(80, 0))).toBe("amber");
    expect(budgetLevel(ws(0, 80))).toBe("amber");
    expect(budgetLevel(ws(100, 0))).toBe("spent");
    expect(budgetLevel(ws(80, 120))).toBe("spent");
  });

  it("fills in the default limits", () => {
    const fresh = (turns: number, wakes: number) => ws(turns, wakes, { autoTurns: null, wakes: null });
    expect(budgetView(fresh(4, 0))).toEqual({ autoTurns: { used: 4, limit: 6 }, wakes: { used: 0, limit: 12 }, level: "ok" });
    expect(budgetLevel(fresh(5, 0))).toBe("amber");
    expect(budgetLevel(fresh(6, 0))).toBe("spent");
    expect(budgetLevel(fresh(0, 10))).toBe("amber");
  });
});
