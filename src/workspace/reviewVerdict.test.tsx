import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { SCRIPTED_RESULT } from "../backend/mockRuns";
import type { Run, RunOutcome, ReviewView } from "../types";
import { AgentCard } from "./AgentCard";
import { RunSheetView, type RunSheetActions } from "./RunSheet";
import { verdictChip, verdictText } from "./runSheetLogic";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const backend = new MockBackend({ githubRepos: 14, runs: { seed: "kinds", epoch: NOW } });
const seeded: Run = backend.runs.list().find((r) => r.spec.kind === "review")!;
/** The seeded review as if it had finished with the scripted adversarial answer. */
const finished: Run = { ...seeded, result: SCRIPTED_RESULT.review, resultComplete: true };

const actions = (): RunSheetActions => ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), answer: vi.fn(), adoptSession: vi.fn(() => Promise.resolve()), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), loadBrief: vi.fn(), draftComment: vi.fn(), askPip: vi.fn(), openDraft: vi.fn(), pickBlocker: vi.fn(), cancelBlocker: vi.fn(), draftBlocker: vi.fn(), openChange: vi.fn(), draftTicket: vi.fn(), openTicketDraft: vi.fn(), finishWithPip: vi.fn(), openCreated: vi.fn(), askPipBreakdown: vi.fn(), buildFromPlan: vi.fn(), draftPlanComment: vi.fn(), openPlanDraft: vi.fn(), reviewThis: vi.fn() });
const sheet = (run: Run, o: RunOutcome | null) =>
  renderToStaticMarkup(<RunSheetView run={run} now={NOW} ticketTitle="Review the gateway" place={null} wide={false} onWide={vi.fn()} events={[]} disk={null} brief={null} confirmStop={false} outcome={o} tickets={[]} pickBlocker={false} drafting={false} answering={false} opened={false} on={actions()} />);
const card = (review?: ReviewView | null) =>
  renderToStaticMarkup(<AgentCard run={finished} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} review={review} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);

/** The outcome of `run` as the sample backend reads it. */
function outcomeOf(run: Run): RunOutcome {
  (backend.runs as unknown as { update(id: string, patch: Partial<Run>): void }).update(run.id, { result: run.result, resultComplete: run.resultComplete });
  return backend.runs.outcome(run.id);
}

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));

describe("a review's verdict", () => {
  it("is read from the written Verdict line when the report setting is off, with its findings by severity", () => {
    const review = outcomeOf(finished).review!;
    expect(review).toMatchObject({ verdict: "blocking", blocking: 1, shouldFix: 1, nits: 1, source: "written" });
    expect(review.findings.map((f) => f.severity)).toEqual(["blocking", "should-fix", "nit"]);
    expect(review.findings[0].text).toContain("src/consumer/retry.ts:42");
  });

  it("shows on the sheet as Blocking with its count and each finding's severity", () => {
    const html = sheet(finished, outcomeOf(finished));
    expect(html).toContain('data-verdict="blocking"');
    expect(html).toContain('data-blocking-count="1"');
    expect(html).toContain("Blocking: 1 blocking finding");
    expect(html).toContain("Read from its Verdict line");
    for (const severity of ["blocking", "should-fix", "nit"]) expect(html).toContain(`data-severity="${severity}"`);
    expect(html.indexOf('data-severity="blocking"')).toBeLessThan(html.indexOf('data-severity="nit"'));
  });

  it("says when a finished review gave none, and shows nothing while the outcome loads", () => {
    const silent = { ...seeded, result: "1. The retry loop never backs off.\n\nFor Jira: one issue.", resultComplete: true };
    const o = outcomeOf(silent);
    expect(o.review).toBeNull();
    expect(sheet(silent, o)).toContain("The reviewer gave no verdict");
    expect(sheet(silent, o)).toContain('data-verdict="none"');
    expect(sheet(silent, null)).not.toContain("data-verdict");
  });

  it("is a chip on the Agents card, and only when there is one", () => {
    const review = outcomeOf(finished).review!;
    const html = card(review);
    expect(html).toContain('data-verdict="blocking"');
    expect(html).toContain('data-blocking-count="1"');
    expect(html).toContain("Blocking · 1");
    const pass = card({ ...review, verdict: "pass", blocking: 0, findings: [] });
    expect(pass).toContain('data-verdict="pass"');
    expect(pass).toContain(">Pass<");
    expect(card(null)).not.toContain("data-verdict");
    expect(card()).not.toContain("data-verdict");
  });

  it("is said in words", () => {
    expect(verdictText({ verdict: "blocking", blocking: 2 })).toBe("Blocking: 2 blocking findings");
    expect(verdictText({ verdict: "pass", blocking: 0 })).toBe("Pass");
    expect(verdictChip({ verdict: "blocking", blocking: 2 })).toBe("Blocking · 2");
    expect(verdictChip({ verdict: "pass", blocking: 0 })).toBe("Pass");
  });
});
