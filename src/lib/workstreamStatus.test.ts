import { describe, expect, it } from "vitest";
import type { Run, WorkstreamView } from "../types";
import { STATUS_HINT, STATUS_WORD, hintFor, workstreamStatus, type StatusMore, type StatusState } from "./workstreamStatus";

const NOW = new Date("2026-10-13T09:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const view = (over: Partial<WorkstreamView> = {}, ws: Partial<WorkstreamView["workstream"]> = {}): WorkstreamView =>
  ({ workstream: { id: "w1", connectionId: "c", itemKey: "CA-401", title: "CA-401 Thing", pausedReason: null, closedAt: null, createdAt: ago(1), ...ws }, stage: "intake", runs: ["r1"], labels: [], budget: {}, ...over }) as unknown as WorkstreamView;

const run = (state: Run["state"], kind: Run["spec"]["role"] = "build", over: Partial<Run> = {}): Run => ({ id: "r1", state, spec: { role: kind, workstream: "w1" }, queuedAt: ago(0.5), launchedAt: ago(0.5), endedAt: null, ...over }) as unknown as Run;
const need = { workstreamId: "w1" };
const at = (v: WorkstreamView, needs: { workstreamId: string | null }[] = [], more: StatusMore = {}) => workstreamStatus(v, needs, more);

describe("workstreamStatus: every state", () => {
  it("Needs you: a need in this workstream, counted in the detail, and another workstream's need is not", () => {
    expect(at(view(), [need, need])).toMatchObject({ state: "needs-you", word: "Needs you", detail: "2 waiting" });
    expect(at(view(), [{ workstreamId: "w2" }, { workstreamId: null }]).state).toBe("idle");
  });

  it("a paused workstream needs you", () => {
    expect(at(view({}, { pausedReason: "person" }), [need])).toMatchObject({ state: "needs-you", word: "Needs you", detail: "1 waiting" });
  });

  it("Needs you: a pause beside another need is counted with it", () => {
    expect(at(view({}, { pausedReason: "person" }), [need, need])).toMatchObject({ state: "needs-you", detail: "2 waiting" });
  });

  it("Running: a run going, or queued for a slot, named by its kind", () => {
    expect(at(view(), [], { runs: [run("working", "plan")] })).toMatchObject({ state: "running", detail: "Plan" });
    expect(at(view(), [], { runs: [run("launching")] }).detail).toBe("Build");
    expect(at(view(), [], { runs: [run("queued", "review")] })).toMatchObject({ state: "running", detail: "Review queued" });
    expect(at(view(), [], { runs: [run("done")] }).state).toBe("idle");
    // Only the workstream's own runs.
    expect(at(view(), [], { runs: [run("working", "build", { id: "r9" })] }).state).toBe("idle");
  });

  it("Done: closed, or its stage is done", () => {
    expect(at(view({}, { closedAt: ago(1) })).state).toBe("done");
    expect(at(view({ stage: "done" }))).toMatchObject({ state: "done", word: "Done", detail: null });
  });

  it("Failed: a failed agent is named before a running one", () => {
    expect(at(view(), [], { runs: [run("failed", "triage"), run("working", "build", { id: "r2" })] })).toMatchObject({ state: "failed", word: "Failed", detail: "Triage" });
  });

  it("Failed: stays while a failure is the last word on its work, but not once a newer run of that role follows, it is archived or the person dismissed it", () => {
    const failed = run("failed", "build", { id: "r1", queuedAt: ago(1) });
    expect(at(view({ runs: ["r1"] }), [], { runs: [failed] }).state).toBe("failed");
    expect(at(view({ runs: ["r1"] }), [], { runs: [failed], dismissed: new Set(["r1"]) }).state).toBe("idle");
    expect(at(view({ runs: ["r1", "r2"] }), [], { runs: [failed, run("done", "build", { id: "r2", queuedAt: ago(0.5) })] }).state).toBe("idle");
    expect(at(view({ runs: ["r1"] }), [], { runs: [{ ...failed, archivedAt: ago(0.1) }] }).state).toBe("idle");
  });

  it("a dismissed failure does not outrank a running agent or a closed workstream", () => {
    const dismissed = new Set(["r1"]);
    const failed = run("failed", "build", { id: "r1", queuedAt: ago(2) });
    expect(at(view({ runs: ["r1", "r2"] }), [], { runs: [failed, run("working", "plan", { id: "r2" })], dismissed })).toMatchObject({ state: "running", detail: "Plan" });
    expect(at(view({ runs: ["r1"] }, { closedAt: ago(1) }), [], { runs: [failed], dismissed }).state).toBe("done");
  });

  it("a run whose session is not listed is not Failed until the backend's recovery window marks it failed", () => {
    expect(at(view(), [], { runs: [run("unknown", "build")] }).state).not.toBe("failed");
  });

  it("Idle: otherwise, however long nothing has happened", () => {
    expect(at(view())).toMatchObject({ state: "idle", word: "Idle", detail: null });
    expect(at(view({}, { createdAt: ago(30) }))).toMatchObject({ state: "idle", detail: null });
    expect(at(view(), [], { runs: [run("failed", "triage")] }).state).toBe("failed");
  });
});

describe("workstreamStatus: priority", () => {
  const paused = view({}, { pausedReason: "person" });
  const more: StatusMore = { runs: [run("working")] };

  it("goes Needs you, Failed, Running, Done, Idle, each beating all the ones after it", () => {
    const failed = run("failed", "plan", { id: "r2" });
    const everything: StatusMore = { runs: [run("working"), failed] };
    const closed = view({ runs: ["r1", "r2"] }, { closedAt: ago(1) });
    expect(at(paused, [need], everything).state).toBe("needs-you");
    expect(at(closed, [need], everything).state).toBe("needs-you");
    expect(at(closed, [], everything).state).toBe("failed");
    expect(at(closed, [], more).state).toBe("running");
    expect(at(closed, [], {}).state).toBe("done");
    expect(at(view(), [], {}).state).toBe("idle");
  });

  it("is always one of the five words", () => {
    expect(Object.values(STATUS_WORD).sort()).toEqual(["Done", "Failed", "Idle", "Needs you", "Running"]);
  });
});

describe("status hints", () => {
  it("explains every state", () => {
    for (const s of Object.keys(STATUS_HINT) as StatusState[]) {
      expect(STATUS_HINT[s].length).toBeGreaterThan(20);
      expect(hintFor({ state: s })).toBe(STATUS_HINT[s]);
    }
    expect(STATUS_HINT.idle).toBe("Nothing is running and nothing waits on you.");
  });
});
