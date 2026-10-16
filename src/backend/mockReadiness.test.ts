import { describe, expect, it } from "vitest";
import { docText } from "../lib/docs";
import type { ScreenContext } from "../types";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import { readinessLine, scriptPip, type PipWorkstream } from "./mockPip";
import { THIN_LIMIT, oneQuestionEach, reporterComment, reporterDoc, thinDescription, unclearTriageResult, unclearTriageSummary } from "./mockReadiness";
import { readiness } from "./mockSupervisor";

describe("a thin description", () => {
  it("is one non-empty line of fewer than 40 characters, and nothing else", () => {
    expect(thinDescription("Make the winback flow better.")).toBe(true);
    expect(thinDescription("  Make it better.  ")).toBe(true);
    expect(thinDescription("")).toBe(false);
    expect(thinDescription(null)).toBe(false);
    expect(thinDescription("   ")).toBe(false);
    expect(thinDescription("x".repeat(THIN_LIMIT))).toBe(false);
    expect(thinDescription("x".repeat(THIN_LIMIT - 1))).toBe(true);
    expect(thinDescription("One line.\nAnother line.")).toBe(false);
  });

  it("is only the vague sample ticket among the seeded tickets, so no other flow changes", () => {
    const b = new MockBackend();
    const thin = ["CA-408", "CA-401", "CA-402", "CA-405", "DEVOPS-471", "DEVOPS-473", "WEB-104", "SUP-12"].filter((key) => {
      const item = b.connector.item(itemRef(key));
      return item ? thinDescription(docText(item.body)) : false;
    });
    expect(thin).toEqual(["CA-408"]);
  });
});

describe("the sample triage of a vague ticket", () => {
  it("says Ready to plan: no with the open questions one to a bullet, and still recommends a plan, so only the stop holds it", () => {
    const text = unclearTriageResult("CA-408");
    expect(readiness(text)).toEqual({
      ready: false,
      questions: ["What does done look like for CA-408?", "Which behaviour or number should change?", "What is in scope and what is out?", "Who asked for this, and who is waiting on it?"],
    });
    expect(text).toContain("Plan recommended: yes");
    expect(text).toContain("For Jira:");
  });

  it("names what is open in its For Jira note and gives no count, which the app's one-question-each split would contradict (G18)", () => {
    const note = unclearTriageResult("CA-408").split("For Jira:\n")[1];
    expect(note).toContain("what done looks like");
    expect(note).not.toMatch(/\b(one|two|three|four|five|\d+) questions?\b/i);
    expect(note).not.toMatch(/\b(I|we)\b/);
  });
});

describe("the sample triage's summary (G16)", () => {
  it("counts the questions as they are listed, one each, so it never says three over four bullets", () => {
    // The result has three bullets, the first holding two questions: every reader lists four.
    const bullets = unclearTriageResult("CA-408").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    expect(bullets).toHaveLength(3);
    expect(oneQuestionEach(bullets)).toHaveLength(4);
    expect(unclearTriageSummary("CA-408")).toBe("Triage complete: the ticket isn't clear enough to size, four questions open");
  });
});

