import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { RunOutcome } from "../types";
import { Found } from "./RunResult";

const run = new MockBackend().runs.list()[0];
const outcome: RunOutcome = { note: "For Jira:\nThis is ordinary prose.\nVerdict: pass", change: null, source: "whole", summaryOnly: false, report: null };
const view = (over: Partial<RunOutcome> = {}) => renderToStaticMarkup(<Found run={run} outcome={{ ...outcome, ...over }} on={{ askPip: vi.fn(), openChange: vi.fn() }} />);

describe("the report on the run sheet", () => {
  it("shows the whole prose and asks Pip instead of drafting automatically", () => {
    const html = view();
    expect(html).toContain("For Jira:");
    expect(html).toContain("Verdict: pass");
    expect(html).toContain("Ask Pip");
    expect(html).not.toContain("Draft a comment");
    expect(html).not.toContain("Not parsed");
  });
  it("labels a summary and reports blocked tool results", () => {
    expect(view({ source: "summaryOnly", summaryOnly: true })).toContain("Summary only");
    expect(view({ source: "structured", report: { offered: true, status: "blocked", calls: 1, revision: 1, rejections: 0, stale: false, locked: false, firstAt: null, lastAt: null } })).toContain("It reports it could not finish.");
  });
});
