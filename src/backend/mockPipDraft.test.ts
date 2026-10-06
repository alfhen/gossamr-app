import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";
import { openQuestions, scriptPip } from "./mockPip";
import type { ScreenContext } from "../types";

const NOW = Date.parse("2026-09-30T12:00:00Z");

describe("mock Pip reading a draft in full", () => {
  const b = new MockBackend({ runs: { seed: "kinds", epoch: NOW, planDescription: true } });
  const run = b.runs.list().find((r) => r.spec.kind === "plan")!;
  const drafts = b.proposals.list();
  const context = { screen: "board", item: run.item } as unknown as ScreenContext;

  it("answers 'can you see its draft description update' with the draft's open questions", () => {
    const reply = scriptPip("can you see its draft description update?", context, [], [], NOW, drafts);
    expect(reply.steps).toEqual(["Read the draft in full"]);
    expect(reply.text).toContain("Do the Klaviyo flows read the subject lines");
    expect(reply.text).toContain("Should the second email keep its two-day delay");
    expect(reply.text).not.toMatch(/can't see|truncated/);
    expect(reply.discussed).toBeTruthy();
  });

  it("asks which draft when none is on screen", () => {
    const reply = scriptPip("can you see the draft?", { screen: "board", item: null } as unknown as ScreenContext, [], [], NOW, drafts);
    expect(reply.text).toContain("Which draft");
  });

  it("finds an open-questions section under a heading or after a lead-in and stops at the next heading", () => {
    expect(openQuestions("a\n\n## Open questions\n\n- one\n- two\n\n## Next\n\nx")).toBe("- one\n- two");
    expect(openQuestions("a\n\nOpen questions: who owns it?")).toBe("who owns it?");
    expect(openQuestions("nothing here")).toBeNull();
  });
});

describe("open questions in a run result", () => {
  it("stop before the For Jira section", () => {
    expect(openQuestions("## Open questions for a person\n\n- one?\n\nFor Jira:\nsummary")).toBe("- one?");
  });
});
