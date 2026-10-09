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

describe("drafts an agent run left", () => {
  afterEach(() => vi.unstubAllGlobals());

  const fromRun = (proposals: MockProposals, workstream: string | null) => proposals.fromRun(comment, "From agent run", { type: "run", runId: "r1", shortId: null, workstream });
  const textOf = (intent: Intent) => (intent.type === "comment" ? docText(intent.body) : "");

  it("are the agent's, listed under their run's workstream, and Pip revises them only from that workstream", () => {
    const proposals = new MockProposals(async () => []);
    const inWs = fromRun(proposals, "ws-1");
    const loose = fromRun(proposals, null);
    expect(inWs.createdBy).toBe("agent");
    expect(proposals.list({ workstream: "ws-1" }).map((p) => p.id)).toEqual([inWs.id]);

    expect(() => proposals.pipRevise(inWs.id, "Elsewhere", "ws-2")).toThrow(/belongs to another workstream/);
    expect(() => proposals.pipRevise(inWs.id, "From General")).toThrow(/belongs to another workstream/);
    expect(textOf(proposals.pipRevise(inWs.id, "Same workstream", "ws-1").intent)).toBe("Same workstream");
    expect(textOf(proposals.pipRevise(loose.id, "Anywhere", "ws-1").intent)).toBe("Anywhere");
    expect(() => proposals.pipRevise(proposals.draft(comment).id, "x", "ws-1")).not.toThrow();
  });

  it("stays the person's once they edit a description an agent left", async () => {
    const proposals = new MockProposals(async () => []);
    const body = (text: string) => ({ blocks: [{ type: "paragraph" as const, content: [{ type: "text" as const, text, marks: [] }] }] });
    const rewrite: Intent = { type: "rewrite", item: ref, title: null, body: { from: body("old"), to: body("new"), fromText: "old", toText: "new" }, flattened: [] };
    const left = proposals.fromRun(rewrite, "From agent run", { type: "run", runId: "r1", shortId: null, workstream: "ws-1" });
    await proposals.edit(left.id, { type: "rewrite", body: "mine" });
    expect(() => proposals.pipRevise(left.id, { description: "Pip's" }, "ws-1")).toThrow(/edited this description draft/);
  });

  it("stay the person's once they edit any of them, while Pip's own edited draft stays Pip's to revise", async () => {
    const proposals = new MockProposals(async () => []);
    const left = fromRun(proposals, "ws-1");
    await proposals.edit(left.id, { type: "comment", body: "Mine", mentions: [] });
    expect(() => proposals.pipRevise(left.id, "Pip's", "ws-1")).toThrow(/the user edited this draft/);
    const subtasks = proposals.fromRun({ type: "subtasks", parent: ref, summaries: ["a"] }, "From agent run", { type: "run", runId: "r1", shortId: null, workstream: "ws-1" });
    await proposals.edit(subtasks.id, { type: "subtasks", summaries: ["mine"] });
    expect(() => proposals.pipRevise(subtasks.id, { summaries: ["Pip's"] }, "ws-1")).toThrow(/the user edited this draft/);
    const own = proposals.draft(comment);
    await proposals.edit(own.id, { type: "comment", body: "Mine", mentions: [] });
    expect(textOf(proposals.pipRevise(own.id, "Pip's").intent)).toBe("Pip's");
  });

  it("keep a run draft stored as the user's before agents had their own maker revisable from any conversation", () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) });
    const first = new MockProposals(async () => []);
    first.keep("kept", () => true);
    const legacy = fromRun(first, null);
    const raw = JSON.parse([...saved.values()][0]) as Array<Record<string, unknown>>;
    saved.set([...saved.keys()][0], JSON.stringify(raw.map((p) => ({ ...p, createdBy: "user", origin: { type: "run", runId: "r1", shortId: null } }))));

    const again = new MockProposals(async () => []);
    again.keep("kept", () => true);
    const [back] = again.list();
    expect(back).toMatchObject({ createdBy: "user", origin: { type: "run", runId: "r1" } });
    expect(textOf(again.pipRevise(back.id, "Reworded", "ws-1").intent)).toBe("Reworded");
    expect(legacy.createdBy).toBe("agent");
  });
});
