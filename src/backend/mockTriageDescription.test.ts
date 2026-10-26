import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import { docFromMarkdown, markdownOf } from "./mockMarkdown";
import { QUESTIONS_LEAD, TRIAGE_HEADING, isTriageDescription, triageQuestionsOf, triageSectionOf, withTriageSection, withoutTriageSection } from "./mockTriageSection";
import { withPlanSection, planSectionOf } from "./mockPlanSection";
import { firstAskPosted } from "../lib/reporterWait";
import type { Proposal, RunSpec } from "../types";

const md = docFromMarkdown;
const QUESTIONS = ["What does done look like?", "Who is waiting on it?"];

const EXPAND = "<details>\n<summary>Gossamr Plan</summary>\n\nintro\n\nThe plan.\n\n</details>";

describe("the Triage section of a description in the sample build", () => {
  it("is added after the description with its note and its open questions as a list, and found again", () => {
    const doc = md("Fix it.");
    const with_ = withTriageSection(doc, "The ticket cannot be sized yet.", QUESTIONS);
    expect(markdownOf(with_)).toBe("Fix it.\n\n## Triage\n\nThe ticket cannot be sized yet.\n\nOpen questions:\n\n- What does done look like?\n- Who is waiting on it?");
    expect(markdownOf(triageSectionOf(with_)!)).toBe("The ticket cannot be sized yet.\n\nOpen questions:\n\n- What does done look like?\n- Who is waiting on it?");
    expect(triageQuestionsOf(with_)).toEqual(QUESTIONS);
    expect(markdownOf(withoutTriageSection(with_))).toBe("Fix it.");
    expect([TRIAGE_HEADING, QUESTIONS_LEAD]).toEqual(["Triage", "Open questions:"]);
  });

  it("stands before the plan section, and a plan added later goes after it", () => {
    const planned = md("Fix it.\n\n## Gossamr Plan\n\nintro\n\nThe plan.");
    const with_ = withTriageSection(planned, "Size: 3 points.", []);
    expect(markdownOf(with_)).toBe("Fix it.\n\n## Triage\n\nSize: 3 points.\n\n## Gossamr Plan\n\nintro\n\nThe plan.");
    expect(markdownOf(planSectionOf(with_)!)).toBe(markdownOf(planSectionOf(planned)!));
    const other = withPlanSection(withTriageSection(md("Fix it."), "Size: 3 points.", []), "intro", md("The plan."));
    expect(markdownOf(other)).toBe(`Fix it.\n\n## Triage\n\nSize: 3 points.\n\n${EXPAND}`);
    // The expand holds the plan, so the triage section before it ends at it and the plan is left out of the section.
    expect(markdownOf(triageSectionOf(other)!)).toBe("Size: 3 points.");
    const inExpand = withTriageSection(md(`Fix it.\n\n${EXPAND}`), "Size: 3 points.", []);
    expect(markdownOf(inExpand)).toBe(`Fix it.\n\n## Triage\n\nSize: 3 points.\n\n${EXPAND}`);
    expect(markdownOf(planSectionOf(inExpand)!)).toBe("intro\n\nThe plan.");
  });

  it("is replaced where it stands by a re-triage, never stacked, and a ready one leaves no question in it", () => {
    const first = withPlanSection(withTriageSection(md("Fix it."), "Cannot be sized yet.", QUESTIONS), "intro", md("The plan."));
    const second = withTriageSection(first, "Size: 3 points. The answers in the ticket's comments were used.", []);
    expect(markdownOf(second)).toBe(`Fix it.\n\n## Triage\n\nSize: 3 points. The answers in the ticket's comments were used.\n\n${EXPAND}`);
    expect(triageQuestionsOf(second)).toEqual([]);
  });

  it("has no list for no questions, turns a note's headings into text so none ends the section, and is found whatever its case", () => {
    const with_ = withTriageSection(md("Fix it.\n\n## Notes\n\nKeep me."), "# Size\n\nAbout a day.", []);
    expect(markdownOf(with_)).toBe("Fix it.\n\n## Notes\n\nKeep me.\n\n## Triage\n\nSize\n\nAbout a day.");
    expect(markdownOf(with_)).not.toContain(QUESTIONS_LEAD);
    const doc = md("Text.\n\n### triage:\n\nin\n\n#### Inner\n\nalso in\n\n### Next\n\nout");
    expect(markdownOf(triageSectionOf(doc)!)).toBe("in\n\n#### Inner\n\nalso in");
    expect(markdownOf(withoutTriageSection(doc))).toBe("Text.\n\n### Next\n\nout");
    expect(triageSectionOf(md("Just text"))).toBeNull();
  });

  it("ends before a plan that follows it, whatever the plan's level, so a re-triage keeps the plan", () => {
    const doc = md("Fix it.\n\n## Triage\n\nOld note.\n\n### Gossamr Plan\n\nThe plan.");
    expect(markdownOf(triageSectionOf(doc)!)).toBe("Old note.");
    expect(markdownOf(withTriageSection(doc, "New note.", []))).toBe("Fix it.\n\n## Triage\n\nNew note.\n\n### Gossamr Plan\n\nThe plan.");
  });

  it("does not take a heading named Triage inside the plan as its marker", () => {
    const doc = md("Fix it.\n\n## Gossamr Plan\n\nintro\n\n### Triage\n\nPart of the plan.");
    expect(triageSectionOf(doc)).toBeNull();
    expect(markdownOf(withTriageSection(doc, "Size: 3.", []))).toBe("Fix it.\n\n## Triage\n\nSize: 3.\n\n## Gossamr Plan\n\nintro\n\n### Triage\n\nPart of the plan.");
  });

  it("is added at the level of the plan heading it stands before", () => {
    expect(markdownOf(withTriageSection(md("Fix it.\n\n### Gossamr Plan\n\nThe plan."), "Size: 3.", []))).toBe("Fix it.\n\n### Triage\n\nSize: 3.\n\n### Gossamr Plan\n\nThe plan.");
  });
});

