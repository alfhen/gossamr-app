import { describe, expect, it } from "vitest";
import { docText } from "../lib/docs";
import type { ScreenContext } from "../types";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import { readinessLine, scriptPip, type PipWorkstream } from "./mockPip";
import { THIN_LIMIT, gapsSentence, readinessGaps, reporterComment, reporterDoc, thinDescription, unclearTriageResult } from "./mockReadiness";
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

describe("what a thin description leaves out", () => {
  it("names each of the four things it doesn't say, less the cue that says it", () => {
    expect(readinessGaps("Make the winback flow better.")).toEqual(["what done looks like", "what's in or out of scope", "who is waiting on it"]);
    expect(readinessGaps("Done when the flow sends")).toEqual(["what's in or out of scope", "who is waiting on it"]);
    expect(readinessGaps("Mette asked for it; only emails")).toEqual(["what done looks like"]);
  });

  it("says it as one plain sentence naming the ticket", () => {
    expect(gapsSentence("CA-408", ["what done looks like", "what's in or out of scope", "who is waiting on it"])).toBe("CA-408 doesn't say what done looks like, what's in or out of scope, or who is waiting on it.");
    expect(gapsSentence("CA-408", ["what done looks like"])).toBe("CA-408 doesn't say what done looks like.");
  });
});

describe("the sample triage of a vague ticket", () => {
  it("says Ready to plan: no with three open questions, and still recommends a plan, so only the stop holds it", () => {
    const text = unclearTriageResult("CA-408");
    expect(readiness(text)).toEqual({
      ready: false,
      questions: ["What does done look like for CA-408? Which behaviour or number should change?", "What is in scope and what is out?", "Who asked for this, and who is waiting on it?"],
    });
    expect(text).toContain("Plan recommended: yes");
    expect(text).toContain("For Jira:");
  });
});

describe("the comment to the reporter", () => {
  const questions = ["What does done look like?", "Who is waiting on it?"];

  it("is the same words Rust drafts (reporter_comment in src-tauri/src/inbox/workstreams.rs)", () => {
    expect(reporterComment("CA-401", "Kim Ode", questions)).toBe(
      "Hi @Kim Ode,\n\nBefore CA-401 can be planned we need a few things cleared up:\n\n- What does done look like?\n- Who is waiting on it?\n\nCould you answer them here on the ticket? Thanks.",
    );
    const none = reporterComment("CA-401", null, []);
    expect(none.startsWith("Hi,\n")).toBe(true);
    for (const part of ["- What is the goal?", "acceptance criteria", "in scope, and what is out", "who is waiting on it"]) expect(none).toContain(part);
  });

  it("makes the reporter's greeting a real mention when they are known", () => {
    const person = { connectionId: "mock", accountId: "mette" };
    const doc = reporterDoc(reporterComment("CA-401", "Mette Lund", questions), { person, name: "Mette Lund" });
    expect(docText(doc)).toBe(reporterComment("CA-401", "Mette Lund", questions));
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
  const ws = (over: Partial<PipWorkstream> = {}): PipWorkstream => ({ id: "ws-1", item: itemRef("CA-408"), first: true, ticketText: "Make the winback flow better.", ...over });

  it("opens by saying plainly what a vague ticket leaves out, and keeps what it was asked", () => {
    const line = "CA-408 doesn't say what done looks like, what's in or out of scope, or who is waiting on it.";
    expect(readinessLine(ws())).toBe(line);
    const script = scriptPip("Investigate CA-408", ctx, [], [], Date.now(), [], null, ws());
    expect(script.text.startsWith(`${line}\n\n`)).toBe(true);
    expect(script.text.length).toBeGreaterThan(line.length + 2);
    expect(script.steps[0]).toBe("Read the ticket");
    expect(scriptPip("Investigate CA-408", ctx, [], [], Date.now(), [], null, ws({ first: false })).text.startsWith(line)).toBe(false);
  });

  it("says nothing for a ticket with a real description or none, for a later turn, or for no ticket", () => {
    expect(readinessLine(ws({ ticketText: "Retries back off and cap at five attempts, so a provider outage doesn't build a wave." }))).toBeNull();
    expect(readinessLine(ws({ ticketText: null }))).toBeNull();
    expect(readinessLine(ws({ first: false }))).toBeNull();
    expect(readinessLine(ws({ item: null }))).toBeNull();
    expect(readinessLine(null)).toBeNull();
  });

  it("is not part of a wake, which is the supervisor's, not Pip's first answer", () => {
    const script = scriptPip("[Event] run r1 (investigate) Done", ctx, [], [], Date.now(), [], null, ws());
    expect(script.text).not.toContain("doesn't say");
  });
});
