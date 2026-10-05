import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run, RunState } from "../types";
import { BIG_BYTES, bulkCleanup, cleanable, cleanupReason, cleanupReport } from "./cleanupLogic";
import { RunCleanupView } from "./RunCleanup";
import { useRuns } from "./runsStore";
import { useToasts } from "./toasts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const DAY = 86_400_000;
const base = new MockBackend().runs.list()[0];
const run = (state: RunState, over: Partial<Run> = {}): Run => ({ ...base, id: `r-${state}`, state, shortId: "1000a000", worktreeRemovedAt: null, endedAt: new Date(NOW - DAY).toISOString(), lastProgressAt: new Date(NOW - DAY).toISOString(), ...over });
const nothing = { disk: null, change: null };

describe("when cleaning up is offered", () => {
  it("is for finished runs that still have a worktree and a session", () => {
    for (const state of ["done", "failed", "stopped"] as const) expect(cleanable(run(state))).toBe(true);
    for (const state of ["queued", "launching", "working", "needsAnswer", "needsPermission", "systemBlocked", "unknown"] as const) expect(cleanable(run(state))).toBe(false);
    expect(cleanable(run("done", { shortId: null }))).toBe(false);
    expect(cleanable(run("done", { worktreeRemovedAt: "2026-09-29T00:00:00Z" }))).toBe(false);
  });

  it("needs a settled pull request, an age over 14 days, or more than 1 GB", () => {
    const r = run("done");
    expect(cleanupReason(r, NOW, nothing)).toBeNull();
    expect(cleanupReason(r, NOW, { disk: BIG_BYTES, change: { state: "open" } })).toBeNull();
    expect(cleanupReason(r, NOW, { disk: null, change: { state: "merged" } })).toBe("Its pull request is merged.");
    expect(cleanupReason(r, NOW, { disk: null, change: { state: "closed" } })).toBe("Its pull request is closed.");
    expect(cleanupReason(r, NOW, { disk: BIG_BYTES + 1, change: null })).toBe("Its session files take 1.0 GB.");
    const old = (days: number) => run("done", { endedAt: new Date(NOW - days * DAY).toISOString() });
    expect(cleanupReason(old(14), NOW, nothing)).toBeNull();
    expect(cleanupReason(old(15), NOW, nothing)).toBe("It ended more than 14 days ago.");
    expect(cleanupReason(run("working"), NOW, { disk: BIG_BYTES * 9, change: { state: "merged" } })).toBeNull();
  });

  it("is offered together when one is old or all are large", () => {
    const fresh = run("done");
    const stale = run("stopped", { id: "r-stale", endedAt: new Date(NOW - 20 * DAY).toISOString() });
    expect(bulkCleanup([fresh], NOW, 100)).toBeNull();
    expect(bulkCleanup([fresh], NOW, null)).toBeNull();
    expect(bulkCleanup([fresh], NOW, BIG_BYTES + 1)?.runs).toEqual([fresh]);
    expect(bulkCleanup([fresh, stale, run("working", { id: "w" })], NOW, 0)?.runs).toEqual([fresh, stale]);
    expect(bulkCleanup([run("done", { worktreeRemovedAt: "2026-09-01T00:00:00Z" })], NOW, BIG_BYTES * 2)).toBeNull();
  });

  it("reports what was removed and what Claude kept, in its words", () => {
    expect(cleanupReport(3, [])).toBe("Removed 3 worktrees.");
    expect(cleanupReport(1, ["has unpushed commits"])).toBe("Removed 1 worktree. 1 kept: has unpushed commits");
  });
});

