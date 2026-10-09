import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import { docFromMarkdown, markdownOf } from "./mockMarkdown";
import { PLAN_HEADING, approvedPlanText, planIntro, planSectionOf, withPlanSection, withoutPlanSection } from "./mockPlanSection";
import { scriptPip } from "./mockPip";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const sample = () => new MockBackend({ runs: { seed: "kinds", epoch: NOW, planDescription: true } });
const planRun = (b: MockBackend) => b.runs.list().find((r) => r.spec.kind === "plan")!;
const rewrites = (b: MockBackend) => b.proposals.list().filter((p) => p.intent.type === "rewrite");

describe("the Gossamr Plan section of a description in the sample build", () => {
  it("is added at the end with the plan's headings moved below it, replaced in place by a re-plan, and taken out again", () => {
    const doc = docFromMarkdown("Intro\n\n## Notes\n\nKeep me");
    const once = withPlanSection(doc, "intro line", docFromMarkdown("# Approach\n\nRound once.\n\n## Steps\n\n1. Edit"));
    expect(markdownOf(once)).toBe("Intro\n\n## Notes\n\nKeep me\n\n## Gossamr Plan\n\nintro line\n\n### Approach\n\nRound once.\n\n#### Steps\n\n1. Edit");
    expect(markdownOf(planSectionOf(once)!)).toContain("### Approach");
    const twice = withPlanSection(once, "newer", docFromMarkdown("Round twice."));
    expect(markdownOf(twice)).toBe("Intro\n\n## Notes\n\nKeep me\n\n## Gossamr Plan\n\nnewer\n\nRound twice.");
    expect(markdownOf(withoutPlanSection(twice))).toBe("Intro\n\n## Notes\n\nKeep me");
    expect(PLAN_HEADING).toBe("Gossamr Plan");
  });

  it("never lets a plan heading capped at the section's own level end the section", () => {
    const doc = docFromMarkdown("Intro\n\n###### Gossamr Plan\n\nold");
    const next = withPlanSection(doc, "i", docFromMarkdown("###### Deep\n\ntext"));
    expect(markdownOf(next)).toBe("Intro\n\n###### Gossamr Plan\n\ni\n\nDeep\n\ntext");
    expect(markdownOf(planSectionOf(next)!)).toBe("i\n\nDeep\n\ntext");
  });

  it("keeps headings nested below the section, moves a plan that starts shallower than the marker, and turns only the ones that reach its level into text", () => {
    const deep = withPlanSection(docFromMarkdown("### Gossamr Plan\n\nold"), "i", docFromMarkdown("# One\n\n## Two\n\ntext"));
    expect(markdownOf(deep)).toBe("### Gossamr Plan\n\ni\n\n#### One\n\n##### Two\n\ntext");
    const kept = withPlanSection(docFromMarkdown("## Gossamr Plan"), "i", docFromMarkdown("### Below\n\n#### Further"));
    expect(markdownOf(kept)).toBe("## Gossamr Plan\n\ni\n\n### Below\n\n#### Further");
    const capped = withPlanSection(docFromMarkdown("##### Gossamr Plan"), "i", docFromMarkdown("# A\n\n## B"));
    expect(markdownOf(capped)).toBe("##### Gossamr Plan\n\ni\n\n###### A\n\n###### B");
  });

  it("ends at the next heading of its own level or above and is found whatever its case", () => {
    const doc = docFromMarkdown("# gossamr plan:\n\nin\n\n## Inner\n\nalso in\n\n# Next\n\nout");
    expect(markdownOf(planSectionOf(doc)!)).toBe("in\n\n## Inner\n\nalso in");
    expect(markdownOf(withoutPlanSection(doc))).toBe("# Next\n\nout");
    expect(planSectionOf(docFromMarkdown("Just text"))).toBeNull();
  });
});