describe("the comment to the reporter", () => {
  const questions = ["What does done look like?", "Who is waiting on it?"];

  it("is the same words Rust drafts (reporter_comment in src-tauri/src/inbox/workstreams.rs)", () => {
    expect(reporterComment("Kim Ode", questions)).toBe(
      "Hi @Kim Ode,\n\nA few things need clearing up so the work can be planned:\n\n- What does done look like?\n- Who is waiting on it?\n\nCould you answer them here on the ticket? Thanks.",
    );
    const none = reporterComment(null, []);
    expect(none.startsWith("Hi,\n")).toBe(true);
    for (const part of ["- What is the goal?", "acceptance criteria", "in scope, and what is out", "who is waiting on it"]) expect(none).toContain(part);
  });

  it("puts one question on each bullet, even when a listed question holds two (G24)", () => {
    expect(oneQuestionEach(["What does done look like for CA-408? Which behaviour or number should change?", "Who is waiting on it?"])).toEqual(["What does done look like for CA-408?", "Which behaviour or number should change?", "Who is waiting on it?"]);
    // A question mark inside a sentence, or before a lower-case word, does not split.
    expect(oneQuestionEach(["Is v2? or v3 meant?", "Done?"])).toEqual(["Is v2? or v3 meant?", "Done?"]);
    const text = reporterComment(null, ["What is done? Who is waiting?"]);
    expect(text).toContain("\n\n- What is done?\n- Who is waiting?\n\n");
  });

  it("leaves the ticket key out and says in one line why the questions are asked (G21), in a neutral voice", () => {
    for (const text of [reporterComment("Kim Ode", questions), reporterComment("Kim Ode", questions, true), reporterComment(null, [])]) {
      expect(text).not.toMatch(/CA-\d|\b(we|I|runs?|workstreams?|Pip|Gossamr)\b/);
      expect(text).toMatch(/so the work can be planned|before the work can be planned/);
    }
  });

  it("speaks neutrally in the frame it falls back on: no 'we'", () => {
    expect(reporterComment(null, [])).not.toMatch(/\bwe\b/i);
  });

  it("thanks the reporter and says what is still open once they have replied, the same words Rust drafts", () => {
    const again = reporterComment("Kim Ode", questions, true);
    expect(again).toBe("Hi @Kim Ode,\n\nThanks for your answer above. A few things are still open before the work can be planned:\n\n- What does done look like?\n- Who is waiting on it?\n\nCould you answer these here on the ticket? Thanks.");
    expect(again).not.toBe(reporterComment("Kim Ode", questions));
  });

  it("makes the reporter's greeting a real mention when they are known", () => {
    const person = { connectionId: "mock", accountId: "mette" };
    const doc = reporterDoc(reporterComment("Mette Lund", questions), { person, name: "Mette Lund" });
    expect(docText(doc)).toBe(reporterComment("Mette Lund", questions));
    const first = doc.blocks[0];
    expect(first.type === "paragraph" && first.content.slice(0, 3)).toEqual([
      { type: "text", text: "Hi ", marks: [] },
      { type: "mention", person, name: "Mette Lund" },
      { type: "text", text: ",", marks: [] },
    ]);
    expect(JSON.stringify(reporterDoc("Hi,\n\nx", null))).not.toContain("mention");
  });
});

describe("Pip's first turn in a workstream", () => {
  const ctx: ScreenContext = { view: null, item: null, filter: null, selection: [], run: null, runsWaiting: 0, runsSummary: null } as unknown as ScreenContext;
  const GAPS = ["short", "done", "scope", "who"] as const;
  const ws = (over: Partial<PipWorkstream> = {}): PipWorkstream => ({ id: "ws-1", item: itemRef("CA-408"), first: true, clarity: GAPS, ...over });

  it("opens by saying plainly what a thin ticket leaves out, and keeps what it was asked", () => {
    const line = "CA-408 may be unclear: it has a very short description, doesn't say what done looks like, doesn't say what's in or out of scope, and doesn't say who is waiting on it.";
    expect(readinessLine(ws())).toBe(line);
    const script = scriptPip("Investigate CA-408", ctx, [], [], Date.now(), [], null, ws());
    expect(script.text.startsWith(`${line}\n\n`)).toBe(true);
    expect(script.text.length).toBeGreaterThan(line.length + 2);
    expect(script.steps[0]).toBe("Read the ticket");
    expect(scriptPip("Investigate CA-408", ctx, [], [], Date.now(), [], null, ws({ first: false })).text.startsWith(line)).toBe(false);
  });

  it("says nothing when the check found nothing or its notice is gone, for a later turn, or for no ticket", () => {
    expect(readinessLine(ws({ clarity: [] }))).toBeNull();
    expect(readinessLine(ws({ clarity: null }))).toBeNull();
    expect(readinessLine(ws({ first: false }))).toBeNull();
    expect(readinessLine(ws({ item: null }))).toBeNull();
    expect(readinessLine(null)).toBeNull();
  });

  it("is not part of a wake, which is the supervisor's, not Pip's first answer", () => {
    const script = scriptPip("[Event] run r1 (investigate) Done", ctx, [], [], Date.now(), [], null, ws());
    expect(script.text).not.toContain("may be unclear");
  });
});
