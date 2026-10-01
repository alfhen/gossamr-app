import { beforeEach, describe, expect, it } from "vitest";
import { MockBackend } from "./backend/mock";
import { applyEvent, useClaude, watchProposals, type Conversation } from "./claudeStore";
import type { AskRequest } from "./backend/claude";
import type { Intent } from "./types";

const conv = (): Conversation => ({
  sessionId: null,
  turns: [
    { requestId: "r1", prompt: "q", steps: [], text: "", status: "running", error: null },
    { requestId: "r2", prompt: "q2", steps: [], text: "", status: "running", error: null },
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

const ref = { connectionId: "mock", externalId: "CA-1", key: "CA-1" };
const comment = (text: string): Intent => ({
  type: "comment",
  item: ref,
  body: { blocks: [{ type: "paragraph", content: [{ type: "text", text, marks: [] }] }] },
});

describe("watchProposals", () => {
  beforeEach(() => useClaude.setState({ proposals: [] }));

  it("loads the backend's drafts and follows changes, so drafts survive a restart", async () => {
    const backend = new MockBackend();
    const before = backend.proposals.draft(comment("made before the window opened"));
    watchProposals(backend);
    await Promise.resolve();
    await Promise.resolve();
    expect(useClaude.getState().proposals.map((p) => p.id)).toEqual([before.id]);

    const later = backend.proposals.draft(comment("made while it was open"));
    await new Promise((r) => setTimeout(r, 0));
    expect(useClaude.getState().proposals.map((p) => p.id)).toEqual([later.id, before.id]);

    await backend.proposalsSkip(before.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(useClaude.getState().proposals.find((p) => p.id === before.id)?.state.type).toBe("skipped");
  });

  it("stops following a backend once another is watched", async () => {
    const first = new MockBackend();
    const second = new MockBackend();
    watchProposals(first);
    watchProposals(second);
    first.proposals.draft(comment("ignored"));
    await new Promise((r) => setTimeout(r, 0));
    expect(useClaude.getState().proposals).toEqual([]);
  });

  it("puts a returned draft in place without waiting for the refresh", () => {
    const backend = new MockBackend();
    const p = backend.proposals.draft(comment("x"));
    useClaude.getState().putProposal(p);
    useClaude.getState().putProposal({ ...p, state: { type: "applied" } });
    expect(useClaude.getState().proposals).toHaveLength(1);
    expect(useClaude.getState().proposals[0].state.type).toBe("applied");
  });
});

describe("ask", () => {
  it("sends the screen context with the question and never relies on the session for it", async () => {
    const sent: unknown[] = [];
    const { claude } = await import("./backend/claude");
    const original = claude.ask;
    claude.ask = async (req) => void sent.push(req);
    try {
      await useClaude.getState().ask("CA-9", "what next?", null);
      const custom = { view: "board", item: null, filter: { type: "mine" as const }, selection: [ref] };
      await useClaude.getState().ask("CA-9", "and now?", null, custom);
    } finally {
      claude.ask = original;
    }
    expect(sent[0]).toMatchObject({
      prompt: "what next?",
      context: { view: null, item: { connectionId: "", externalId: "CA-9", key: "CA-9" }, filter: null, selection: [] },
    });
    expect(sent[1]).toMatchObject({ context: { view: "board", filter: { type: "mine" }, selection: [ref] } });
    expect(sent[0]).not.toHaveProperty("ticketKey");
    expect(sent.every((r) => !("cwd" in (r as object)))).toBe(true);
  });

  it("sends images with the request and keeps only what's needed to show them in the turn", async () => {
    const sent: AskRequest[] = [];
    const { claude } = await import("./backend/claude");
    const original = claude.ask;
    claude.ask = async (req) => void sent.push(req);
    const image = { id: "i1", mediaType: "image/png", data: "AAAA", url: "blob:x", width: 10, height: 20 };
    try {
      await useClaude.getState().ask("CA-10", "look", null, undefined, { images: [image] });
      await useClaude.getState().ask("CA-10", "no picture", null);
    } finally {
      claude.ask = original;
    }
    expect(sent[0].images).toEqual([{ mediaType: "image/png", data: "AAAA" }]);
    expect(sent[1]).not.toHaveProperty("images");
    const [first, second] = useClaude.getState().byTicket["CA-10"].turns;
    expect(first.images).toEqual([{ id: "i1", url: "blob:x", width: 10, height: 20 }]);
    expect(JSON.stringify(first)).not.toContain("AAAA");
    expect(second).not.toHaveProperty("images");
  });
});