describe("a finished plan run in the sample build", () => {
  it("has a description draft on its seeded ticket, with the plan as a section and without its closing note", () => {
    const b = sample();
    const run = planRun(b);
    const [draft] = rewrites(b);
    expect(draft.origin).toMatchObject({ type: "run", runId: run.id });
    expect(draft.createdBy).toBe("agent");
    if (draft.intent.type !== "rewrite" || !draft.intent.body) throw new Error("a description rewrite");
    const to = draft.intent.body.toText;
    expect(to).toContain("## Gossamr Plan");
    expect(to).toContain("Drafted by an agent run");
    expect(to).toContain("### Approach");
    expect(to).toContain("Do the Klaviyo flows read the subject lines");
    expect(to).not.toContain("For Jira");
    expect(draft.intent.body.fromText).toBe(markdownOf(b.connector.item(run.item!)!.body));
    expect(b.runs.outcome(run.id).planDescription).toEqual({ draft: { id: draft.id, state: { type: "pending" } }, unavailable: null });
  });

  it("is made once, whatever asks, and a skipped one is only made again by the person", async () => {
    const b = sample();
    const run = planRun(b);
    await expect(b.runsDraftPlanDescription(run.id)).rejects.toThrow("already has this plan");
    b.runs.seedPlanDescriptions();
    expect(rewrites(b)).toHaveLength(1);
    await b.proposalsSkip(rewrites(b)[0].id);
    b.runs.seedPlanDescriptions();
    expect(rewrites(b)).toHaveLength(1);
    expect(b.runs.outcome(run.id).planDescription?.draft?.state.type).toBe("skipped");
    const again = await b.runsDraftPlanDescription(run.id);
    expect(again.state.type).toBe("pending");
    expect(rewrites(b)).toHaveLength(2);
  });

  it("is not drafted without the seed option and can then be drafted from the sheet", async () => {
    const b = new MockBackend({ runs: { seed: "kinds", epoch: NOW } });
    const run = planRun(b);
    expect(rewrites(b)).toHaveLength(0);
    expect(b.runs.outcome(run.id).planDescription).toEqual({ draft: null, unavailable: null });
    const made = await b.runsDraftPlanDescription(run.id);
    expect(made.intent.type).toBe("rewrite");
    expect(b.runs.outcome(run.id).planDescription?.draft?.id).toBe(made.id);
  });

  it("is written to the ticket on approval, and a ticket that moved on is left alone", async () => {
    const b = sample();
    const run = planRun(b);
    const [draft] = rewrites(b);
    b.connector.rewrite(run.item!, { body: docFromMarkdown("A colleague got there first") });
    const refused = await b.proposalsApprove(draft.id);
    expect(refused.state.type).toBe("pending");
    expect(refused.error).toMatch(/changed since this was drafted/);

    const fresh = sample();
    const again = rewrites(fresh)[0];
    expect((await fresh.proposalsApprove(again.id)).state.type).toBe("applied");
    expect(markdownOf(fresh.connector.item(planRun(fresh).item!)!.body)).toContain("## Gossamr Plan");
    expect(fresh.runs.outcome(planRun(fresh).id).planDescription?.draft?.state.type).toBe("applied");
  });

  it("falls back, with the reason, when the tracker can't edit text, and keeps the comment path", async () => {
    const b = new MockBackend({ runs: { seed: "kinds", epoch: NOW } });
    b.runs.cannotEditText = true;
    const run = planRun(b);
    expect(b.runs.outcome(run.id).planDescription?.unavailable).toContain("can't change a ticket's description");
    await expect(b.runsDraftPlanDescription(run.id)).rejects.toThrow("can't change a ticket's description");
    expect((await b.runsDraftPlanComment(run.id)).proposal.intent.type).toBe("comment");
  });

  it("is drafted with the status comment when a plan run reaches done, and a second plan replaces the waiting draft", async () => {
    const b = new MockBackend({ runs: { seed: "empty", epoch: NOW } });
    const item = itemRef("CA-402");
    const spec = { ...planRun(sample()).spec, name: "ca-402-plan-0001" };
    const started = async (name: string) => {
      const draft = await b.runs.draft({ ...spec, name, kind: "plan" }, item);
      return b.runs.approve(draft.id, (await b.runs.review(draft.id)).digest);
    };
    const run = await started("ca-402-plan-0001");
    b.runs.startNow(run.id);
    b.runs.advance(run.id);
    b.runs.advance(run.id);
    expect(rewrites(b)).toHaveLength(1);
    expect(b.proposals.list().filter((p) => p.intent.type === "comment")).toHaveLength(1);
    const second = await started("ca-402-plan-0002");
    b.runs.startNow(second.id);
    b.runs.advance(second.id);
    b.runs.advance(second.id);
    const waiting = rewrites(b).filter((p) => p.state.type === "pending");
    expect(waiting).toHaveLength(1);
    expect(rewrites(b).filter((p) => p.state.type === "retired")).toHaveLength(1);
    const to = waiting[0].intent.type === "rewrite" ? waiting[0].intent.body!.toText : "";
    expect(to.match(/Gossamr Plan/g)).toHaveLength(1);
  });
});

