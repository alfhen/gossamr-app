import { describe, expect, it } from "vitest";
import type { RunSpec } from "../types";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import { resolveResult, type MockReportRow } from "./mockRunResult";
import { renderPrompt } from "./mockRuns";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const sample = () => new MockBackend({ runs: { seed: "reports", epoch: NOW } });

const row = (over: Partial<MockReportRow> = {}): MockReportRow => ({ offered: true, report: null, revision: 0, calls: 0, rejections: 0, stale: false, ...over });
const ticketRun = (kind: "investigate" | "triage" | "plan" = "investigate") => ({ item: itemRef("CA-1"), spec: { kind }, result: "Prose.\n\nSubtasks:\n- From prose\n\nFor Jira: from the written answer", resultComplete: true });

describe("which result a run is read from", () => {
  it("uses a current report in full, and keeps the tickets the written answer names", () => {
    const r = resolveResult({ ...ticketRun(), result: "Blocked by CA-9.\n\nFor Jira: written" }, row({ report: { status: "done", note: "Reported. See CA-12." }, revision: 1, calls: 1 }));
    expect(r).toMatchObject({ source: "structured", note: { text: "Reported. See CA-12.", fromMarker: true }, keys: ["CA-9", "CA-12"], status: "done", complete: true, subtasks: [] });
  });

  it("does not mine the written answer for what the report left out", () => {
    const triage = resolveResult(ticketRun("triage"), row({ report: { status: "done", note: "n" }, revision: 1, calls: 1 }));
    expect(triage.subtasks).toEqual([]);
    expect(resolveResult(ticketRun("triage"), null).subtasks).toEqual(["From prose"]);
    expect(resolveResult(ticketRun("triage"), row({ report: { status: "done", note: "n", subtasks: ["A", "B"] }, revision: 1, calls: 1 })).subtasks).toEqual(["A", "B"]);
  });

  it("falls back to the written answer for a stale report, naming the source of what it read", () => {
    const stale = resolveResult(ticketRun(), row({ report: { status: "done", note: "Old" }, revision: 1, calls: 1, stale: true }));
    expect(stale).toMatchObject({ source: "section", status: null, note: { text: "from the written answer" } });
    expect(resolveResult({ ...ticketRun(), result: "No marker." }, null)).toMatchObject({ source: "whole", complete: true });
    expect(resolveResult({ ...ticketRun(), result: "One line.", resultComplete: false }, null)).toMatchObject({ source: "summaryOnly", complete: false });
    expect(resolveResult({ ...ticketRun(), result: null }, null)).toMatchObject({ source: null, note: null, complete: false });
  });

  it("takes a ticketless run's ticket from its report", () => {
    const ticket = { title: "Add a backoff", kind: "bug" as const, body: "It spins." };
    const r = resolveResult({ item: null, spec: { kind: "investigate" }, result: "Prose only.", resultComplete: true }, row({ report: { status: "done", newTicket: ticket }, revision: 1, calls: 1 }));
    expect(r).toMatchObject({ source: "structured", ticket, note: null });
  });
});

