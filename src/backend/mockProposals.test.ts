import { afterEach, describe, expect, it, vi } from "vitest";
import { docText } from "../lib/docs";
import type { Intent } from "../types";
import { MockBackend } from "./mock";
import { MockProposals } from "./mockProposals";

const ref = { connectionId: "mock", externalId: "CA-412", key: "CA-412" };
const comment: Intent = { type: "comment", item: ref, body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "Hi", marks: [] }] }] } };

describe("mock proposals", () => {
  it("edits, approves once and refuses a second approval", async () => {
    const backend = new MockBackend();
    const p = backend.proposals.draft(comment);
    const edited = await backend.proposalsEdit(p.id, { type: "comment", body: "Hello\n\nthere", mentions: [] });
    expect(edited.intent.type === "comment" && docText(edited.intent.body)).toBe("Hello\n\nthere");

    const before = (await backend.load()).tickets["CA-412"].comments.length;
    const done = await backend.proposalsApprove(p.id);
    expect(done.state.type).toBe("applied");
    expect((await backend.load()).tickets["CA-412"].comments.length).toBe(before + 1);
    await expect(backend.proposalsApprove(p.id)).rejects.toThrow(/applied/);
  });

  it("lists by state and item", async () => {
    const backend = new MockBackend();
    const a = backend.proposals.draft(comment);
    const b = backend.proposals.draft({ type: "subtasks", parent: { ...ref, externalId: "CA-1", key: "CA-1" }, summaries: ["x"] });
    await backend.proposalsSkip(a.id);
    expect((await backend.proposalsList({ states: ["pending"] })).map((p) => p.id)).toEqual([b.id]);
    expect((await backend.proposalsList({ item: ref })).map((p) => p.id)).toEqual([a.id]);
    expect(await backend.proposalsGet("nope")).toBeNull();
  });

  it("refuses to skip an applied draft but skipping twice is harmless", async () => {
    const backend = new MockBackend();
    const done = await backend.proposalsApprove(backend.proposals.draft(comment).id);
    await expect(backend.proposalsSkip(done.id)).rejects.toThrow(/applied/);
    const p = backend.proposals.draft(comment);
    await backend.proposalsSkip(p.id);
    expect((await backend.proposalsSkip(p.id)).state.type).toBe("skipped");
  });

  it("creates only the subtasks not yet made when retried", async () => {
    const backend = new MockBackend();
    const p = backend.proposals.draft({ type: "subtasks", parent: ref, summaries: ["a", "b"] });
    const done = await backend.proposalsApprove(p.id);
    expect(done.created).toHaveLength(2);
    expect((await backend.load()).tickets["CA-412"].subtasks.filter((s) => ["a", "b"].includes(s.summary))).toHaveLength(2);
  });

  it("stores a hand-made draft as pending by the user without applying it", async () => {
    const backend = new MockBackend();
    const to = { type: "transition", item: ref, to: "ca-copy" } as const;
    const before = (await backend.cacheItem(ref))?.status.name;
    const p = await backend.proposalsCreate(to, "Copy");
    expect(p).toMatchObject({ createdBy: "user", origin: { type: "board" }, state: { type: "pending" }, label: "Copy", intent: to });
    expect((await backend.proposalsList({ item: ref })).map((d) => d.id)).toEqual([p.id]);
    expect((await backend.cacheItem(ref))?.status.name).toBe(before);
    await expect(backend.proposalsCreate({ ...to, to: "" })).rejects.toThrow(/target status/);
  });
});

describe("drafts kept across a reload", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("come back with the conversation that made them, under ids the new store hasn't given out", () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) });
    const fromChat = (p: { origin: { type: string; requestId?: string } }) => p.origin.type === "chat" && p.origin.requestId !== "gone";
    const first = new MockProposals(async () => []);
    first.keep("kept", fromChat);
    const asked = first.draft(comment, null, "r1");
    first.draft(comment, null, "gone");
    void first.create(comment);
    void first.skip(asked.id);

    const again = new MockProposals(async () => []);
    const seeded = again.draft(comment, null, "sample");
    again.keep("kept", fromChat);
    const back = again.list();
    expect(back.map((p) => [p.origin, p.state.type])).toEqual([
      [{ type: "chat", requestId: "r1" }, "skipped"],
      [{ type: "chat", requestId: "sample" }, "pending"],
    ]);
    expect(new Set(back.map((p) => p.id)).size).toBe(2);
    expect(back[0].id).not.toBe(seeded.id);
    expect(again.draft(comment, null, "r2").id).not.toBe(back[0].id);
  });
});