describe("an edited description update in the sample build", () => {
  it("is kept when a newer plan finishes, and the person is told why no second one is drafted", async () => {
    const b = sample();
    const run = planRun(b);
    const [draft] = rewrites(b);
    await b.proposalsEdit(draft.id, { type: "rewrite", body: "Hello\n\n## Gossamr Plan\n\nThe person's own words." });
    await expect(b.runsDraftPlanDescription(run.id)).rejects.toThrow(/you edited/);
    expect(rewrites(b)).toHaveLength(1);
    expect(b.proposals.get(draft.id)?.state.type).toBe("pending");
  });

  it("is not in the way of an unedited one, which a newer plan retires", async () => {
    const b = new MockBackend({ runs: { seed: "kinds", epoch: NOW } });
    const run = planRun(b);
    const first = await b.runsDraftPlanDescription(run.id);
    b.runs.advance();
    await b.proposalsSkip(first.id);
    expect((await b.runsDraftPlanDescription(run.id)).state.type).toBe("pending");
  });
});

describe("Pip and a plan's description draft", () => {
  const screen = { view: "Agents", selection: [], item: null, filter: null, run: null } as never;
  const ask = (b: MockBackend, text: string, discussed: string | null) => scriptPip(text, screen, [], b.runs.list(), NOW, b.proposals.list(), discussed);

  it("reads the draft when asked to chat it over, and shortens it only when asked and never after the person edited it", async () => {
    const b = sample();
    const run = planRun(b);
    const [draft] = rewrites(b);
    const first = ask(b, `Let's talk about the description update draft ${draft.id} on ${run.item!.key}, drafted from agent run ${run.id}. Read the whole run first.`, null);
    expect(first.discussed).toBe(draft.id);
    expect(first.revise).toBeUndefined();
    const script = ask(b, "shorter please", draft.id);
    expect(script.revise?.id).toBe(draft.id);
    const revised = b.proposals.pipRevise(draft.id, { description: script.revise!.description });
    if (revised.intent.type !== "rewrite" || !revised.intent.body || draft.intent.type !== "rewrite") throw new Error("a rewrite");
    expect(revised.revisions[revised.revisions.length - 1]?.note).toBe("Revised by Pip");
    expect(revised.intent.body.toText).toContain("## Gossamr Plan");
    expect(revised.intent.body.toText.length).toBeLessThan(draft.intent.body!.toText.length);
    await b.proposalsEdit(draft.id, { type: "rewrite", body: "The person's own words" });
    expect(() => b.proposals.pipRevise(draft.id, { description: "Pip again" })).toThrow("edited this description draft");
  });

  it("says so when the draft is gone", () => {
    const b = sample();
    expect(ask(b, "Let's talk about the description update draft nope on CA-1, drafted from agent run r1.", null).text).toContain("can't find that description draft");
  });
});

describe("the plan a build takes from an approved description", () => {
  it("is the section without the intro Gossamr wrote, whatever its date or run, and keeps the person's own lines", () => {
    const intro = planIntro({ shortId: "ab12cd34", endedAt: "2026-09-29T10:00:00Z", queuedAt: "2026-09-29T09:00:00Z" });
    const doc = withPlanSection(docFromMarkdown("Intro"), intro, docFromMarkdown("# Approach\n\nRound once.\n\nA line the person added."));
    expect(approvedPlanText(planSectionOf(doc)!)).toBe("### Approach\n\nRound once.\n\nA line the person added.");
    const older = withPlanSection(docFromMarkdown(""), "Drafted by an agent run on 2025-01-01. Something else.", docFromMarkdown("Step."));
    expect(approvedPlanText(planSectionOf(older)!)).toBe("Step.");
    expect(approvedPlanText(planSectionOf(docFromMarkdown("## Gossamr Plan\n\nThe person removed the intro."))!)).toBe("The person removed the intro.");
    expect(approvedPlanText(planSectionOf(withPlanSection(docFromMarkdown("x"), intro, docFromMarkdown("")))!)).toBe("");
  });
});
