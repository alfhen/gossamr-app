import { describe, expect, it } from "vitest";
import { HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_PERSON, HELD_QUOTA, HELD_RESTART, TRIPWIRE, TRIPWIRES } from "../types";
import type { Run, WorkstreamView } from "../types";
import { NUDGE_AFTER_DAYS } from "./reporterWait";
import { EMPTY_FILTER, QUIET_DAYS, STATUS_HINT, STATUS_ORDER, statusFromWords, workstreamStatus, type StatusMore } from "./workstreamStatus";
import type { WorkstreamWither } from "./workstreamWither";

const NOW = new Date("2026-10-13T09:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const view = (over: Partial<WorkstreamView> = {}, ws: Partial<WorkstreamView["workstream"]> = {}): WorkstreamView =>
  ({ workstream: { id: "w1", connectionId: "c", itemKey: "CA-401", title: "CA-401 Thing", heldReason: null, closedAt: null, createdAt: ago(1), ...ws }, stage: "intake", runs: ["r1"], labels: [], budget: {}, ...over }) as unknown as WorkstreamView;

const run = (state: Run["state"], kind: Run["spec"]["kind"] = "build", over: Partial<Run> = {}): Run => ({ id: "r1", state, spec: { kind, workstream: "w1" }, queuedAt: ago(0.5), launchedAt: ago(0.5), endedAt: null, ...over }) as unknown as Run;
const need = { workstreamId: "w1" };
const web = (days = 6, over: Partial<WorkstreamWither> = {}): WorkstreamWither => ({ level: 3, days, since: ago(days), runs: 2, turns: 0, text: "", ...over });
const at = (v: WorkstreamView, needs: { workstreamId: string | null }[] = [], more: StatusMore = {}) => workstreamStatus(v, needs, { now: NOW, ...more });

describe("workstreamStatus: every state", () => {
  it("Needs you: a need in this workstream, counted in the detail, and another workstream's need is not", () => {
    expect(at(view(), [need, need])).toMatchObject({ state: "needs-you", word: "Needs you", detail: "2 waiting" });
    expect(at(view(), [{ workstreamId: "w2" }, { workstreamId: null }]).state).toBe("idle");
  });

  it("Held: by the system with its reason, or by you with no detail", () => {
    expect(at(view({}, { heldReason: HELD_RESTART }))).toMatchObject({ state: "held", word: "Held", detail: "after a restart" });
    expect(at(view({}, { heldReason: HELD_BUDGET }))).toMatchObject({ state: "held", detail: "automatic steps used up" });
    expect(at(view({}, { heldReason: HELD_DAILY })).detail).toBe("today's Pip turns used up");
    expect(at(view({}, { heldReason: HELD_QUOTA })).detail).toBe("quota");
    expect(at(view({}, { heldReason: `${TRIPWIRE}basis_drift`, drifted: ["description"] })).detail).toBe("the ticket's description changed in Jira");
    expect(at(view({}, { heldReason: HELD_PERSON }))).toMatchObject({ state: "held", word: "Held by you", detail: null });
    expect(at(view({}, { heldReason: HELD_ALL }))).toMatchObject({ state: "held", word: "Held by you (Hold all)", detail: null });
  });

  it("never says tripwire", () => {
    for (const k of [...TRIPWIRES, "other"]) expect(JSON.stringify(at(view({}, { heldReason: `${TRIPWIRE}${k}` })))).not.toMatch(/tripwire/i);
  });

  it("Waiting on reporter, with the days", () => {
    expect(at(view({ waitingOnReporter: { since: ago(3) } }))).toMatchObject({ state: "waiting", word: "Waiting on reporter", detail: "3d" });
    expect(at(view({ waitingOnReporter: { since: ago(0.2) } })).detail).toBe("0d");
  });

  it("Running: a run going, or queued for a slot, named by its kind", () => {
    expect(at(view(), [], { runs: [run("working", "plan")] })).toMatchObject({ state: "running", detail: "Plan" });
    expect(at(view(), [], { runs: [run("launching")] }).detail).toBe("Build");
    expect(at(view(), [], { runs: [run("queued", "review")] })).toMatchObject({ state: "running", detail: "Review queued" });
    expect(at(view(), [], { runs: [run("done")] }).state).toBe("idle");
    // Only the workstream's own runs.
    expect(at(view(), [], { runs: [run("working", "build", { id: "r9" })] }).state).toBe("idle");
  });

  it("Quiet: a cobweb, or no activity for a while; never for a closed workstream", () => {
    expect(at(view(), [], { wither: web(6) })).toMatchObject({ state: "quiet", word: "Quiet", detail: "No Jira update · 6d" });
    expect(at(view(), [], { wither: web(4, { reporter: true }) }).detail).toBe("Reporter hasn't answered · 4d");
    expect(at(view({}, { createdAt: ago(QUIET_DAYS + 2) }))).toMatchObject({ state: "quiet", detail: `no activity · ${QUIET_DAYS + 2}d` });
    expect(at(view({}, { createdAt: ago(QUIET_DAYS + 2) }), [], { runs: [run("done", "build", { queuedAt: ago(1), launchedAt: ago(1), endedAt: ago(1) })] }).state).toBe("idle");
    expect(at(view({}, { closedAt: ago(1), createdAt: ago(30) }), [], { wither: web(6) }).state).toBe("done");
    expect(at(view({}, { createdAt: ago(3) }), [], { quietDays: 2 }).state).toBe("quiet");
  });

  it("Done: closed, or its stage is done", () => {
    expect(at(view({}, { closedAt: ago(1) })).state).toBe("done");
    expect(at(view({ stage: "done" }))).toMatchObject({ state: "done", word: "Done", detail: null });
  });

  it("Idle: otherwise, saying a failed last run", () => {
    expect(at(view())).toMatchObject({ state: "idle", word: "Idle", detail: null });
    expect(at(view(), [], { runs: [run("failed", "triage")] }).detail).toBe("Triage failed");
  });
});

describe("workstreamStatus: priority", () => {
  const everything = view({ waitingOnReporter: { since: ago(3) } }, { heldReason: HELD_PERSON });
  const more: StatusMore = { runs: [run("working")], wither: web(6) };

  it("goes Needs you, Held, Waiting on reporter, Running, Quiet, Done, Idle, each beating all the ones after it", () => {
    expect(at(everything, [need], more).state).toBe("needs-you");
    expect(at(everything, [], more).state).toBe("held");
    expect(at(view({ waitingOnReporter: { since: ago(3) } }), [], more).state).toBe("waiting");
    expect(at(view(), [], more).state).toBe("running");
    expect(at(view(), [], { wither: web(6) }).state).toBe("quiet");
    expect(at(view({ stage: "done" }), [], {}).state).toBe("done");
    expect(at(view(), [], {}).state).toBe("idle");
  });

  it("lists the states in that order", () => {
    expect(STATUS_ORDER).toEqual(["needs-you", "held", "waiting", "running", "quiet", "done", "idle"]);
  });

  it("a hold the system made, with its need, says Needs you and gives the hold's reason as the detail; the hold you chose gives a count", () => {
    expect(at(view({}, { heldReason: HELD_RESTART }), [need])).toMatchObject({ state: "needs-you", detail: "Held after a restart" });
    expect(at(view({}, { heldReason: `${TRIPWIRE}basis_drift`, drifted: ["status"] }), [need]).detail).toBe("Held: the ticket was moved to Done");
    expect(at(view({}, { heldReason: HELD_PERSON }), [need, need])).toMatchObject({ state: "needs-you", detail: "2 waiting" });
    expect(at(view({}, { heldReason: HELD_RESTART }), [need, need]).detail).toBe("2 waiting");
  });
});

describe("statusFromWords", () => {
  it("reads the words a person types", () => {
    expect(statusFromWords("waiting on reporter")).toBe("waiting");
    expect(statusFromWords("Waiting on the reporter")).toBe("waiting");
    expect(statusFromWords(" needs  you ")).toBe("needs-you");
    expect(statusFromWords("held by you")).toBe("held");
    expect(statusFromWords("quiet")).toBe("quiet");
    expect(statusFromWords("nonsense")).toBeNull();
    expect(statusFromWords("")).toBeNull();
  });
});

describe("status hints and empty filters", () => {
  it("explains every state, and the waiting hint names what ends the wait and when a nudge comes", () => {
    for (const s of STATUS_ORDER) expect(STATUS_HINT[s].length).toBeGreaterThan(20);
    expect(STATUS_HINT.waiting).toContain(`after ${NUDGE_AFTER_DAYS} days`);
  });

  it("has a sentence for every filter that reads naturally", () => {
    for (const s of STATUS_ORDER) expect(EMPTY_FILTER[s]).toMatch(/^No workstream .+\.$/);
    expect(EMPTY_FILTER["needs-you"]).toBe("No workstream needs you.");
    expect(EMPTY_FILTER.waiting).toBe("No workstream is waiting on the reporter.");
  });
});
