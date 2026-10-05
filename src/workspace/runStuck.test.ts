import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run } from "../types";
import { laneOf, stateView, stoppedText } from "./agentsLogic";
import { useRuns } from "./runsStore";
import { answerable, answerDraft, offeredSessions, resumable, RESUME_TEXT } from "./runSheetLogic";
import { useToasts } from "./toasts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const base = (): Run => new MockBackend().runs.list()[0];
const stopped = (over: Partial<Run> = {}): Run => ({ ...base(), state: "stopped", needs: null, unsentAnswer: null, suggestedReply: null, lastProgressAt: new Date(NOW - 60_000).toISOString(), ...over });

describe("a run Gossamr stopped at its limit", () => {
  const limit = stopped({ stoppedByLimit: true, error: "Stopped by Gossamr: it passed the 60 minute limit" });

  it("is called that, sits where the person looks, and says why", () => {
    expect(stateView(limit, NOW)).toMatchObject({ label: "Stopped at limit", tone: "warn" });
    expect(stateView(stopped(), NOW).label).toBe("Stopped");
    expect(laneOf(limit, NOW)).toBe("bad");
    expect(laneOf(stopped(), NOW)).toBe("earlier");
    expect(stoppedText(limit)).toBe("Stopped by Gossamr: it passed the 60 minute limit");
  });

  it("is resumed with words of the person's, starting from what Claude suggested or a plain nudge", () => {
    expect(resumable(limit) && answerable(limit)).toBe(true);
    expect(answerDraft(limit)).toBe(RESUME_TEXT);
    expect(answerDraft({ ...limit, suggestedReply: "Go ahead" })).toBe("Go ahead");
    expect(resumable(stopped())).toBe(false);
    expect(resumable({ ...limit, unsentAnswer: "Yes" })).toBe(false);
    expect(answerable({ ...limit, unsentAnswer: "Yes" })).toBe(true);
    expect(resumable({ ...limit, state: "working" })).toBe(false);
  });
});

describe("a run that may have continued elsewhere", () => {
  const offer = [{ shortId: "bbb748a7", sessionId: null, startedAt: null }];

  it("is offered the sessions only when it is at rest, and says so in the list", () => {
    expect(offeredSessions(stopped({ possibleContinuations: offer }))).toEqual(offer);
    expect(offeredSessions({ state: "done", possibleContinuations: offer })).toEqual(offer);
    expect(offeredSessions({ state: "working", possibleContinuations: offer })).toEqual([]);
    expect(offeredSessions(stopped())).toEqual([]);
    expect(stoppedText(stopped({ possibleContinuations: offer }))).toBe("May have continued in another session");
  });
});

describe("the sample backend and the store follow the same rules", () => {
  let backend: MockBackend;
  const s = () => useRuns.getState();
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    useToasts.getState().clear();
    backend = new MockBackend({ runs: { seed: "stuck" } });
    s().init(backend);
  });

  it("resumes a run stopped at its limit, once, and the limit mark is gone", async () => {
    await settle();
    const limit = s().runs.find((r) => r.stoppedByLimit)!;
    expect(limit.state).toBe("stopped");
    await s().answer(limit.id, "Go ahead and build it");
    await settle();
    expect(s().runs.find((r) => r.id === limit.id)).toMatchObject({ state: "working", stoppedByLimit: false, error: null, shortId: limit.shortId });
    expect(s().runs.find((r) => r.id === limit.id)?.continuedAt).toBeTruthy();
  });

  it("adopts one of the offered sessions: the run follows it and keeps the old id", async () => {
    await settle();
    const offered = s().runs.find((r) => r.possibleContinuations?.length === 1)!;
    await s().adoptSession(offered.id, "bbb748a7");
    await settle();
    const after = s().runs.find((r) => r.id === offered.id)!;
    expect(after).toMatchObject({ state: "working", shortId: "bbb748a7", possibleContinuations: [] });
    expect(after.earlierSessions).toEqual([{ shortId: offered.shortId, sessionId: offered.sessionId }]);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("refuses a session that was not offered, and says so", async () => {
    await settle();
    const offered = s().runs.find((r) => r.possibleContinuations?.length === 2)!;
    await s().adoptSession(offered.id, "deadbeef");
    expect(useToasts.getState().toasts[0].text).toContain("Couldn't adopt the session: That session doesn't look like this run's any more");
    expect(s().runs.find((r) => r.id === offered.id)?.state).toBe("stopped");
    await expect(backend.runsAdoptSession(s().runs.find((r) => r.state === "working")!.id, "bbb748a7")).rejects.toThrow(/no other session/);
  });
});
