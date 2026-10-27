import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { ReportView, ResultSource, Run, RunOutcome } from "../types";
import { RunSheetView, type RunSheetActions, type RunSheetViewProps } from "./RunSheet";
import { reportNotes } from "./runSheetLogic";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const seeded = () => new MockBackend().runs.list();
const done = (over: Partial<Run> = {}): Run => ({ ...seeded()[0], id: "r-done", state: "done", needs: null, lastDetail: null, tokens: 1000, result: "Found it.\n\nFor Jira: add a backoff.", error: null, shortId: "1000a000", lastProgressAt: iso(1), queuedAt: iso(10), endedAt: iso(2), ...over });
const report = (over: Partial<ReportView> = {}): ReportView => ({ offered: true, status: "done", revision: 1, calls: 1, rejections: 0, stale: false, locked: false, firstAt: null, lastAt: null, ...over });
const outcome = (source: ResultSource | null, over: Partial<RunOutcome> = {}): RunOutcome => ({ note: { text: "add a backoff.", fromMarker: source !== "whole" }, keys: [], change: null, draft: null, ticket: null, ticketDraft: null, subtasks: [], subtasksDraft: null, source, ...over });

const actions = (): RunSheetActions =>
  ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), answer: vi.fn(), adoptSession: vi.fn(() => Promise.resolve()), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), draftComment: vi.fn(), askPip: vi.fn(), openDraft: vi.fn(), pickBlocker: vi.fn(), cancelBlocker: vi.fn(), draftBlocker: vi.fn(), openChange: vi.fn(), draftTicket: vi.fn(), openTicketDraft: vi.fn(), finishWithPip: vi.fn(), openCreated: vi.fn(), askPipBreakdown: vi.fn(), buildFromPlan: vi.fn(), draftPlanComment: vi.fn(), openPlanDraft: vi.fn(), reviewThis: vi.fn() }) as RunSheetActions;

const sheet = (r: Run, o: RunOutcome | null, over: Partial<RunSheetViewProps> = {}) =>
  renderToStaticMarkup(<RunSheetView run={r} now={NOW} ticketTitle="Retry failed payment webhooks" place={null} wide={false} onWide={vi.fn()} events={[]} disk={null} confirmStop={false} outcome={o} tickets={[]} pickBlocker={false} drafting={false} answering={false} opened={false} on={actions()} {...over} />);

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

describe("where the result on the sheet came from", () => {
  it("says a result was reported to Gossamr, in its own words, with nothing to flag", () => {
    const html = sheet(done(), outcome("structured", { report: report() }));
    expect(html).toContain("For Jira, as the agent reported it");
    expect(html).toContain('data-source="structured"');
    expect(html).toContain("Reported to Gossamr");
    expect(html).toContain('data-note="structured"');
    expect(html).not.toContain("Not parsed");
    expect(html).not.toContain("data-report-notes");
  });

  it("names the other three sources, and warns for the two that were not understood", () => {
    const section = sheet(done(), outcome("section"));
    expect(section).toContain("Parsed from its For Jira section");
    expect(section).toContain('data-note="section"');
    const whole = sheet(done({ result: "It is the rounding." }), outcome("whole", { note: { text: "It is the rounding.", fromMarker: false } }));
    expect(whole).toContain("Not parsed");
    expect(whole).toContain('data-note="whole"');
    const summary = sheet(done({ resultComplete: false }), outcome("summaryOnly", { summaryOnly: true, note: { text: "One line.", fromMarker: false } }));
    expect(summary).toContain("Summary only");
    expect(summary).toContain('data-note="summary"');
  });

  it("marks the source on a run with no ticket as well", () => {
    const html = sheet(done({ item: null }), outcome("structured", { note: null, ticket: { title: "Add a backoff", kind: "bug", body: "It spins." }, report: report() }));
    expect(html).toContain("Add a backoff");
    expect(html).toContain('data-source="structured"');
  });

  it("tells the story of the tool when the written answer was read instead", () => {
    const unused = sheet(done(), outcome("section", { report: report({ calls: 0, revision: 0, status: null }) }));
    expect(unused).toContain("It was given the report tool and didn&#x27;t use it, so Gossamr read its written answer.");
    const stale = sheet(done(), outcome("section", { report: report({ stale: true, status: null }) }));
    expect(stale).toContain("It reported before you answered or carried on, so that report isn&#x27;t used");
    const off = sheet(done(), outcome("section", { report: report({ offered: false, calls: 0, revision: 0, status: null }) }));
    expect(off).toContain("The report tool wasn&#x27;t offered to this run");
  });
});

describe("what the sheet says about the report tool", () => {
  it("says nothing for a run that was never asked", () => {
    expect(reportNotes(outcome("section"))).toEqual([]);
    expect(reportNotes(outcome("section", { report: null }))).toEqual([]);
  });

  it("says each way the tool came to nothing, once", () => {
    expect(reportNotes(outcome("section", { report: report({ offered: false, calls: 0 }) }))).toHaveLength(1);
    expect(reportNotes(outcome("section", { report: report({ calls: 0, revision: 0 }) }))).toEqual(["It was given the report tool and didn't use it, so Gossamr read its written answer."]);
    expect(reportNotes(outcome("section", { report: report({ stale: true }) }))[0]).toMatch(/^It reported before you answered/);
    expect(reportNotes(outcome("section", { report: report({ calls: 5, rejections: 5, revision: 0, locked: true }) }))[0]).toMatch(/^The tool stopped taking its reports/);
    expect(reportNotes(outcome("section", { report: report({ calls: 2, rejections: 2, revision: 0 }) }))[0]).toMatch(/^Every report it made was refused/);
  });

  it("flags a blocked report and a corrected one, and a clean one needs no note", () => {
    expect(reportNotes(outcome("structured", { report: report({ status: "blocked" }) }))).toEqual(["It reports it could not finish."]);
    expect(reportNotes(outcome("structured", { report: report({ calls: 3, rejections: 1, revision: 2 }) }))).toEqual(["It called the tool 3 times: 1 refused, 2 recorded."]);
    expect(reportNotes(outcome("structured", { report: report() }))).toEqual([]);
  });
});
