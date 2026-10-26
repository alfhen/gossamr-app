import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Intent } from "../types";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import { UNSKIP_WINDOW_MS } from "./mockProposals";
import { docFromText } from "../lib/docs";

const saved = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
  removeItem: (k: string) => void saved.delete(k),
});
afterAll(() => vi.unstubAllGlobals());

const CA401 = itemRef("CA-401");
const comment: Intent = { type: "comment", item: CA401, body: docFromText("Hi") };
const lines = (backend: MockBackend, id: string) => backend.workstreamsEvents(id).then((events) => events.map((e) => [e.actor, e.action, e.detail ?? null]));

beforeEach(() => saved.clear());
afterEach(() => vi.useRealTimers());

describe("taking a skip back (the mock of unskip)", () => {
  it("puts a skipped draft back to pending exactly as it was, and says so in its workstream's audit", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const ws = await backend.workstreamsOpen(CA401);
    const p = backend.proposals.draft(comment, null, "r1", ws.id);
    const skipped = await backend.proposalsSkip(p.id);
    expect(skipped.state.type).toBe("skipped");
    const back = await backend.proposalsUnskip(p.id);
    expect({ ...back, updatedAt: p.updatedAt }).toEqual({ ...p, updatedAt: p.updatedAt });
    expect((await backend.proposalsGet(p.id))?.state.type).toBe("pending");
    expect(await lines(backend, ws.id)).toEqual([
      ["person", "opened", null],
      ["pip", "draft_created", null],
      ["person", "draft_skipped", null],
      ["person", "undone", "draft_skipped"],
    ]);
    // Pending again, it can be edited and approved like any pending draft.
    expect((await backend.proposalsApprove(p.id)).state.type).toBe("applied");
  });

  it("leaves a pending draft alone, and writes no line for it", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const ws = await backend.workstreamsOpen(CA401);
    const p = backend.proposals.draft(comment, null, "r1", ws.id);
    expect((await backend.proposalsUnskip(p.id)).state.type).toBe("pending");
    expect((await lines(backend, ws.id)).some(([, action]) => action === "undone")).toBe(false);
  });

  it("refuses an applied draft, a retired one and one that is gone", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const applied = await backend.proposalsApprove(backend.proposals.draft(comment).id);
    await expect(backend.proposalsUnskip(applied.id)).rejects.toThrow(/only a skipped draft/);
    const retired = backend.proposals.draft(comment);
    backend.proposals.retire(retired.id, "out of date");
    await expect(backend.proposalsUnskip(retired.id)).rejects.toThrow(/only a skipped draft/);
    await expect(backend.proposalsUnskip("nope")).rejects.toThrow(/no longer exists/);
  });

  it("brings a skip back only within the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T09:00:00Z"));
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const p = backend.proposals.draft(comment);
    await backend.proposalsSkip(p.id);
    vi.setSystemTime(Date.now() + UNSKIP_WINDOW_MS);
    expect((await backend.proposalsUnskip(p.id)).state.type).toBe("pending");
    await backend.proposalsSkip(p.id);
    vi.setSystemTime(Date.now() + UNSKIP_WINDOW_MS + 1);
    await expect(backend.proposalsUnskip(p.id)).rejects.toThrow(/too long ago/);
    expect((await backend.proposalsGet(p.id))?.state.type).toBe("skipped");
  });
});
