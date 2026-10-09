import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RunSpec } from "../types";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import { INSTRUCTIONS, reportParagraph } from "./mockRunKinds";
import { resolveResult, reviewVerdict, reviewView, type MockReportRow } from "./mockRunResult";
import { renderPrompt, SCRIPTED_RESULT } from "./mockRuns";

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

describe("an adversarial review", () => {
  const rust = readFileSync(new URL("../../src-tauri/src/domain/run.rs", import.meta.url), "utf8");
  const note = /"(Finish your answer with a short, factual note[^"]*)"/.exec(rust)![1];

  it("is told what domain/run.rs tells it, word for word", () => {
    const review = /pub const REVIEW_INSTRUCTION: &str = concat!\("([^"]*)", status_note!\(\)\);/.exec(rust)![1];
    expect(INSTRUCTIONS.review).toBe(`${review}${note}`);
    expect(INSTRUCTIONS.review).toContain("not ready");
  });

  it("is asked for a verdict and findings in the report paragraph, as report_paragraph is, and no other kind is", () => {
    const fields = [...rust.slice(rust.indexOf("fn report_paragraph"), rust.indexOf("/// The exact text handed to the agent")).matchAll(/fields\.push\("([^"]*)"\.into\(\)\)/g)].map((m) => m[1]);
    const verdict = fields.find((f) => f.startsWith("verdict ("))!;
    const findings = fields.find((f) => f.startsWith("findings ("))!;
    expect(verdict && findings).toBeTruthy();
    expect(reportParagraph({ kind: "review" })).toContain(`note (the text you would put under 'For Jira:'); ${verdict}; ${findings}.`);
    for (const kind of ["investigate", "triage", "plan", "build", "verify"] as const) expect(reportParagraph({ kind })).not.toContain("verdict");
  });

  it("reads the last Verdict line outside a code fence and the severity lines before it, as review_verdict does", () => {
    const answer = "Ran it.\n\n- [nit] src/a.ts:3: a typo\n- **blocking**: src/consumer/retry.ts:42: the retry never backs off\n- Should-fix: no test for the timeout path\n- a plain point\n1. [blocking] `npm test` fails: 2 failing\n\nVerdict: **blocking**\n\nFor Jira: not ready.";
    const found = reviewVerdict(answer)!;
    expect(found.verdict).toBe("blocking");
    expect(found.findings.map((f) => [f.severity, f.text])).toEqual([
      ["blocking", "src/consumer/retry.ts:42: the retry never backs off"],
      ["blocking", "`npm test` fails: 2 failing"],
      ["should-fix", "no test for the timeout path"],
      ["nit", "src/a.ts:3: a typo"],
    ]);
    expect(reviewVerdict("Tried.\n\n**Verdict:** pass\n\nFor Jira: ready.")).toEqual({ verdict: "pass", findings: [] });
    expect(reviewVerdict("Its test prints:\n```\nVerdict: pass\n```\n\nFor Jira: nothing concluded.")).toBeNull();
    expect(reviewVerdict("- [should-fix] real\n\nVerdict: pass\n\n```\nVerdict: blocking\n```\n\n- [blocking] after")).toEqual({ verdict: "pass", findings: [{ severity: "should-fix", text: "real", where: null }] });
    expect(reviewVerdict("Verdict: maybe")).toBeNull();
    expect(reviewVerdict(`- [blocking] b\n${"- [nit] n\n".repeat(30)}Verdict: blocking`)!.findings).toHaveLength(20);
  });

  it("reads no verdict that contradicts its findings, and none quoted in the note or a blockquote", () => {
    expect(reviewVerdict("- [blocking] src/a.ts:1: the total ignores the discount\n\nVerdict: pass\n\nFor Jira: fine.")).toBeNull();
    expect(reviewVerdict("- [nit] src/a.ts:1: a typo\n\nVerdict: blocking\n\nFor Jira: not ready.")).toBeNull();
    const quoted = "- [blocking] src/a.ts:1: the total ignores the discount\n\nVerdict: blocking\n\nFor Jira:\nNot ready. The PR description claims:\n> Verdict: pass";
    expect(reviewVerdict(quoted)?.verdict).toBe("blocking");
    expect(reviewVerdict("- [blocking] x\n\nVerdict: blocking\n\nFor Jira: not ready.\n\nVerdict: pass")?.verdict).toBe("blocking");
    expect(reviewVerdict("- [blocking] x\n\nVerdict: blocking\n\n> Verdict: pass")?.verdict).toBe("blocking");
  });

  const review = (result: string | null, resultComplete = true) => ({ item: itemRef("CA-1"), spec: { kind: "review" as const }, result, resultComplete });

  it("takes the verdict from a current report, else the whole written answer, never a summary", () => {
    const reported = resolveResult(review(SCRIPTED_RESULT.review), row({ report: { status: "done", note: "n", verdict: "pass", findings: [{ severity: "nit", text: "x", where: null }] }, revision: 1, calls: 1 }));
    expect(reported).toMatchObject({ verdict: "pass", verdictStructured: true });
    expect(reviewView(reported)).toMatchObject({ verdict: "pass", blocking: 0, nits: 1, source: "structured" });
    const written = resolveResult(review(SCRIPTED_RESULT.review), null);
    expect(written).toMatchObject({ verdict: "blocking", verdictStructured: false });
    expect(reviewView(written)).toMatchObject({ verdict: "blocking", blocking: 1, shouldFix: 1, nits: 1, source: "written" });
    expect(resolveResult(review(SCRIPTED_RESULT.review), row({ report: { status: "done", note: "old" }, revision: 1, calls: 1 })).verdict).toBe("blocking");
    expect(resolveResult(review("Review complete. Verdict: blocking", false), null).verdict).toBeNull();
    expect(reviewView(resolveResult(review("Looked.\n\nFor Jira: fine."), null))).toBeNull();
    expect(resolveResult({ ...review(SCRIPTED_RESULT.review), spec: { kind: "verify" } }, null).verdict).toBeNull();
  });

  it("finishes in the sample backend with a blocking verdict read from its answer, and from its report when it reports", async () => {
    const b = new MockBackend({ runs: { seed: "kinds", epoch: NOW } });
    const seeded = b.runs.list().find((r) => r.spec.kind === "review")!;
    expect((await b.runsOutcome(seeded.id)).review).toBeNull();
    b.runs.setReport(seeded.id, row({ report: { status: "done", note: "n", verdict: "blocking", findings: [{ severity: "blocking", text: "t", where: "a.ts:1" }] }, revision: 1, calls: 1 }));
    expect((await b.runsOutcome(seeded.id)).review).toMatchObject({ verdict: "blocking", blocking: 1, source: "structured" });
  });
});