describe("when the first ask was posted", () => {
  const line = (at: string, action: string, proposalId: string, actor = "person") => ({ actor, action, proposalId, at }) as Parameters<typeof firstAskPosted>[0][number];
  const asked = [line("2026-10-01T10:00:00Z", "readiness_asked", "c1"), line("2026-10-01T10:02:00Z", "draft_approved", "c1")];

  it("is the approval of the person's own ask, and nothing before it", () => {
    expect(firstAskPosted(asked)).toBe(Date.parse("2026-10-01T10:02:00Z"));
    expect(firstAskPosted(asked.slice(0, 1))).toBeNull();
    expect(firstAskPosted([line("2026-10-01T10:00:00Z", "readiness_asked", "c1", "pip"), asked[1]])).toBeNull();
  });
});

describe("a Triage on the vague CA-408 in the sample build", () => {
  const CA408 = itemRef("CA-408");
  const sample = () => new MockBackend({ runs: { seed: "empty", prSurfaceMs: null } });
  const spec = (ws: string): RunSpec => ({ kind: "triage", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: `ca-408-${Math.random().toString(16).slice(2, 6)}`, instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: ws });
  async function triage(b: MockBackend, ws: string) {
    const draft = await b.runsDraft(spec(ws), CA408);
    const run = await b.runsApprove(draft.id, (await b.runsReview(draft.id)).digest);
    for (let i = 0; i < 3 && b.runs.get(run.id)?.state !== "done"; i++) b.runs.advance(run.id);
    return b.runs.get(run.id)!;
  }
  const rewriteOf = (b: MockBackend, runId: string): Proposal | undefined => b.proposals.list().find((p) => p.intent.type === "rewrite" && p.origin.type === "run" && p.origin.runId === runId);
  const commentsOf = (b: MockBackend, runId: string) => b.proposals.list().filter((p) => p.intent.type === "comment" && p.origin.type === "run" && p.origin.runId === runId);

  it("drafts its note and open questions as a description update with a Triage section, not as a comment", async () => {
    const b = sample();
    b.supervisor.dispose();
    const ws = (await b.workstreamsOpen(CA408)).id;
    const run = await triage(b, ws);
    const update = rewriteOf(b, run.id)!;
    expect(update).toMatchObject({ state: { type: "pending" }, createdBy: "agent", label: expect.stringMatching(/^From agent run /) });
    expect(isTriageDescription(update)).toBe(true);
    if (update.intent.type !== "rewrite" || !update.intent.body) throw new Error("a description update");
    expect(update.intent.title ?? null).toBeNull();
    expect(update.intent.body.fromText).toBe("Make the winback flow better.");
    expect(update.intent.body.toText).toContain("Make the winback flow better.\n\n## Triage\n\nThe ticket cannot be sized yet");
    expect(update.intent.body.toText).toContain("Open questions:\n\n- What does done look like for CA-408?");
    expect(commentsOf(b, run.id)).toEqual([]);
    expect(b.proposals.writes).toEqual([]);
    for (const word of [" I ", " we ", "Gossamr", "Pip"]) expect(update.intent.body.toText).not.toContain(word);
  });

  it("is revised by Pip in its Triage section, never in the plan or the person's text", async () => {
    const b = sample();
    b.supervisor.dispose();
    const ws = (await b.workstreamsOpen(CA408)).id;
    const update = rewriteOf(b, (await triage(b, ws)).id)!;
    if (update.intent.type !== "rewrite" || !update.intent.body) throw new Error("a description update");
    const text = update.intent.body.toText;
    const refused = "can change only its Triage section";
    expect(() => b.proposals.pipRevise(update.id, { description: `${text}\n\n## Gossamr Plan\n\nMy plan.` }, ws)).toThrow(refused);
    expect(() => b.proposals.pipRevise(update.id, { description: `Also this. ${text}` }, ws)).toThrow(refused);
    expect(() => b.proposals.pipRevise(update.id, { description: text.replace(/^#+ Triage$/m, "") }, ws)).toThrow(refused);
    const revised = b.proposals.pipRevise(update.id, { description: text.replace("The ticket cannot be sized yet", "The ticket is vague") }, ws);
    expect(revised.revisions[revised.revisions.length - 1]?.note).toBe("Revised by Pip");
  });

  it("is replaced by a later triage's update, which retires the older unedited one", async () => {
    const b = sample();
    b.supervisor.dispose();
    const ws = (await b.workstreamsOpen(CA408)).id;
    const first = rewriteOf(b, (await triage(b, ws)).id)!;
    const second = rewriteOf(b, (await triage(b, ws)).id)!;
    expect(b.proposals.get(first.id)?.state).toMatchObject({ type: "retired" });
    expect(b.proposals.get(second.id)?.state).toEqual({ type: "pending" });
  });

  it("turns ready after the reporter replied, with a note that says the answers in the comments were used and no question left", async () => {
    const b = sample();
    b.supervisor.dispose();
    const ws = (await b.workstreamsOpen(CA408)).id;
    const first = await triage(b, ws);
    const ask = await b.workstreamsReadinessAsk(ws, first.id);
    await b.proposalsApprove(ask.id);
    await new Promise((r) => setTimeout(r, 5));
    b.commentOnTicket("CA-408", "Done means the winback mail goes to lapsed customers. Only the winback flow. The CRM team asked.");
    const again = await triage(b, ws);
    expect(again.result).toContain("Ready to plan: yes");
    expect(again.result).not.toContain("Open questions:");
    const update = rewriteOf(b, again.id)!;
    if (update.intent.type !== "rewrite" || !update.intent.body) throw new Error("a description update");
    expect(update.intent.body.toText).toContain("The answers in the ticket's comments were used");
    expect(update.intent.body.toText).not.toContain("Open questions");
    expect(update.intent.body.toText).not.toContain("cannot be sized yet");
  });

  it("stays unclear while nobody has replied, and for a reply that came before anyone asked", async () => {
    const b = sample();
    b.supervisor.dispose();
    const ws = (await b.workstreamsOpen(CA408)).id;
    b.commentOnTicket("CA-408", "A comment from before the ask.");
    await new Promise((r) => setTimeout(r, 5));
    const run = await triage(b, ws);
    expect(run.result).toContain("Ready to plan: no\nOpen questions:");
  });
});
