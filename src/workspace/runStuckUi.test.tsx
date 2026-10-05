import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run, RunState } from "../types";
import { RunSheetView, type RunSheetActions, type RunSheetViewProps } from "./RunSheet";
import { rowText } from "./AgentParts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const seeded = () => new MockBackend().runs.list();

const run = (state: RunState, over: Partial<Run> = {}): Run => ({ ...seeded()[0], id: `r-${state}`, state, needs: null, lastDetail: null, tokens: 2_772, result: null, error: null, shortId: "2afa0a22", lastProgressAt: iso(1), queuedAt: iso(150), endedAt: iso(90), suggestedReply: null, unsentAnswer: null, ...over });

const actions = (): RunSheetActions => ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), answer: vi.fn(), adoptSession: vi.fn(() => Promise.resolve()), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), loadBrief: vi.fn(), draftComment: vi.fn(), askPip: vi.fn(), openDraft: vi.fn(), pickBlocker: vi.fn(), cancelBlocker: vi.fn(), draftBlocker: vi.fn(), openChange: vi.fn(), draftTicket: vi.fn(), openTicketDraft: vi.fn(), finishWithPip: vi.fn(), openCreated: vi.fn(), askPipBreakdown: vi.fn(), buildFromPlan: vi.fn(), draftPlanComment: vi.fn(), openPlanDraft: vi.fn(), reviewThis: vi.fn() });

const sheet = (r: Run, over: Partial<RunSheetViewProps> = {}) =>
  renderToStaticMarkup(<RunSheetView run={r} now={NOW} ticketTitle="Hobbii MCP gateway" place={null} wide={false} onWide={vi.fn()} events={[]} disk={null} brief={null} confirmStop={false} outcome={null} tickets={[]} pickBlocker={false} drafting={false} answering={false} opened={false} on={actions()} {...over} />);

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

describe("a run stopped at its limit", () => {
  const limit = (over: Partial<Run> = {}) => run("stopped", { stoppedByLimit: true, error: "Stopped by Gossamr: it passed the 60 minute limit", lastDetail: "plan complete; awaiting PR #176", ...over });

  it("is never called finished: it says it was stopped at its limit and offers to resume it", () => {
    const html = sheet(limit());
    expect(html).toContain("Stopped at limit");
    expect(html).not.toContain("Finished");
    expect(html).toContain("Stopped by Gossamr: it passed the 60 minute limit");
    expect(html).toContain("It was at: plan complete; awaiting PR #176");
    expect(html).toContain('aria-label="What to tell it"');
    expect(html).toContain("Please carry on from where you stopped.");
    expect(buttons(html)).toEqual(expect.arrayContaining(["Resume", "Open in Terminal"]));
    expect(html).toContain("After a resume the limits no longer stop this run.");
  });

  it("starts the box with the reply Claude suggested, and the list says why it stopped", () => {
    expect(sheet(limit({ suggestedReply: "Go ahead and build it with the plan as written" }))).toContain("Go ahead and build it with the plan as written");
    expect(rowText(limit(), NOW)).toBe("Stopped by Gossamr: it passed the 60 minute limit");
  });

  it("with an answer that didn't get through shows that answer to send again, not a resume", () => {
    const html = sheet(limit({ unsentAnswer: "Use staging.", error: "Couldn't wake the agent: boom." }));
    expect(html).toContain("Your answer didn&#x27;t get through");
    expect(buttons(html)).toContain("Start it again with your answer");
    expect(buttons(html)).not.toContain("Resume");
  });

  it("a stopped run that wasn't stopped at a limit says Stopped and offers nothing to resume", () => {
    const html = sheet(run("stopped"));
    expect(html).toContain("Stopped");
    expect(html).not.toContain("Stopped at limit");
    expect(html).not.toContain("<textarea");
  });
});

describe("a run that may have continued in another session", () => {
  const offered = (ids: string[], state: RunState = "stopped") => run(state, { possibleContinuations: ids.map((shortId) => ({ shortId, sessionId: null, startedAt: null })) });

  it("offers one click to adopt each session and never adopts on its own", () => {
    const html = sheet(offered(["bbb748a7"]));
    expect(html).toContain("This run may have continued in another session");
    expect(buttons(html)).toContain("Adopt session bbb748a7");
    expect(html).toContain("couldn&#x27;t be sure it is the same conversation");
  });

  it("lists every candidate when there is more than one", () => {
    const html = sheet(offered(["c0de0001", "c0de0002"]));
    expect(buttons(html).filter((b) => b.startsWith("Adopt session"))).toEqual(["Adopt session c0de0001", "Adopt session c0de0002"]);
    expect(html).toContain("couldn&#x27;t be sure which is the same conversation");
  });

  it("is not offered while the run holds an answer to send: that goes to its own session first", () => {
    const html = sheet(run("stopped", { unsentAnswer: "Use staging.", error: "Couldn't wake the agent: boom.", possibleContinuations: [{ shortId: "bbb748a7", sessionId: null, startedAt: null }] }));
    expect(buttons(html).some((b) => b.startsWith("Adopt session"))).toBe(false);
    expect(buttons(html)).toContain("Start it again with your answer");
  });

  it("is shown for a finished run too, and not for one that is working or has nothing to offer", () => {
    expect(buttons(sheet(offered(["bbb748a7"], "done")))).toContain("Adopt session bbb748a7");
    expect(buttons(sheet(offered(["bbb748a7"], "working"))).some((b) => b.startsWith("Adopt session"))).toBe(false);
    expect(buttons(sheet(run("stopped"))).some((b) => b.startsWith("Adopt session"))).toBe(false);
  });
});
