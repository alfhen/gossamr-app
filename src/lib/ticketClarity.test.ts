import { describe, expect, it } from "vitest";
import { clarityGaps, clarityQuestions, clarityRepliedText, clarityText, gapsPhrase, type ClarityGap } from "./ticketClarity";
import fixtures from "./ticketClarity.fixtures.json";

describe("ticketClarity", () => {
  it("reads every shared case as the Rust side does", () => {
    for (const c of fixtures.cases) expect(clarityGaps(c.text), c.name).toEqual(c.gaps);
  });

  it("treats no description at all as empty", () => {
    expect(clarityGaps(null)).toEqual(["empty"]);
    expect(clarityGaps(undefined)).toEqual(["empty"]);
  });

  it("reads the gaps as one phrase after 'it'", () => {
    expect(gapsPhrase(["empty"])).toBe("has no description");
    expect(gapsPhrase(["done", "who"])).toBe("doesn't say what done looks like and doesn't say who is waiting on it");
    expect(gapsPhrase(["short", "done", "scope"])).toBe("has a very short description, doesn't say what done looks like, and doesn't say what's in or out of scope");
    expect(clarityText("CA-408", ["short", "done", "scope", "who"])).toBe(
      "CA-408 may be unclear: it has a very short description, doesn't say what done looks like, doesn't say what's in or out of scope, and doesn't say who is waiting on it.",
    );
  });

  it("says the reporter replied instead of the gaps once they have", () => {
    expect(clarityRepliedText("CA-408")).toBe("CA-408: the reporter replied; read it, then Looks fine or ask again.");
  });

  it("asks one question per gap, none twice, and all four for an empty description", () => {
    expect(clarityQuestions(["short", "done"])).toEqual(["What is the goal?", "How will we know it is done (the acceptance criteria)?"]);
    expect(clarityQuestions(["empty"])).toHaveLength(4);
    const gaps: ClarityGap[] = ["short", "done", "scope", "who"];
    expect(clarityQuestions(gaps)).toEqual(clarityQuestions(["empty"]));
  });
});
