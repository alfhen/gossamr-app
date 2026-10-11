import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "./backend/mock";
import { applyEvent, catchUp, forgetConversations, listenToClaude, mergeStored, onClaudeEvent, useClaude, watchProposals, withQuote, type Conversation } from "./claudeStore";
import { claude, type AskRequest, type ClaudeEvent, type StoredTurn } from "./backend/claude";
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
const started = { queued: false, ahead: 0 };
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
    claude.ask = async (req) => (sent.push(req), started);
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
    claude.ask = async (req) => (sent.push(req), started);
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

const usage = { inputTokens: 120, outputTokens: 30, cacheCreationTokens: 0, cacheReadTokens: 8, costUsd: 0.0008 };

const stored = (requestId: string, over: Partial<StoredTurn> = {}): StoredTurn => ({
  requestId,
  conversation: "workspace",
  prompt: `asked ${requestId}`,
  imageCount: 0,
  text: `answer ${requestId}`,
  steps: ["Looked up CA-1"],
  status: "done",
  error: null,
  sessionId: null,
  usage: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  ...over,
});

describe("usage", () => {
  it("is kept on the turn when the answer is done", () => {
    const c = applyEvent(conv(), "r1", { type: "done", sessionId: "s1", ok: true, message: null, usage });
    expect(c.turns[0]).toMatchObject({ status: "done", usage });
    expect(c.turns[1]).not.toHaveProperty("usage");
    expect(applyEvent(conv(), "r1", { type: "done", sessionId: null, ok: true, message: null }).turns[0]).not.toHaveProperty("usage");
  });
});

describe("load", () => {
  beforeEach(() => useClaude.setState({ byTicket: {} }));
  afterEach(() => vi.restoreAllMocks());

  it("brings back stored turns in order and the newest session, without replacing a turn still running", async () => {
    useClaude.setState({
      byTicket: { workspace: { sessionId: null, turns: [{ requestId: "r3", prompt: "live", steps: ["Reading"], text: "half", status: "running", error: null }] } },
    });
    vi.spyOn(claude, "turns").mockResolvedValue([
      stored("r1", { sessionId: "s-old", usage }),
      stored("r2", { sessionId: "s-new", quote: "the bit", prompt: withQuote("what is this?", "the bit"), looking: "CA-401", imageCount: 2 }),
      stored("r3", { status: "failed", error: "Gossamr closed before Pip finished", text: "" }),
    ]);
    await useClaude.getState().load("workspace");
    const c = useClaude.getState().byTicket.workspace;
    expect(c.turns.map((t) => t.requestId)).toEqual(["r1", "r2", "r3"]);
    expect(c.turns[2]).toMatchObject({ status: "running", text: "half", steps: ["Reading"] });
    expect(c.turns[0]).toMatchObject({ status: "done", text: "answer r1", usage });
    expect(c.turns[1]).toMatchObject({ prompt: "what is this?", quote: "the bit", looking: "CA-401", imageCount: 2 });
    expect(c.turns[1]).not.toHaveProperty("images");
    expect(c.sessionId).toBe("s-new");

    await useClaude.getState().load("workspace");
    expect(useClaude.getState().byTicket.workspace.turns).toHaveLength(3);
  });

  it("keeps the session the conversation already has", () => {
    const c = mergeStored({ sessionId: "mine", turns: [] }, [stored("r1", { sessionId: "theirs" })]);
    expect(c.sessionId).toBe("mine");
    expect(mergeStored({ sessionId: null, turns: [] }, [stored("r1")]).sessionId).toBeNull();
  });

  it("does nothing when nothing is stored or the backend can't say", async () => {
    vi.spyOn(claude, "turns").mockRejectedValue(new Error("not signed in"));
    await useClaude.getState().load("CA-1");
    expect(useClaude.getState().byTicket).toEqual({});
  });

  it("drops turns that arrive after the conversations were forgotten, as on an account switch", async () => {
    let answer: (t: StoredTurn[]) => void = () => {};
    vi.spyOn(claude, "turns").mockReturnValue(new Promise((r) => (answer = r)));
    const loading = useClaude.getState().load("workspace");
    forgetConversations();
    answer([stored("r1")]);
    await loading;
    expect(useClaude.getState().byTicket).toEqual({});
  });

  it("sends the conversation and what the turn showed with each question", async () => {
    const sent: AskRequest[] = [];
    vi.spyOn(claude, "ask").mockImplementation(async (req) => (sent.push(req), started));
    await useClaude.getState().ask("workspace", "what next?", null, undefined, { looking: "CA-401", quote: "this" });
    await useClaude.getState().ask("CA-7", "and here?", null);
    expect(sent[0]).toMatchObject({ conversation: "workspace", meta: { looking: "CA-401", quote: "this", imageCount: 0 } });
    expect(sent[1]).toMatchObject({ conversation: "CA-7", meta: { imageCount: 0 } });
  });
});

