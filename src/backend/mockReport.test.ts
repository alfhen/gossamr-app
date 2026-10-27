import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";
import { resolveResult, reportView, type MockReportRow } from "./mockRunResult";

const row = (over: Partial<MockReportRow> = {}): MockReportRow => ({ offered: true, report: null, revision: 0, calls: 0, rejections: 0, stale: false, ...over });

describe("prose reports", () => {
  const prose = "Full answer.\n\nFor Jira: keep this heading.\nSubtasks:\n- Data, not a draft\nVerdict: pass";
  it("keeps the whole answer without interpreting headings", () => {
    expect(resolveResult({ result: prose }, null)).toEqual({ note: prose, source: "whole", status: null, complete: true });
  });
  it("uses the current report wholesale even when its note is absent", () => {
    expect(resolveResult({ result: prose }, row({ report: { status: "blocked", note: "I need access." } }))).toEqual({ note: "I need access.", source: "structured", status: "blocked", complete: true });
    expect(resolveResult({ result: prose }, row({ report: { status: "done" } })).note).toBeNull();
  });
  it("falls back to prose after an answer and labels a summary as incomplete", () => {
    const stored = row({ stale: true, report: { status: "done", note: "Old report" } });
    expect(resolveResult({ result: prose }, stored).note).toBe(prose);
    expect(resolveResult({ result: "Short", resultComplete: false }, null)).toMatchObject({ source: "summaryOnly", complete: false });
    expect(resolveResult({}, null).source).toBeNull();
  });
  it("keeps tool metadata without mining the report", () => {
    const stored = row({ report: { status: "blocked", note: "Need help" }, calls: 3, revision: 2, rejections: 1 });
    expect(reportView(stored, true, resolveResult({}, stored))).toMatchObject({ status: "blocked", calls: 3, revision: 2, rejections: 1 });
  });
  it("finishing any role never creates a draft or writes to Jira", () => {
    const backend = new MockBackend({ runs: { seed: "kinds" } });
    const before = backend.proposals.list();
    for (const run of backend.runs.list()) for (let step = 0; step < 5; step++) backend.runs.advance(run.id);
    expect(backend.proposals.list()).toEqual(before);
    expect(backend.proposals.writes).toEqual([]);
    expect(backend.github.writes).toEqual([]);
    const outcome = backend.runs.outcome(backend.runs.list()[0].id);
    expect(Object.keys(outcome).sort()).toEqual(["change", "note", "report", "source", "summaryOnly"]);
  });
});
