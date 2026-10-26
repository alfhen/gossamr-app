import { describe, expect, it } from "vitest";
import type { Run, WorkstreamView } from "../types";
import { NUDGE_AFTER_DAYS } from "./reporterWait";
import { OWED_DETAIL, ON_REPORTER_DETAIL, answersOwed, QUIET_DAYS, REPLIED_DETAIL, REPLIED_HINT, STATUS_HINT, UNCLEAR_HINT, hintFor, UNCLEAR_DETAIL, workstreamStatus, type StatusMore, type StatusState } from "./workstreamStatus";

const NOW = new Date("2026-10-13T09:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const view = (over: Partial<WorkstreamView> = {}, ws: Partial<WorkstreamView["workstream"]> = {}): WorkstreamView =>
  ({ workstream: { id: "w1", connectionId: "c", itemKey: "CA-401", title: "CA-401 Thing", pausedReason: null, closedAt: null, createdAt: ago(1), ...ws }, stage: "intake", runs: ["r1"], labels: [], budget: {}, ...over }) as unknown as WorkstreamView;

const run = (state: Run["state"], kind: Run["spec"]["kind"] = "build", over: Partial<Run> = {}): Run => ({ id: "r1", state, spec: { kind, workstream: "w1" }, queuedAt: ago(0.5), launchedAt: ago(0.5), endedAt: null, ...over }) as unknown as Run;
const need = { workstreamId: "w1" };
const at = (v: WorkstreamView, needs: { workstreamId: string | null }[] = [], more: StatusMore = {}) => workstreamStatus(v, needs, { now: NOW, ...more });

describe("workstreamStatus: every state", () => {
  it("Needs you: a need in this workstream, counted in the detail, and another workstream's need is not", () => {
    expect(at(view(), [need, need])).toMatchObject({ state: "needs-you", word: "Needs you", detail: "2 waiting" });
    expect(at(view(), [{ workstreamId: "w2" }, { workstreamId: null }]).state).toBe("idle");
  });

  it("Needs you: says after the count that the reporter has been asked too, and that the person owes answers (G23)", () => {
    const asked = view({ waitingOnReporter: { since: ago(2) } });
    expect(at(asked, [need])).toMatchObject({ state: "needs-you", detail: `1 waiting · ${ON_REPORTER_DETAIL}` });
    expect(at(view(), [need], { answersOwed: true })).toMatchObject({ state: "needs-you", detail: `1 waiting · ${OWED_DETAIL}` });
    expect(at(asked, [need, need], { answersOwed: true }).detail).toBe(`2 waiting · ${ON_REPORTER_DETAIL} · ${OWED_DETAIL}`);
    expect(ON_REPORTER_DETAIL).toBe("waiting on reporter");
    expect(OWED_DETAIL).toBe("your answers owed");
  });

  it("Idle: the person who chose I'll answer sees their answers are owed, unless something failed", () => {
    expect(at(view(), [], { answersOwed: true })).toMatchObject({ state: "idle", detail: OWED_DETAIL });
    expect(at(view(), [], { runs: [run("failed", "plan")], answersOwed: true }).detail).toBe("Plan failed");
    expect(at(view(), []).detail).toBeNull();
  });

  it("answersOwed reads the audit and the drafts: I'll answer with no answers drafted since", () => {
    const events = [{ actor: "person", action: "readiness_answered", at: "2026-10-12T10:00:00Z" }] as never;
    expect(answersOwed("w1", events, [])).toBe(true);
    expect(answersOwed("w1", undefined, [])).toBe(false);
    expect(answersOwed("w1", [{ actor: "person", action: "readiness_asked", at: "2026-10-12T10:00:00Z" }] as never, [])).toBe(false);
  });

  it("Needs you: a pause is a need, and its reason is the detail when it is the only one", () => {
    expect(at(view({}, { pausedReason: "person" }), [need])).toMatchObject({ state: "needs-you", detail: "Paused" });
    expect(at(view({}, { pausedReason: "ceiling" }), [need]).detail).toBe("Paused: Pip was woken too often today");
    expect(at(view({}, { pausedReason: "person" }), [need, need]).detail).toBe("2 waiting");
  });

  it("Waiting on reporter, with the days", () => {
    expect(at(view({ waitingOnReporter: { since: ago(3) } }))).toMatchObject({ state: "waiting", word: "Waiting on reporter", detail: "asked 3 days ago" });
    expect(at(view({ waitingOnReporter: { since: ago(0.2) } })).detail).toBe("asked today");
    expect(at(view({ waitingOnReporter: { since: ago(1.2) } })).detail).toBe("asked yesterday");
  });

  it("Running: a run going, or queued for a slot, named by its kind", () => {
    expect(at(view(), [], { runs: [run("working", "plan")] })).toMatchObject({ state: "running", detail: "Plan" });
    expect(at(view(), [], { runs: [run("launching")] }).detail).toBe("Build");
    expect(at(view(), [], { runs: [run("queued", "review")] })).toMatchObject({ state: "running", detail: "Review queued" });
    expect(at(view(), [], { runs: [run("done")] }).state).toBe("idle");
    // Only the workstream's own runs.
    expect(at(view(), [], { runs: [run("working", "build", { id: "r9" })] }).state).toBe("idle");
  });

  it("Idle says the reporter replied once they have, in place of 'may be unclear'", () => {
    const thin = view({ clarity: { gaps: ["short"] }, reporterReplied: true } as Partial<WorkstreamView>);
    expect(at(thin)).toMatchObject({ state: "idle", detail: REPLIED_DETAIL });
    expect(REPLIED_DETAIL).toBe("reporter replied");
    expect(at(view({ clarity: { gaps: ["short"] } } as Partial<WorkstreamView>)).detail).toBe(UNCLEAR_DETAIL);
  });

  it("Idle says it may be unclear while the word check notice stands: a notice, never a need, so the word stays Idle", () => {
    const thin = view({ clarity: { gaps: ["short", "done"] } });
    expect(at(thin)).toMatchObject({ state: "idle", word: "Idle", detail: UNCLEAR_DETAIL });
    expect(UNCLEAR_DETAIL).toBe("may be unclear");
    // What Looks fine taught away is not flagged, so the notice has nothing to say and neither does the pill.
    expect(at(thin, [], { learning: { CA: { short: 3, done: 3 } } }).detail).toBeNull();
    expect(at(thin, [], { learning: { CE: { short: 3, done: 3 } } }).detail).toBe("may be unclear");
    // A need, a hold or a wait is still what the word says; a failed run's detail wins over the notice.
    expect(at(thin, [need]).state).toBe("needs-you");
    expect(at(view({ clarity: { gaps: ["short"] }, waitingOnReporter: { since: ago(1) } })).state).toBe("waiting");
    expect(at(thin, [], { runs: [run("failed", "review", { endedAt: ago(0.2) })] }).detail).toBe("Review failed");
  });

  it("Quiet: no activity for a while; never for a closed workstream", () => {
    expect(at(view({}, { createdAt: ago(6) }))).toMatchObject({ state: "idle", detail: null });
    expect(at(view({}, { createdAt: ago(QUIET_DAYS + 2) }))).toMatchObject({ state: "quiet", detail: `no activity · ${QUIET_DAYS + 2}d` });
    expect(at(view({}, { createdAt: ago(QUIET_DAYS + 2) }), [], { runs: [run("done", "build", { queuedAt: ago(1), launchedAt: ago(1), endedAt: ago(1) })] }).state).toBe("idle");
    expect(at(view({}, { closedAt: ago(1), createdAt: ago(30) })).state).toBe("done");
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
  const everything = view({ waitingOnReporter: { since: ago(3) } }, { pausedReason: "person" });
  const more: StatusMore = { runs: [run("working")] };

  it("goes Needs you, Waiting on reporter, Running, Quiet, Done, Idle, each beating all the ones after it", () => {
    expect(at(everything, [need], more).state).toBe("needs-you");
    expect(at(everything, [], more).state).toBe("waiting");
    expect(at(view({ waitingOnReporter: { since: ago(3) } }), [], more).state).toBe("waiting");
    expect(at(view(), [], more).state).toBe("running");
    expect(at(view({}, { createdAt: ago(QUIET_DAYS + 2) }), [], {}).state).toBe("quiet");
    expect(at(view({ stage: "done" }), [], {}).state).toBe("done");
    expect(at(view(), [], {}).state).toBe("idle");
  });
});

describe("status hints", () => {
  it("explains every state, and the waiting hint names what ends the wait and when a nudge comes", () => {
    for (const s of Object.keys(STATUS_HINT) as StatusState[]) expect(STATUS_HINT[s].length).toBeGreaterThan(20);
    expect(STATUS_HINT.waiting).toContain(`after ${NUDGE_AFTER_DAYS} days`);
  });

  it("keeps the Idle hint short and explains \"may be unclear\" only where the pill carries it (G11)", () => {
    expect(STATUS_HINT.idle).toBe("Nothing is running and nothing waits on you.");
    expect(hintFor({ state: "idle", detail: null })).toBe(STATUS_HINT.idle);
    expect(hintFor({ state: "idle", detail: UNCLEAR_DETAIL })).toBe(`${STATUS_HINT.idle} ${UNCLEAR_HINT}`);
    expect(hintFor({ state: "running", detail: UNCLEAR_DETAIL })).toBe(STATUS_HINT.running);
    // Once the reporter has answered, the hint no longer says nothing waits on the person (G10).
    expect(hintFor({ state: "idle", detail: REPLIED_DETAIL })).toBe(REPLIED_HINT);
    expect(REPLIED_HINT).not.toContain("nothing waits on you");
    expect(hintFor({ state: "running", detail: REPLIED_DETAIL })).toBe(STATUS_HINT.running);
  });

});
