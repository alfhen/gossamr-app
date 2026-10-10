import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERRUPTED, MOCK_TURN_DAYS, NEVER_RAN, freshStart, mockUsage, openMockPipTurns } from "./mockPipTurns";
import { mockAsk } from "./mockPip";
import type { ScreenContext } from "../types";

const KEY = "gossamr-mock-pip-turns";
const DAY = 24 * 60 * 60 * 1000;
const usage = mockUsage("q", "a");

/** A browser's storage for this file: kept across reopens of the store, as across reloads of one page. */
const saved = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
  removeItem: (k: string) => void saved.delete(k),
};
vi.stubGlobal("localStorage", localStorage);
afterAll(() => vi.unstubAllGlobals());

describe("the mock pip-turn store", () => {
  beforeEach(() => localStorage.removeItem(KEY));

  it("keeps a finished conversation across a reopen, as across a reload", () => {
    const first = openMockPipTurns();
    first.begin("general", "r1", "What changed?", { looking: "CA-401", imageCount: 1 });
    first.step("r1", "Looked up CA-401");
    first.text("r1", "Two ");
    first.text("r1", "things.");
    expect(first.turns("general")[0]).toMatchObject({ status: "running", text: "Two things.", steps: ["Looked up CA-401"] });
    first.finish("r1", { ok: true, error: null, sessionId: "s1", usage });
    first.begin("CA-1", "r2", "Elsewhere", { imageCount: 0 });

    const again = openMockPipTurns();
    expect(again.turns("general")).toEqual([
      expect.objectContaining({ requestId: "r1", prompt: "What changed?", looking: "CA-401", imageCount: 1, text: "Two things.", steps: ["Looked up CA-401"], status: "done", sessionId: "s1", usage }),
    ]);
    expect(again.turns("CA-1").map((t) => t.requestId)).toEqual(["r2"]);
  });

  const context: ScreenContext = { view: null, item: { connectionId: "mock", externalId: "CA-401", key: "CA-401" }, filter: null, selection: [] };

  it("fails turns that were still going when the app closed, and says which never ran", () => {
    const first = openMockPipTurns();
    first.begin("general", "r1", "q", { imageCount: 0 }, "running", new Date("2026-10-01T10:00:01Z"), { context, sessionId: null });
    first.text("r1", "half");
    first.begin("general", "r2", "q", { imageCount: 0 }, "queued", new Date("2026-10-01T10:00:02Z"), { context, sessionId: null });
    const again = openMockPipTurns(Date.now(), true);
    expect(again.turns("general").map((t) => [t.status, t.error, t.text])).toEqual([
      ["failed", INTERRUPTED, ""],
      ["failed", NEVER_RAN, ""],
    ]);
    expect(again.resume()).toEqual([]);
  });

  it("keeps turns going across a reload, to be asked again from the start in the order they were sent", () => {
    const first = openMockPipTurns();
    first.begin("general", "r2", "second", { imageCount: 0 }, "queued", new Date("2026-10-01T10:00:02Z"), { context, sessionId: "s1" });
    first.begin("general", "r1", "first", { looking: "CA-401", imageCount: 1 }, "running", new Date("2026-10-01T10:00:01Z"), { context, sessionId: null });
    first.step("r1", "Looked up CA-401");
    first.begin("general", "old", "no way to ask it again", { imageCount: 0 }, "running", new Date("2026-10-01T10:00:00Z"));
    const again = openMockPipTurns(Date.now(), false);
    expect(again.turns("general").map((t) => [t.requestId, t.status, t.error, t.steps])).toEqual([
      ["old", "failed", INTERRUPTED, []],
      ["r1", "queued", null, []],
      ["r2", "queued", null, []],
    ]);
    expect(again.turns("general")[1]).not.toHaveProperty("ask");
    const resumed = again.resume();
    expect(resumed.map((t) => [t.requestId, t.prompt, t.ask.sessionId, t.meta.looking])).toEqual([
      ["r1", "first", null, "CA-401"],
      ["r2", "second", "s1", undefined],
    ]);
    expect(resumed[0].ask.context).toEqual(context);
    expect(again.resume()).toEqual([]);
    again.text("r1", "whole answer");
    again.finish("r1", { ok: true, error: null, sessionId: "s1", usage });
    expect(openMockPipTurns(Date.now(), false).turns("general")[1]).toMatchObject({ status: "done", text: "whole answer" });
  });

  it("tells a reload from a fresh start by the tab's session storage", () => {
    expect(freshStart()).toBe(true);
    const tab = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => tab.get(k) ?? null, setItem: (k: string, v: string) => void tab.set(k, v) });
    try {
      expect(freshStart()).toBe(true);
      expect(freshStart()).toBe(false);
      tab.clear();
      expect(freshStart()).toBe(true);
    } finally {
      vi.stubGlobal("sessionStorage", undefined);
    }
  });

  it("forgets turns past the horizon when it opens", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    const store = openMockPipTurns(now);
    store.begin("general", "old", "q", { imageCount: 0 }, "running", new Date(now - (MOCK_TURN_DAYS + 1) * DAY));
    store.begin("general", "new", "q", { imageCount: 0 }, "running", new Date(now - (MOCK_TURN_DAYS - 1) * DAY));
    expect(openMockPipTurns(now).turns("general").map((t) => t.requestId)).toEqual(["new"]);
  });

  it("orders turns by when they were asked and clears everything", () => {
    const store = openMockPipTurns();
    store.begin("general", "b", "second", { imageCount: 0 }, "running", new Date("2026-10-01T10:00:02Z"));
    store.begin("general", "a", "first", { imageCount: 0 }, "running", new Date("2026-10-01T10:00:01Z"));
    expect(store.turns("general").map((t) => t.prompt)).toEqual(["first", "second"]);
    store.clear();
    expect(store.turns("general")).toEqual([]);
    expect(openMockPipTurns().turns("general")).toEqual([]);
  });

  it("adopts turns kept under the old 'workspace' name as General's, rewriting them once", () => {
    const old = (requestId: string, conversation: string) => ({ requestId, conversation, prompt: requestId, imageCount: 0, text: "a", steps: [], status: "done", error: null, sessionId: "s1", usage: null, createdAt: new Date().toISOString() });
    localStorage.setItem(KEY, JSON.stringify([old("w1", "workspace"), old("t1", "CA-1"), old("g1", "general")]));
    const store = openMockPipTurns();
    expect(store.turns("general").map((t) => t.requestId)).toEqual(["w1", "g1"]);
    expect(store.turns("workspace").map((t) => t.requestId)).toEqual(["w1", "g1"]);
    expect(store.conversationOf("w1")).toBe("general");
    expect(store.conversationOf("t1")).toBe("CA-1");
    expect(store.conversationOf("nope")).toBeNull();
    const kept = JSON.parse(localStorage.getItem(KEY)!) as { requestId: string; conversation: string }[];
    expect(kept.map((t) => [t.requestId, t.conversation])).toEqual([
      ["w1", "general"],
      ["t1", "CA-1"],
      ["g1", "general"],
    ]);
    store.begin("workspace", "w2", "asked under the old name", { imageCount: 0 });
    expect(store.conversationOf("w2")).toBe("general");
  });

  it("keeps a workstream's conversation apart from General", () => {
    const store = openMockPipTurns();
    store.begin("general", "g", "in general", { imageCount: 0 });
    store.begin("ws:ws-1", "w", "in the workstream", { imageCount: 0 });
    expect(store.turns("general").map((t) => t.requestId)).toEqual(["g"]);
    expect(store.turns("ws:ws-1").map((t) => t.requestId)).toEqual(["w"]);
    expect(openMockPipTurns().conversationOf("w")).toBe("ws:ws-1");
  });

  it("reads a broken or foreign value as empty", () => {
    localStorage.setItem(KEY, "{not json");
    expect(openMockPipTurns().turns("general")).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify([{ requestId: 1 }, "x"]));
    expect(openMockPipTurns().turns("general")).toEqual([]);
  });
});

