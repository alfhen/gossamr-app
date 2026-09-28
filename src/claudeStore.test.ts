import { describe, expect, it } from "vitest";
import { applyEvent, applyProposal, type Conversation } from "./claudeStore";

const conv = (): Conversation => ({
  sessionId: null,
  cwd: null,
  turns: [
    { requestId: "r1", prompt: "q", steps: [], text: "", proposals: [], status: "running", error: null },
    { requestId: "r2", prompt: "q2", steps: [], text: "", proposals: [], status: "running", error: null },
  ],
});

describe("applyEvent", () => {
  it("streams text and steps into the matching turn only", () => {
    let c = applyEvent(conv(), "r1", { type: "text", text: "Hel" });
    c = applyEvent(c, "r1", { type: "text", text: "lo" });
    c = applyEvent(c, "r1", { type: "tool", label: "Read a.rs" });
    expect(c.turns[0]).toMatchObject({ text: "Hello", steps: ["Read a.rs"] });
    expect(c.turns[1].text).toBe("");
  });

  it("remembers the session so follow-ups continue it", () => {
    let c = applyEvent(conv(), "r1", { type: "started", sessionId: "s1" });
    expect(c.sessionId).toBe("s1");
    c = applyEvent(c, "r1", { type: "done", sessionId: null, ok: true, message: null });
    expect(c.sessionId).toBe("s1");
    expect(c.turns[0].status).toBe("done");
  });

  it("records failures", () => {
    const c = applyEvent(conv(), "r2", { type: "done", sessionId: null, ok: false, message: "Stopped" });
    expect(c.turns[1]).toMatchObject({ status: "failed", error: "Stopped" });
  });
});

describe("applyProposal", () => {
  it("adds a pending card to the turn that proposed it", () => {
    const c = applyProposal(conv(), { requestId: "r2", id: "0", kind: "comment", key: "A-1", body: "Hi" });
    expect(c.turns[1].proposals).toEqual([
      { proposal: { requestId: "r2", id: "0", kind: "comment", key: "A-1", body: "Hi" }, state: "pending", error: null },
    ]);
    expect(c.turns[0].proposals).toEqual([]);
  });
});