describe("the clean up section of the run sheet", () => {
  const view = (over: Partial<Parameters<typeof RunCleanupView>[0]> = {}) =>
    renderToStaticMarkup(<RunCleanupView run={{ worktreeRemovedAt: null }} reason="Its pull request is merged." asking={false} busy={false} refused={null} onAsk={vi.fn()} onCancel={vi.fn()} onConfirm={vi.fn()} {...over} />);

  it("says why, explains claude rm and asks before removing", () => {
    expect(view()).toContain("Its pull request is merged.");
    expect(view()).toContain("refuses to remove work that was never pushed");
    expect(view()).toContain(">Clean up</button>");
    const asking = view({ asking: true });
    expect(asking).toContain("Remove the worktree?");
    expect(asking).toContain("Yes, remove it");
    expect(asking).not.toContain(">Clean up</button>");
  });

  it("shows Claude's refusal as it was said", () => {
    expect(view({ refused: "worktree has 2 unpushed commits" })).toContain("Claude kept it: worktree has 2 unpushed commits");
  });

  it("offers to try again for an earlier session that was kept, once the worktree is gone", () => {
    const kept = { worktreeRemovedAt: "2026-09-30T00:00:00Z", earlierSessions: [{ shortId: "a0000001", removed: true }, { shortId: "a0000002", removed: false }] };
    const html = view({ run: kept, reason: null, refused: "worktree has 1 unpushed commit" });
    expect(html).toContain("An earlier session of this run is still there.");
    expect(html).toContain("Claude kept it: worktree has 1 unpushed commit");
    expect(html).toContain("Try removing again");
    expect(view({ run: { ...kept, earlierSessions: [{ shortId: "a0000001", removed: true }] }, reason: null })).not.toContain("Try removing again");
    expect(cleanable(run("done", { worktreeRemovedAt: kept.worktreeRemovedAt, earlierSessions: kept.earlierSessions }))).toBe(true);
    expect(cleanable(run("done", { worktreeRemovedAt: kept.worktreeRemovedAt, earlierSessions: [] }))).toBe(false);
  });

  it("is absent when there is no reason, and a note once the worktree is gone", () => {
    expect(view({ reason: null })).toBe("");
    const gone = view({ run: { worktreeRemovedAt: "2026-09-30T00:00:00Z" }, reason: null });
    expect(gone).toContain("The worktree and its branch were removed");
    expect(gone).not.toContain("Clean up</button>");
  });
});

describe("cleaning up through the store", () => {
  let backend: MockBackend;
  beforeEach(async () => {
    useToasts.getState().clear();
    backend = new MockBackend();
    useRuns.getState().init(backend);
    await new Promise((r) => setTimeout(r, 0));
  });

  it("removes a finished run's worktree and keeps the run", async () => {
    const done = useRuns.getState().runs.find((r) => r.state === "done")!;
    expect(await useRuns.getState().cleanup(done.id)).toEqual({ type: "removed" });
    await new Promise((r) => setTimeout(r, 0));
    const after = useRuns.getState().runs.find((r) => r.id === done.id)!;
    expect([after.state, !!after.worktreeRemovedAt]).toEqual(["done", true]);
  });

  it("hands back a refusal untouched and leaves the run alone", async () => {
    const done = useRuns.getState().runs.find((r) => r.state === "done")!;
    backend.runs.unpushed.add(done.id);
    const result = await useRuns.getState().cleanup(done.id);
    expect(result?.type).toBe("refused");
    expect(useRuns.getState().runs.find((r) => r.id === done.id)!.worktreeRemovedAt).toBeFalsy();
  });

  it("tallies a bulk clean-up and toasts a failure instead of throwing", async () => {
    const finished = useRuns.getState().runs.filter(cleanable);
    expect(finished.length).toBeGreaterThan(1);
    backend.runs.unpushed.add(finished[0].id);
    const { removed, refused } = await useRuns.getState().cleanupAll(finished.map((r) => r.id));
    expect([removed, refused.length]).toEqual([finished.length - 1, 1]);
    const working = useRuns.getState().runs.find((r) => r.state === "working")!;
    expect(await useRuns.getState().cleanup(working.id)).toBeNull();
    expect(useToasts.getState().toasts.slice(-1)[0]?.text).toContain("Couldn't clean it up");
  });
});

describe("the mock settings", () => {
  it("govern how many runs the pre-flight lets start", async () => {
    const backend = new MockBackend();
    const live = backend.runs.list().filter((r) => ["working", "needsAnswer", "needsPermission", "systemBlocked", "launching"].includes(r.state)).length;
    const rows = async () => (await backend.runsPreflight(null)).rows.map((r) => r.text).join("|");
    expect(await rows()).toContain(`${live} of 6 agents running`);
    await backend.runsSetSettings({ maxRuns: 1, wallClockMinutes: 60, tokenCap: 0, terminal: "terminal", draftOnFinish: true });
    expect(await rows()).toContain(`${live} agents are running, the most Gossamr starts at once (1)`);
  });

  it("clamps like the backend and returns what it kept", async () => {
    const backend = new MockBackend();
    const saved = await backend.runsSetSettings({ maxRuns: 40, wallClockMinutes: -5, tokenCap: 2_500_000, terminal: "iTerm", draftOnFinish: false });
    expect(saved).toEqual({ maxRuns: 6, wallClockMinutes: 0, tokenCap: 2_500_000, terminal: "iTerm", draftOnFinish: false });
    expect(await backend.runsSettings()).toEqual(saved);
  });
});
