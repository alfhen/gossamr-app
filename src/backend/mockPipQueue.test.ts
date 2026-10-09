import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cases from "../../src-tauri/test-support/pip-queue-cases.json";
import type { ClaudeEvent } from "./claude";
import { mockPipEvents } from "./mockPip";
import { PIP_PROCESSES, createTurnQueue, mockQueueAsk, mockQueueCancel, resetMockPipQueue } from "./mockPipQueue";
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
});