describe("queued turns", () => {
  beforeEach(() => useClaude.setState({ byTicket: {} }));
  afterEach(() => vi.restoreAllMocks());

  const statuses = () => useClaude.getState().byTicket.workspace.turns.map((t) => t.status);

  it("appends a turn as queued when the backend queued it, and the running event starts it", async () => {
    vi.spyOn(claude, "ask").mockResolvedValueOnce(started).mockResolvedValueOnce({ queued: true, ahead: 1 });
    await useClaude.getState().ask("workspace", "first", null);
    await useClaude.getState().ask("workspace", "second", "s1");
    expect(statuses()).toEqual(["running", "queued"]);
    const second = useClaude.getState().byTicket.workspace.turns[1].requestId;
    const c = applyEvent(useClaude.getState().byTicket.workspace, second, { type: "running" });
    expect(c.turns.map((t) => t.status)).toEqual(["running", "running"]);
  });

  it("maps the queued and running events, and never queues a turn that already ended", () => {
    let c = applyEvent(conv(), "r2", { type: "queued", ahead: 1 });
    expect(c.turns.map((t) => t.status)).toEqual(["running", "queued"]);
    c = applyEvent(c, "r2", { type: "running" });
    expect(c.turns[1].status).toBe("running");
    c = applyEvent(c, "r2", { type: "done", sessionId: null, ok: true, message: null });
    expect(applyEvent(c, "r2", { type: "queued", ahead: 0 }).turns[1].status).toBe("done");
    expect(applyEvent(c, "r2", { type: "running" }).turns[1].status).toBe("done");
  });

  it("does not mark a turn queued when it started before the backend's answer arrived", async () => {
    let events: (requestId: string, e: ClaudeEvent) => void = () => {};
    vi.spyOn(claude, "onEvent").mockImplementation((cb) => ((events = cb), () => {}));
    listenToClaude();
    vi.spyOn(claude, "ask").mockImplementation(async (req) => {
      events(req.requestId, { type: "queued", ahead: 1 });
      events(req.requestId, { type: "running" });
      return { queued: true, ahead: 1 };
    });
    await useClaude.getState().ask("workspace", "quick", null);
    expect(statuses()).toEqual(["running"]);
  });

  it("removes only the queued turn, and cancel stops only the running one", async () => {
    useClaude.setState({
      byTicket: {
        workspace: {
          sessionId: "s1",
          turns: [
            { requestId: "r1", prompt: "a", steps: [], text: "", status: "running", error: null },
            { requestId: "r2", prompt: "b", steps: [], text: "", status: "queued", error: null },
            { requestId: "r3", prompt: "c", steps: [], text: "", status: "queued", error: null },
          ],
        },
      },
    });
    const cancelled: string[] = [];
    vi.spyOn(claude, "cancel").mockImplementation(async (id) => void cancelled.push(id));
    useClaude.getState().remove("r2");
    useClaude.getState().remove("r1");
    useClaude.getState().cancel("workspace");
    expect(cancelled).toEqual(["r2", "r1"]);
  });

  it("sends a queued question with the session known when it was sent", async () => {
    const sent: AskRequest[] = [];
    vi.spyOn(claude, "ask").mockImplementation(async (req) => (sent.push(req), { queued: true, ahead: 1 }));
    await useClaude.getState().ask("workspace", "later", null);
    await useClaude.getState().ask("workspace", "and later", "s-known");
    expect(sent.map((r) => r.sessionId)).toEqual([null, "s-known"]);
  });
});

