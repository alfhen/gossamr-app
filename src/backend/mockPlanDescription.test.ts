import { describe, expect, it } from "vitest";
import { docFromMarkdown, markdownOf } from "./mockMarkdown";
import { PLAN_HEADING, planSectionOf, withPlanSection, withoutPlanSection } from "./mockPlanSection";

describe("the Gossamr Plan section of a description in the sample build", () => {
  const wrapped = (inner: string) => `<details>\n<summary>Gossamr Plan</summary>\n\n${inner}\n\n</details>`;

  it("is written as one Gossamr Plan expand at the end, replaced in place by a re-plan, and taken out again", () => {
    const doc = docFromMarkdown("Intro\n\n## Notes\n\nKeep me");
    const once = withPlanSection(doc, "intro line", docFromMarkdown("# Approach\n\nRound once.\n\n## Steps\n\n1. Edit"));
    expect(once.blocks[once.blocks.length - 1]).toMatchObject({ type: "expand", title: "Gossamr Plan" });
    expect(markdownOf(once)).toBe(`Intro\n\n## Notes\n\nKeep me\n\n${wrapped("intro line\n\n# Approach\n\nRound once.\n\n## Steps\n\n1. Edit")}`);
    expect(markdownOf(planSectionOf(once)!)).toBe("intro line\n\n# Approach\n\nRound once.\n\n## Steps\n\n1. Edit");
    const twice = withPlanSection(once, "newer", docFromMarkdown("Round twice."));
    expect(markdownOf(twice)).toBe(`Intro\n\n## Notes\n\nKeep me\n\n${wrapped("newer\n\nRound twice.")}`);
    expect(markdownOf(withoutPlanSection(twice))).toBe("Intro\n\n## Notes\n\nKeep me");
    expect(PLAN_HEADING).toBe("Gossamr Plan");
  });

  it("is read from the expand and from the old heading section, and an old heading section is replaced by the expand, not stacked", () => {
    const expand = docFromMarkdown(`Intro\n\n${wrapped("in the expand")}\n\n## After\n\nout`);
    expect(markdownOf(planSectionOf(expand)!)).toBe("in the expand");
    expect(markdownOf(withoutPlanSection(expand))).toBe("Intro\n\n## After\n\nout");
    const old = docFromMarkdown("Intro\n\n## Gossamr Plan\n\nold intro\n\n### Old\n\nold text\n\n## Notes\n\nkeep me");
    expect(markdownOf(planSectionOf(old)!)).toBe("old intro\n\n### Old\n\nold text");
    const replaced = withPlanSection(old, "new intro", docFromMarkdown("New plan."));
    expect(markdownOf(replaced)).toBe(`Intro\n\n${wrapped("new intro\n\nNew plan.")}\n\n## Notes\n\nkeep me`);
    expect(markdownOf(replaced)).not.toContain("## Gossamr Plan");
    const deep = withPlanSection(docFromMarkdown("###### Gossamr Plan\n\nold"), "i", docFromMarkdown("###### Deep\n\ntext"));
    expect(markdownOf(deep)).toBe(wrapped("i\n\n###### Deep\n\ntext"));
  });

  it("turns a plan heading that names itself into text, so it can't be taken for the old marker", () => {
    const next = withPlanSection(docFromMarkdown("x"), "i", docFromMarkdown("## Gossamr Plan\n\ntext"));
    expect(markdownOf(planSectionOf(next)!)).toBe("i\n\nGossamr Plan\n\ntext");
    expect(next.blocks.filter((b) => b.type === "heading")).toHaveLength(0);
  });

  it("ends at the next heading of its own level or above and is found whatever its case", () => {
    const doc = docFromMarkdown("# gossamr plan:\n\nin\n\n## Inner\n\nalso in\n\n# Next\n\nout");
    expect(markdownOf(planSectionOf(doc)!)).toBe("in\n\n## Inner\n\nalso in");
    expect(markdownOf(withoutPlanSection(doc))).toBe("# Next\n\nout");
    expect(planSectionOf(docFromMarkdown("Just text"))).toBeNull();
  });
});