describe("the sample runs that show each source", () => {
  const find = async (key: string) => {
    const b = sample();
    const run = (await b.runsList()).find((r) => r.item?.key === key)!;
    return { b, run, outcome: await b.runsOutcome(run.id) };
  };

  it("reports through Gossamr, and the written note it replaces is not used", async () => {
    const { outcome } = await find("CA-501");
    expect(outcome.source).toBe("structured");
    expect(outcome.note?.text).toMatch(/^The consumer retries failed messages at once/);
    expect(outcome.report).toMatchObject({ offered: true, revision: 1, calls: 1, rejections: 0, stale: false, locked: false, status: "done" });
  });

  it("says a blocked report is blocked, and leads the drafted comment with it", async () => {
    const { b, run, outcome } = await find("CA-502");
    expect(outcome.report?.status).toBe("blocked");
    const draft = await b.runsDraftComment(run.id);
    const body = JSON.stringify(draft.intent);
    expect(body).toContain("The agent reports it could not finish.");
    expect(body.indexOf("could not finish")).toBeLessThan(body.indexOf("payment sandbox"));
  });

  it("reads the written answer when the tool was offered and not used", async () => {
    const { outcome } = await find("CA-503");
    expect(outcome).toMatchObject({ source: "section", report: { offered: true, calls: 0, revision: 0 } });
  });

  it("reads the written answer when every report was refused", async () => {
    const { outcome } = await find("CA-504");
    expect(outcome).toMatchObject({ source: "section", report: { calls: 5, rejections: 5, locked: true } });
  });

  it("does not use a report made before the person answered", async () => {
    const { outcome } = await find("CA-505");
    expect(outcome).toMatchObject({ source: "section", report: { stale: true } });
    expect(outcome.note?.text).toBe("Both coupon types work.");
  });

  it("still reads only the summary when that is all there is, and has no report block for a run never asked", async () => {
    const { outcome } = await find("CA-506");
    expect(outcome).toMatchObject({ source: "summaryOnly", summaryOnly: true, report: null });
  });

  it("proposes the breakdown the triage reported, which the written answer never listed", async () => {
    const { b, run, outcome } = await find("CA-507");
    expect(outcome.subtasks).toEqual(["Cache the carrier rates", "Show the estimate at checkout", "Fall back to a flat rate"]);
    expect(outcome.report).toMatchObject({ revision: 2, calls: 3, rejections: 1 });
    expect(run.result).toBe("About two days.");
    expect(await b.runsOutcome(run.id)).toMatchObject({ source: "structured" });
  });
});

describe("asking for the tool", () => {
  const spec: RunSpec = { kind: "investigate", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-412-fix-ab12", instruction: "Investigate this work.", focus: null, focusFromRun: null, ticketBlock: "CA-412: sample" };
  it("is refused while the setting is off, and the prompt and digest change when it is on", async () => {
    const b = new MockBackend();
    await expect(b.runsDraft({ ...spec, report: true }, itemRef("CA-412"))).rejects.toThrow(/Reporting through Gossamr is off/);
    await b.runsSetSettings({ ...(await b.runsSettings()), reportResult: true });
    const made = await b.runsDraft({ ...spec, report: true }, itemRef("CA-412"));
    const plain = await b.runsDraft({ ...spec, name: "ca-412-fix-cd34" }, itemRef("CA-412"));
    const review = await b.runsReview(made.id);
    expect(review.prompt).toContain("If the run-report tool `report_result` is available");
    expect(review.report).toMatchObject({ allowed: "mcp__run-report__report_result" });
    expect(review.digest).not.toBe((await b.runsReview(plain.id)).digest);
    expect((await b.runsReview(plain.id)).report).toBeNull();
    expect(renderPrompt({ ...spec, report: false })).not.toContain("run-report");
  });

  it("makes a run that finishes report what its answer says, and drafts from the report", async () => {
    const b = new MockBackend({ runs: { seed: "empty", epoch: NOW } });
    await b.runsSetSettings({ ...(await b.runsSettings()), reportResult: true });
    const made = await b.runsDraft({ ...spec, report: true }, itemRef("CA-412"));
    const run = await b.runsApprove(made.id, (await b.runsReview(made.id)).digest);
    for (let i = 0; i < 3; i++) b.runs.advance(run.id);
    const outcome = await b.runsOutcome(run.id);
    expect(outcome).toMatchObject({ source: "structured", report: { offered: true, revision: 1, calls: 1 } });
    expect(outcome.draft).not.toBeNull();
  });

  it("marks the report older than the person's answer, so the written answer is read again", async () => {
    const b = sample();
    const run = (await b.runsList()).find((r) => r.item?.key === "CA-409")!;
    b.runs.setReport(run.id, row({ report: { status: "done", note: "Early." }, revision: 1, calls: 1 }));
    expect(b.runs.answer(run.id, "Yes, keep it.").state).toBe("working");
    expect((await b.runsOutcome(run.id)).report).toMatchObject({ stale: true });
  });
});
