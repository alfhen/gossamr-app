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
    first.begin("workspace", "r1", "What changed?", { looking: "CA-401", imageCount: 1 });
    first.step("r1", "Looked up CA-401");
    first.text("r1", "Two ");
    first.text("r1", "things.");
    expect(first.turns("workspace")[0]).toMatchObject({ status: "running", text: "Two things.", steps: ["Looked up CA-401"] });
    first.finish("r1", { ok: true, error: null, sessionId: "s1", usage });
    first.begin("CA-1", "r2", "Elsewhere", { imageCount: 0 });

    const again = openMockPipTurns();
    expect(again.turns("workspace")).toEqual([
      expect.objectContaining({ requestId: "r1", prompt: "What changed?", looking: "CA-401", imageCount: 1, text: "Two things.", steps: ["Looked up CA-401"], status: "done", sessionId: "s1", usage }),
    ]);
    expect(again.turns("CA-1").map((t) => t.requestId)).toEqual(["r2"]);
  });

  const context: ScreenContext = { view: null, item: { connectionId: "mock", externalId: "CA-401", key: "CA-401" }, filter: null, selection: [] };

  it("fails turns that were still going when the app closed, and says which never ran", () => {
    const first = openMockPipTurns();
    first.begin("workspace", "r1", "q", { imageCount: 0 }, "running", new Date("2026-10-01T10:00:01Z"), { context, sessionId: null });
    first.text("r1", "half");
    first.begin("workspace", "r2", "q", { imageCount: 0 }, "queued", new Date("2026-10-01T10:00:02Z"), { context, sessionId: null });
    const again = openMockPipTurns(Date.now(), true);
    expect(again.turns("workspace").map((t) => [t.status, t.error, t.text])).toEqual([
      ["failed", INTERRUPTED, ""],
      ["failed", NEVER_RAN, ""],
    ]);
    expect(again.resume()).toEqual([]);
  });

  it("keeps turns going across a reload, to be asked again from the start in the order they were sent", () => {
    const first = openMockPipTurns();
    first.begin("workspace", "r2", "second", { imageCount: 0 }, "queued", new Date("2026-10-01T10:00:02Z"), { context, sessionId: "s1" });
    first.begin("workspace", "r1", "first", { looking: "CA-401", imageCount: 1 }, "running", new Date("2026-10-01T10:00:01Z"), { context, sessionId: null });
    first.step("r1", "Looked up CA-401");
    first.begin("workspace", "old", "no way to ask it again", { imageCount: 0 }, "running", new Date("2026-10-01T10:00:00Z"));
    const again = openMockPipTurns(Date.now(), false);
    expect(again.turns("workspace").map((t) => [t.requestId, t.status, t.error, t.steps])).toEqual([
      ["old", "failed", INTERRUPTED, []],
      ["r1", "queued", null, []],
      ["r2", "queued", null, []],
    ]);
    expect(again.turns("workspace")[1]).not.toHaveProperty("ask");
    const resumed = again.resume();
    expect(resumed.map((t) => [t.requestId, t.prompt, t.ask.sessionId, t.meta.looking])).toEqual([
      ["r1", "first", null, "CA-401"],
      ["r2", "second", "s1", undefined],
    ]);
    expect(resumed[0].ask.context).toEqual(context);
    expect(again.resume()).toEqual([]);
    again.text("r1", "whole answer");
    again.finish("r1", { ok: true, error: null, sessionId: "s1", usage });
    expect(openMockPipTurns(Date.now(), false).turns("workspace")[1]).toMatchObject({ status: "done", text: "whole answer" });
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
    store.begin("workspace", "old", "q", { imageCount: 0 }, "running", new Date(now - (MOCK_TURN_DAYS + 1) * DAY));
    store.begin("workspace", "new", "q", { imageCount: 0 }, "running", new Date(now - (MOCK_TURN_DAYS - 1) * DAY));
    expect(openMockPipTurns(now).turns("workspace").map((t) => t.requestId)).toEqual(["new"]);
  });

  it("orders turns by when they were asked and clears everything", () => {
    const store = openMockPipTurns();
    store.begin("workspace", "b", "second", { imageCount: 0 }, "running", new Date("2026-10-01T10:00:02Z"));
    store.begin("workspace", "a", "first", { imageCount: 0 }, "running", new Date("2026-10-01T10:00:01Z"));
    expect(store.turns("workspace").map((t) => t.prompt)).toEqual(["first", "second"]);
    store.clear();
    expect(store.turns("workspace")).toEqual([]);
    expect(openMockPipTurns().turns("workspace")).toEqual([]);
  });

  it("reads a broken or foreign value as empty", () => {
    localStorage.setItem(KEY, "{not json");
    expect(openMockPipTurns().turns("workspace")).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify([{ requestId: 1 }, "x"]));
    expect(openMockPipTurns().turns("workspace")).toEqual([]);
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

  it("records the turn with its usage and tells the page the same usage", async () => {
    const context: ScreenContext = { view: null, item: null, filter: null, selection: [] };
    const events: unknown[] = [];
    const { mockPipEvents } = await import("./mockPip");
    const off = mockPipEvents.on((id, e) => id === "m1" && events.push(e));
    try {
      await mockAsk({ requestId: "m1", prompt: "hello there", sessionId: null, context, conversation: "workspace", meta: { looking: "the board", imageCount: 0 } }, null, 0);
    } finally {
      off();
    }
    const kept = openMockPipTurns().turns("workspace").find((t) => t.requestId === "m1");
    expect(kept).toMatchObject({ status: "done", looking: "the board", sessionId: "mock-session-m1" });
    expect(kept?.text.length).toBeGreaterThan(0);
    expect(kept?.usage).toEqual(mockUsage("hello there", kept!.text));
    expect(events[events.length - 1]).toMatchObject({ type: "done", ok: true, usage: kept?.usage });
  });
});
