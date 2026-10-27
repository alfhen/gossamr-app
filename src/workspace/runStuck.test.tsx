import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run } from "../types";
import { renderToStaticMarkup } from "react-dom/server";
import { laneOf, stateView, stoppedText } from "./agentsLogic";
import { cleanable } from "./cleanupLogic";
import { RunCleanupView } from "./RunCleanup";
import { useRuns } from "./runsStore";
import { answerable, answerDraft, offeredSessions } from "./runSheetLogic";
import { useToasts } from "./toasts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const base = (): Run => new MockBackend().runs.list()[0];
const stopped = (over: Partial<Run> = {}): Run => ({ ...base(), state: "stopped", needs: null, unsentAnswer: null, suggestedReply: null, lastProgressAt: new Date(NOW - 60_000).toISOString(), ...over });

describe("a stopped run", () => {
  it("is called Stopped, sits with the earlier ones, and says where it stopped", () => {
    expect(stateView(stopped(), NOW)).toMatchObject({ label: "Stopped", tone: "muted" });
    expect(laneOf(stopped(), NOW)).toBe("earlier");
    expect(stoppedText(stopped({ lastDetail: "Reading the cart" }))).toBe("Reading the cart");
    expect(stoppedText(stopped({ lastDetail: null }))).toBe("Stopped before it finished");
  });

  it("is answered only when an answer of the person's was stopped on its way", () => {
    expect(answerable(stopped())).toBe(false);
    expect(answerable(stopped({ unsentAnswer: "Use staging." }))).toBe(true);
    expect(answerDraft(stopped({ unsentAnswer: "Use staging." }))).toBe("Use staging.");
    expect(answerDraft(stopped())).toBe("");
  });
});

describe("a run that may have continued elsewhere", () => {
  const offer = [{ shortId: "bbb748a7", sessionId: null, startedAt: null }];

  it("is offered the sessions only when it is at rest, and says so in the list", () => {
    expect(offeredSessions(stopped({ possibleContinuations: offer }))).toEqual(offer);
    expect(offeredSessions({ state: "done", unsentAnswer: null, possibleContinuations: offer })).toEqual(offer);
    expect(offeredSessions(stopped({ possibleContinuations: offer, unsentAnswer: "Use staging." }))).toEqual([]);
    expect(offeredSessions({ state: "working", unsentAnswer: null, possibleContinuations: offer })).toEqual([]);
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

  it("adopts one of the offered sessions: the run follows it and keeps the old id", async () => {
    await settle();
    const offered = s().runs.find((r) => r.possibleContinuations?.length === 1)!;
    await s().adoptSession(offered.id, "bbb748a7");
    await settle();
    const after = s().runs.find((r) => r.id === offered.id)!;
    expect(after).toMatchObject({ state: "working", shortId: "bbb748a7", possibleContinuations: [] });
    expect(after.earlierSessions).toEqual([{ shortId: offered.shortId, sessionId: offered.sessionId }]);
    expect(after.sessionId).toBe("bbb748a7-dca2-4f33-9da1-caa7f80584b8");
    expect(useToasts.getState().toasts.map((t) => [t.text, t.tone])).toEqual([[expect.stringMatching(/^Adopted session /), "info"]]);
  });

  it("removes the earlier session along with the worktree, so nothing is left to retry", async () => {
    await settle();
    const offered = s().runs.find((r) => r.possibleContinuations?.length === 1)!;
    await s().adoptSession(offered.id, "bbb748a7");
    backend.runs.advance(offered.id);
    await settle();
    const done = () => s().runs.find((r) => r.id === offered.id)!;
    expect(done().state).toBe("done");
    expect(cleanable(done())).toBe(true);
    expect(await s().cleanup(offered.id)).toEqual({ type: "removed" });
    await settle();
    expect(done().earlierSessions).toEqual([expect.objectContaining({ shortId: offered.shortId, removed: true })]);
    expect(cleanable(done())).toBe(false);
    const view = renderToStaticMarkup(<RunCleanupView run={done()} reason={null} asking={false} busy={false} refused={null} onAsk={() => {}} onCancel={() => {}} onConfirm={() => {}} />);
    expect(view).toContain("The worktree and its branch were removed");
    expect(view).not.toContain("Try removing again");
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