describe("mockUsage", () => {
  it("is steady, grows with the text and has a small cost", () => {
    expect(mockUsage("hello", "world")).toEqual(mockUsage("hello", "world"));
    const short = mockUsage("q", "a");
    const long = mockUsage("q".repeat(400), "a".repeat(400));
    expect(long.inputTokens).toBeGreaterThan(short.inputTokens);
    expect(long.outputTokens).toBeGreaterThan(short.outputTokens);
    expect(long.costUsd).toBeGreaterThan(0);
    expect(long.costUsd).toBeLessThan(0.01);
  });
});

describe("mockAsk", () => {
  beforeEach(() => localStorage.removeItem(KEY));

  it("drafts what is asked in a workstream's conversation into that workstream", async () => {
    const { MockBackend } = await import("./mock");
    const { itemRef } = await import("./mockConnector");
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const ws = await backend.workstreamsOpen(itemRef("CA-401"));
    const context: ScreenContext = { view: null, item: itemRef("CA-401"), filter: null, selection: [] };
    await mockAsk({ requestId: "w1", prompt: "investigate this", sessionId: null, context, conversation: `ws:${ws.id}`, meta: { imageCount: 0 } }, backend, 0);
    const [draft] = backend.proposals.list({ workstream: ws.id });
    expect(draft.origin).toEqual({ type: "chat", requestId: "w1", workstream: ws.id });
    expect(draft.intent.type === "startRun" && draft.intent.spec.workstream).toBe(ws.id);
    await mockAsk({ requestId: "g1", prompt: "investigate this", sessionId: null, context, conversation: "general", meta: { imageCount: 0 } }, backend, 0);
    const general = backend.proposals.list().find((p) => p.origin.type === "chat" && p.origin.requestId === "g1");
    expect(general?.origin).toEqual({ type: "chat", requestId: "g1" });
  });

  it("drafts a plan run for 'plan CA-401' in that ticket's workstream, and nothing starts", async () => {
    const { MockBackend } = await import("./mock");
    const { itemRef } = await import("./mockConnector");
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const ws = await backend.workstreamsOpen(itemRef("CA-401"));
    const context: ScreenContext = { view: null, item: null, filter: null, selection: [] };
    await mockAsk({ requestId: "p1", prompt: "plan CA-401", sessionId: null, context, conversation: `ws:${ws.id}`, meta: { imageCount: 0 } }, backend, 0);
    const [draft] = backend.proposals.list({ workstream: ws.id });
    expect(draft.state.type).toBe("pending");
    expect(draft.intent.type === "startRun" && draft.intent.spec.kind).toBe("plan");
    expect(draft.intent.type === "startRun" && draft.intent.item?.key).toBe("CA-401");
    expect(backend.runs.list()).toHaveLength(0);
    // Another ticket's key isn't this workstream's next step.
    await mockAsk({ requestId: "p2", prompt: "plan CA-402", sessionId: null, context, conversation: `ws:${ws.id}`, meta: { imageCount: 0 } }, backend, 0);
    expect(backend.proposals.list({ workstream: ws.id }).filter((p) => p.origin.type === "chat" && p.origin.requestId === "p2" && p.intent.type === "startRun")).toHaveLength(0);
  });

  it("answers 'Why is this held?' from the workstream's held reason, and 'Approve the plan' with where to approve it", async () => {
    const { MockBackend } = await import("./mock");
    const { itemRef } = await import("./mockConnector");
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const ws = await backend.workstreamsOpen(itemRef("CA-401"));
    const context: ScreenContext = { view: null, item: null, filter: null, selection: [] };
    const answer = async (requestId: string, prompt: string) => {
      await mockAsk({ requestId, prompt, sessionId: null, context, conversation: `ws:${ws.id}`, meta: { imageCount: 0 } }, backend, 0);
      return openMockPipTurns().turns(`ws:${ws.id}`).find((t) => t.requestId === requestId)?.text ?? "";
    };
    const drafts = backend.proposals.list().length;
    expect(await answer("h0", "Why is this held?")).toContain("isn't held");
    await backend.workstreamsHold(ws.id);
    expect(await answer("h1", "Why is this held?")).toMatch(/^Held by you\. While it is held I'm not woken and nothing starts on its own/);
    const plan = await answer("a1", "Approve the plan");
    expect(plan).toContain("I can't approve anything myself");
    expect(plan).toContain("Plan step");
    expect(plan).toContain("CA-401's peek");
    expect(backend.proposals.list()).toHaveLength(drafts);
  });

  it("answers 'What is waiting to start?' with where the run draft is read and started, and on Pip home speaks of Pip home, not a board", async () => {
    const { MockBackend } = await import("./mock");
    const { itemRef } = await import("./mockConnector");
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const ws = await backend.workstreamsOpen(itemRef("CA-401"));
    const answer = async (requestId: string, prompt: string, conversation: string, context: ScreenContext) => {
      await mockAsk({ requestId, prompt, sessionId: null, context, conversation, meta: { imageCount: 0 } }, backend, 0);
      return openMockPipTurns().turns(conversation).find((t) => t.requestId === requestId)?.text ?? "";
    };
    const home: ScreenContext = { view: "Pip home", item: null, filter: null, selection: [] };
    const waiting = await answer("wait-1", "What is waiting to start?", `ws:${ws.id}`, home);
    expect(waiting).toContain("Review and start");
    expect(waiting).toContain("can't start it myself");
    expect(backend.runs.list()).toHaveLength(0);
    const general = await answer("home-1", "Catch me up", "general", home);
    expect(general).toMatch(/^You're on Pip home\./);
    expect(general).not.toMatch(/stale|blocked/);
    // A filter asked for there lands on the workspace tab, and says so.
    expect(await answer("home-2", "Show stale tickets", "general", home)).toContain("I filtered your workspace tab");
  });

  it("records the turn with its usage and tells the page the same usage", async () => {
    const context: ScreenContext = { view: null, item: null, filter: null, selection: [] };
    const events: unknown[] = [];
    const { mockPipEvents } = await import("./mockPip");
    const off = mockPipEvents.on((id, e) => id === "m1" && events.push(e));
    try {
      await mockAsk({ requestId: "m1", prompt: "hello there", sessionId: null, context, conversation: "general", meta: { looking: "the board", imageCount: 0 } }, null, 0);
    } finally {
      off();
    }
    const kept = openMockPipTurns().turns("general").find((t) => t.requestId === "m1");
    expect(kept).toMatchObject({ status: "done", looking: "the board", sessionId: "mock-session-m1" });
    expect(kept?.text.length).toBeGreaterThan(0);
    expect(kept?.usage).toEqual(mockUsage("hello there", kept!.text));
    expect(events[events.length - 1]).toMatchObject({ type: "done", ok: true, usage: kept?.usage });
  });
});
