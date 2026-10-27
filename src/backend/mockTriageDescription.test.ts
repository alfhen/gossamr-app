import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import { docFromMarkdown, markdownOf } from "./mockMarkdown";
import { QUESTIONS_LEAD, TRIAGE_HEADING, isTriageDescription, triageQuestionsOf, triageSectionOf, withTriageSection, withoutTriageSection } from "./mockTriageSection";
import { withPlanSection, planSectionOf } from "./mockPlanSection";
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
