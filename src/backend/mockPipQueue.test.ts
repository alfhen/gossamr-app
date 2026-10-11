import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cases from "../../src-tauri/test-support/pip-queue-cases.json";
import type { ClaudeEvent } from "./claude";
import { mockPipEvents } from "./mockPip";
import { PIP_PROCESSES, createTurnQueue, mockCancelTurns, mockHasWaitingWake, mockQueueAsk, mockQueueCancel, mockQueueWake, resetMockPipQueue } from "./mockPipQueue";
import type { EventMeta } from "./claude";
import type { WakeFact } from "./mockSupervisor";
import { mockPipTurns } from "./mockPipTurns";

type Step =
  | { op: "enqueue"; id: string; conversation: string; session?: string | null; expect: "start" | { waiting: number } }
  | { op: "finish"; id: string; session: string | null; ok?: boolean; started: { id: string; session: string | null }[] }
  | { op: "remove"; id: string; expect: "waiting" | "inFlight" | "unknown" }
  | { op: "position"; id: string; expect: number | null };

interface Case {
  name: string;
  steps: Step[];
  statuses: Record<string, string>;
}

describe("the shared queue cases (src-tauri/test-support/pip-queue-cases.json)", () => {
  it.each((cases as unknown as Case[]).map((c) => [c.name, c] as const))("%s", (_, c) => {
    const q = createTurnQueue<{ id: string; session: string | null }>();
    const statuses: Record<string, string> = {};
    const conversations = new Map<string, string>();
    c.steps.forEach((step, n) => {
      const at = `${c.name} (step ${n})`;
      switch (step.op) {
        case "enqueue": {
          conversations.set(step.id, step.conversation);
          const got = q.enqueue(step.conversation, step.id, { id: step.id, session: step.session ?? null });
          expect(got.start ? "start" : { waiting: got.ahead }, at).toEqual(step.expect);
          statuses[step.id] = got.start ? "running" : "queued";
          break;
        }
        case "finish": {
          const wasRunning = q.position(step.id) === 0 && statuses[step.id] === "running";
          const got = q.finished(step.id, step.session).map(([id, item]) => {
            expect(item.id, at).toBe(id);
            return { id, session: item.session ?? q.session(conversations.get(id)!) };
          });
          if (wasRunning) statuses[step.id] = step.ok === false ? "failed" : "done";
          for (const s of got) statuses[s.id] = "running";
          expect(got, at).toEqual(step.started);
          break;
        }
        case "remove": {
          const got = q.remove(step.id);
          if (got.type === "waiting") statuses[step.id] = "removed";
          expect(got.type, at).toBe(step.expect);
          break;
        }
        case "position":
          expect(q.position(step.id), at).toBe(step.expect);
          break;
      }
      expect(q.running(), at).toBeLessThanOrEqual(PIP_PROCESSES);
    });
    expect(statuses).toEqual(c.statuses);
  });

  it("puts a person's message ahead of anything that gives way to one", () => {
    const q = createTurnQueue<{ id: string; wake: boolean }>(PIP_PROCESSES, (i) => i.wake);
    q.enqueue("A", "a1", { id: "a1", wake: false });
    expect(q.enqueue("A", "w1", { id: "w1", wake: true })).toEqual({ start: false, ahead: 1 });
    expect(q.enqueue("A", "a2", { id: "a2", wake: false })).toEqual({ start: false, ahead: 1 });
    expect(q.finished("a1", null).map(([id]) => id)).toEqual(["a2"]);
    expect(q.finished("a2", null).map(([id]) => id)).toEqual(["w1"]);
  });
});