describe("a reload while Pip answers", () => {
  beforeEach(() => useClaude.setState({ byTicket: {} }));
  afterEach(() => {
    vi.restoreAllMocks();
    forgetConversations();
  });

  const restored = (text: string, steps: string[] = []): Conversation => ({ sessionId: null, turns: [{ requestId: "r1", prompt: "q", steps, text, status: "running", error: null }] });
  const text = (t: string): ClaudeEvent => ({ type: "text", text: t });

  it("adds what came while the snapshot was read without repeating what it already had", () => {
    expect(catchUp(restored("Hello wor"), "r1", [text("wor"), text("ld"), text("!")]).turns[0].text).toBe("Hello world!");
    expect(catchUp(restored("Hello"), "r1", [text(" world")]).turns[0].text).toBe("Hello world");
    expect(catchUp(restored(""), "r1", [text("Hi")]).turns[0].text).toBe("Hi");
    const steps = catchUp(restored("", ["Looked up CA-1"]), "r1", [{ type: "tool", label: "Looked up CA-1" }, { type: "tool", label: "Listed the drafts" }]).turns[0].steps;
    expect(steps).toEqual(["Looked up CA-1", "Listed the drafts"]);
    const ended = catchUp(restored("Hi"), "r1", [{ type: "done", sessionId: "s1", ok: true, message: null }]);
    expect([ended.turns[0].status, ended.sessionId]).toEqual(["done", "s1"]);
  });

  it("holds the events of a turn the store doesn't have yet while it loads, and the stored answer settles it", async () => {
    let answer: (t: StoredTurn[]) => void = () => {};
    const turns = vi.spyOn(claude, "turns").mockReturnValueOnce(new Promise((r) => (answer = r)));
    const loading = useClaude.getState().load("workspace");
    // The page listens before it loads: these come while the snapshot is being read, and the first is in it.
    onClaudeEvent("r1", text("Two "));
    onClaudeEvent("r1", text("things."));
    onClaudeEvent("r1", { type: "done", sessionId: "s1", ok: true, message: null, usage });
    turns.mockResolvedValueOnce([stored("r1", { text: "Two things.", status: "done", sessionId: "s1", usage })]);
    answer([stored("r1", { text: "Two ", status: "running", sessionId: null, usage: null })]);
    await loading;
    const turn = () => useClaude.getState().byTicket.workspace.turns[0];
    expect(turn()).toMatchObject({ status: "done", text: "Two things." });
    await vi.waitFor(() => expect(turns).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(turn()).toMatchObject({ status: "done", text: "Two things.", usage }));
  });

  it("replaces a restored turn's answer with the stored one when it ends after the load", async () => {
    const turns = vi.spyOn(claude, "turns").mockResolvedValueOnce([stored("r1", { text: "Half", status: "running" })]);
    await useClaude.getState().load("workspace");
    // A chunk lost in a gap the snapshot couldn't cover: the stream alone would end garbled.
    onClaudeEvent("r1", text(" answer."));
    turns.mockResolvedValueOnce([stored("r1", { text: "Half of the answer.", status: "done" })]);
    onClaudeEvent("r1", { type: "done", sessionId: null, ok: true, message: null });
    await vi.waitFor(() => expect(useClaude.getState().byTicket.workspace.turns[0]).toMatchObject({ status: "done", text: "Half of the answer." }));
  });

  it("drops held events once no load is waiting, and never a turn's own events", async () => {
    onClaudeEvent("nowhere", text("lost"));
    vi.spyOn(claude, "turns").mockResolvedValueOnce([stored("nowhere", { text: "", status: "running" })]);
    await useClaude.getState().load("workspace");
    expect(useClaude.getState().byTicket.workspace.turns[0].text).toBe("");
  });
});
