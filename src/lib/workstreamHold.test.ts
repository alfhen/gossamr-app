import { describe, expect, it } from "vitest";
import { AUTO_TURNS_DEFAULT, HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_PERSON, HELD_QUOTA, HELD_RESTART, TRIPWIRE, TRIPWIRES, WORKSTREAM_RULES } from "../types";
import type { BudgetView, Workstream } from "../types";
import { FIX_ROUNDS_MAX } from "../backend/mockSupervisor";
import { STEP_HELP, budgetLevel, budgetView, heldBanner, heldText, ruleText, stepsLeftText, tripwireResumeText } from "./workstreamHold";

describe("heldText", () => {
  it("says nothing for a workstream that isn't held", () => {
    expect(heldText(null)).toBeNull();
    expect(heldText(undefined)).toBeNull();
    expect(heldText("")).toBeNull();
  });

  it("names every hold reason", () => {
    expect(heldText(HELD_RESTART)).toBe("Held after a restart");
    expect(heldText(HELD_PERSON)).toBe("Held by you");
    expect(heldText(HELD_ALL)).toBe("Held by you (Hold all)");
    expect(heldText(HELD_BUDGET)).toBe("Held: automatic steps used up. Resume to give it 11 more");
    const budget = (autoTurns: [number, number], wakes: [number, number]): BudgetView => ({ autoTurns: { used: autoTurns[0], limit: autoTurns[1] }, wakes: { used: wakes[0], limit: wakes[1] }, level: "spent" });
    // One unit, whichever counter is nearer its limit; neither is named.
    expect(heldText(HELD_BUDGET, null, budget([3, 3], [3, 12]))).toBe("Held: automatic steps used up. Resume to give it 3 more");
    expect(heldText(HELD_BUDGET, null, budget([2, 6], [12, 12]))).toBe("Held: automatic steps used up. Resume to give it 12 more");
    expect(heldText(HELD_BUDGET, null, budget([6, 6], [12, 12]))).toBe("Held: automatic steps used up. Resume to give it 6 more");
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

  it("never says tripwire to the person, for any hold", () => {
    const reasons = [HELD_RESTART, HELD_PERSON, HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_QUOTA, ...TRIPWIRES.map((k) => `${TRIPWIRE}${k}`), `${TRIPWIRE}other`];
    for (const reason of reasons) for (const drifted of [undefined, ["summary"] as const, ["status"] as const]) expect(heldText(reason, drifted)).not.toMatch(/tripwire/i);
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

  it("says for a tripwire that took Manage away that automatic steps are paused and Resume turns them back on", () => {
    const drift = `${TRIPWIRE}basis_drift`;
    expect(heldBanner({ heldReason: drift, drifted: ["description"], resumeMode: "manage" })).toBe("Held: the ticket's description changed in Jira. Automatic steps are paused. Resume turns them back on.");
    expect(heldBanner({ heldReason: drift, drifted: ["description"], resumeMode: null })).toBe("Held: the ticket's description changed in Jira. Resume only lifts the hold; Manage stays off.");
    expect(tripwireResumeText(`${TRIPWIRE}marker`, "manage")).toBe("Automatic steps are paused. Resume turns them back on.");
    // A trip that landed on another hold took Manage away too: that hold's banner says so, as the switch does.
    expect(tripwireResumeText(HELD_PERSON, "manage")).toBe("Automatic steps are paused. Resume turns them back on.");
    expect(heldBanner({ heldReason: HELD_PERSON, resumeMode: "manage" })).toBe("Held by you. Automatic steps are paused. Resume turns them back on.");
    // Any other hold says only why; the budget's says how many turns resuming gives.
    expect(tripwireResumeText(HELD_PERSON, null, "manage")).toBeNull();
    expect(heldBanner({ heldReason: HELD_PERSON })).toBe("Held by you");
    expect(heldBanner({ heldReason: HELD_BUDGET })).toBe("Held: automatic steps used up. Resume to give it 11 more");
    // Manage switched back on while a tripwire holds it: Resume turns the automatic steps on, whatever resumeMode says.
    expect(heldBanner({ heldReason: drift, drifted: ["description"], resumeMode: null, mode: "manage" })).toBe("Held: the ticket's description changed in Jira. Automatic steps are paused. Resume turns them back on.");
    expect(tripwireResumeText(`${TRIPWIRE}marker`, null, "manage")).toBe("Automatic steps are paused. Resume turns them back on.");
    expect(tripwireResumeText(`${TRIPWIRE}marker`, null, "advise")).toBe("Resume only lifts the hold; Manage stays off.");
    expect(heldBanner({ heldReason: null })).toBeNull();
    expect(STEP_HELP).toMatch(/^An automatic step is each time Pip acts without you asking/);
    expect(STEP_HELP).toContain("Automatic fix rounds don't count");
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
    expect(AUTO_TURNS_DEFAULT).toBe(11);
    expect(budgetView(fresh(4, 0))).toEqual({ autoTurns: { used: 4, limit: 11 }, wakes: { used: 0, limit: 12 }, level: "ok" });
    expect(budgetLevel(fresh(8, 0))).toBe("ok");
    expect(budgetLevel(fresh(9, 0))).toBe("amber");
    expect(budgetLevel(fresh(11, 0))).toBe("spent");
    expect(budgetLevel(fresh(0, 10))).toBe("amber");
  });

  it("keeps a stored explicit limit and only the default changed", () => {
    const own = (turns: number) => ws(turns, 0, { autoTurns: 6, wakes: null });
    expect(budgetView(own(0)).autoTurns).toEqual({ used: 0, limit: 6 });
    expect(budgetLevel(own(6))).toBe("spent");
    expect(budgetLevel(own(5))).toBe("amber");
  });

  it("fits a whole automatic chain with steps to spare, whatever the fix rounds", () => {
    // investigate, triage, plan, build, the review that passes and verify; each finished run is a step. A fix round (the
    // review that sends it and the build that comes back) costs none, so FIX_ROUNDS_MAX changes nothing here.
    const chain = 6;
    expect(FIX_ROUNDS_MAX).toBe(2);
    expect(AUTO_TURNS_DEFAULT).toBe(chain + 5);
  });
});

describe("stepsLeftText", () => {
  const budget = (used: number, limit: number): BudgetView => ({ autoTurns: { used, limit }, wakes: { used: 0, limit: 12 }, level: "ok" });
  it("says how many of the automatic steps are left, never below none", () => {
    expect(stepsLeftText(budget(0, 11))).toBe("11 of 11 automatic steps left");
    expect(stepsLeftText(budget(4, 11))).toBe("7 of 11 automatic steps left");
    expect(stepsLeftText(budget(11, 11))).toBe("0 of 11 automatic steps left");
    expect(stepsLeftText(budget(13, 11))).toBe("0 of 11 automatic steps left");
    expect(stepsLeftText(budget(1, 6))).toBe("5 of 6 automatic steps left");
  });
});