describe("the scripted Pip's queue", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  };
  const context = { view: null, item: null, filter: null, selection: [] };
  const seen: [string, ClaudeEvent][] = [];
  let off = () => {};

  beforeEach(() => {
    vi.stubGlobal("localStorage", memory());
    mockPipTurns.clear();
    resetMockPipQueue();
    seen.length = 0;
    off = mockPipEvents.on((id, e) => void seen.push([id, e]));
  });
  afterEach(() => {
    off();
    vi.unstubAllGlobals();
  });

  const ask = (requestId: string, conversation = "general") =>
    mockQueueAsk({ requestId, prompt: "What am I looking at?", sessionId: null, context, conversation, meta: { imageCount: 0 } }, null, 1);
  const eventsOf = (id: string) => seen.filter(([r]) => r === id).map(([, e]) => e.type);
  const statusOf = (id: string, conversation = "general") => mockPipTurns.turns(conversation).find((t) => t.requestId === id)?.status;
  const settled = (id: string, conversation = "general") => vi.waitFor(() => expect(["done", "failed"]).toContain(statusOf(id, conversation)), { timeout: 3000 });

  it("runs a second question after the first, in the same session", async () => {
    expect(ask("q1")).toEqual({ queued: false, ahead: 0 });
    expect(ask("q2")).toEqual({ queued: true, ahead: 1 });
    expect(statusOf("q2")).toBe("queued");
    expect(eventsOf("q2")).toEqual(["queued"]);
    await settled("q2");
    expect(eventsOf("q1")[0]).toBe("running");
    expect(eventsOf("q2").slice(0, 3)).toEqual(["queued", "running", "started"]);
    const doneAt = (id: string) => seen.findIndex(([r, e]) => r === id && e.type === "done");
    expect(doneAt("q1")).toBeLessThan(seen.findIndex(([r, e]) => r === "q2" && e.type === "running"));
    const turns = mockPipTurns.turns("general");
    expect(turns.map((t) => [t.requestId, t.status])).toEqual([["q1", "done"], ["q2", "done"]]);
    expect(turns[1].sessionId).toBe(turns[0].sessionId);
  });

  it("removes a waiting question before it runs, and stopping the running one starts the next", async () => {
    ask("q1");
    ask("q2");
    ask("q3");
    mockQueueCancel("q2");
    expect(statusOf("q2")).toBe("failed");
    expect(mockPipTurns.turns("general").find((t) => t.requestId === "q2")?.error).toBe("Removed before it started");
    mockQueueCancel("q1");
    await settled("q3");
    expect(statusOf("q1")).toBe("failed");
    expect(statusOf("q3")).toBe("done");
    expect(eventsOf("q2")).toEqual(["queued", "done"]);
  });

  it("never runs more than two at once across conversations", async () => {
    let now = 0;
    let most = 0;
    const offCount = mockPipEvents.on((_, e) => {
      if (e.type === "running") most = Math.max(most, ++now);
      if (e.type === "done") now--;
    });
    const outcomes = ["A", "B", "C", "D"].map((c) => ask(`${c}1`, c).queued);
    expect(outcomes).toEqual([false, false, true, true]);
    for (const c of ["A", "B", "C", "D"]) await settled(`${c}1`, c);
    offCount();
    expect(most).toBe(2);
  });

  describe("wakes", () => {
    const fact = (run: string): WakeFact => ({ run, kind: "triage", state: "done" });
    const metas: [string, EventMeta | undefined][] = [];
    let offMeta = () => {};
    beforeEach(() => {
      metas.length = 0;
      offMeta = mockPipEvents.on((id, _, meta) => void metas.push([id, meta]));
    });
    afterEach(() => offMeta());
    const turnOf = (id: string) => mockPipTurns.turns("ws:w1").find((t) => t.requestId === id);
    const wrote: string[] = [];
    const drafter = { pipPersonWrote: (id: string) => void wrote.push(id) };

    it("keeps a wake as its own kind, with the event lines as its prompt, and says where its events belong", async () => {
      const id = mockQueueWake("w1", [fact("abc12")], null, 1);
      expect(turnOf(id)).toMatchObject({ kind: "wake", prompt: "[Event] run abc12 (triage) Done" });
      await settled(id, "ws:w1");
      expect(turnOf(id)?.status).toBe("done");
      expect(metas.filter(([r]) => r === id).every(([, m]) => m?.kind === "wake" && m.conversation === "ws:w1" && m.prompt === "[Event] run abc12 (triage) Done")).toBe(true);
      expect(turnOf(id)?.text.split("\n").filter(Boolean).length).toBeLessThanOrEqual(3);
    });

    it("merges wakes that come while one waits into it, so a conversation has one waiting", async () => {
      ask("q1", "ws:w1");
      const first = mockQueueWake("w1", [fact("r1")], null, 1);
      expect(mockHasWaitingWake("ws:w1")).toBe(true);
      expect(mockQueueWake("w1", [fact("r2"), fact("r1")], null, 1)).toBe(first);
      expect(turnOf(first)?.prompt).toBe("[Event] run r1 (triage) Done\n[Event] run r2 (triage) Done");
      expect(mockPipTurns.turns("ws:w1").filter((t) => t.kind === "wake")).toHaveLength(1);
      await settled(first, "ws:w1");
    });

    it("gives way to the person: a waiting wake is taken out, a running one is set aside and queued again behind the message", async () => {
      wrote.length = 0;
      const running = mockQueueWake("w1", [fact("r1")], null, 50);
      ask("q0", "ws:w2");
      const waiting = mockQueueWake("w2", [fact("r2")], null, 1);
      mockQueueAsk({ requestId: "q1", prompt: "And now?", sessionId: null, context, conversation: "ws:w1", meta: { imageCount: 0 } }, drafter, 1);
      mockQueueAsk({ requestId: "q2", prompt: "Wait", sessionId: null, context, conversation: "ws:w2", meta: { imageCount: 0 } }, drafter, 1);
      expect(mockPipTurns.turns("ws:w2").find((t) => t.requestId === waiting)).toMatchObject({ status: "failed", error: "Removed before it started" });
      expect(wrote).toEqual(["w1", "w2"]);
      await settled("q1", "ws:w1");
      expect(turnOf(running)).toMatchObject({ status: "failed", error: "Stopped" });
      const again = mockPipTurns.turns("ws:w1").filter((t) => t.kind === "wake" && t.requestId !== running);
      expect(again.map((t) => t.prompt)).toEqual(["[Event] run r1 (triage) Done"]);
      await settled(again[0].requestId, "ws:w1");
      const order = mockPipTurns.turns("ws:w1").map((t) => [t.requestId === running ? "wake" : t.requestId === "q1" ? "q1" : "again", t.status]);
      expect(order).toEqual([["wake", "failed"], ["q1", "done"], ["again", "done"]]);
      await settled("q2", "ws:w2");
    });

    it("stops every turn of a held workstream's conversation and leaves the others", async () => {
      const a = mockQueueWake("w1", [fact("r1")], null, 50);
      ask("q1", "ws:w1");
      ask("g1");
      mockCancelTurns((c) => c === "ws:w1");
      expect(statusOf("q1", "ws:w1")).toBe("failed");
      await settled(a, "ws:w1");
      expect(turnOf(a)?.status).toBe("failed");
      await settled("g1");
      expect(statusOf("g1")).toBe("done");
    });
  });
});

describe("the queue across conversations", () => {
  it("starts a person's turn in another conversation before an older wake, as the app's queue does", () => {
    const q = createTurnQueue<{ id: string; wake: boolean }>(1, (item) => item.wake);
    q.enqueue("A", "a1", { id: "a1", wake: false });
    q.enqueue("ws:1", "w1", { id: "w1", wake: true });
    q.enqueue("general", "g1", { id: "g1", wake: false });
    expect(q.finished("a1", null).map(([id]) => id)).toEqual(["g1"]);
    expect(q.finished("g1", null).map(([id]) => id)).toEqual(["w1"]);
  });
});
