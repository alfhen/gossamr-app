import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { docText } from "../lib/docs";
import type { Intent, ScreenContext } from "../types";
import type { AskRequest } from "./claude";
import { mockAsk, mockPipEvents } from "./mockPip";
import { mockPipTurns } from "./mockPipTurns";
import { PLAN_IS_THE_USERS, REPLACED_REASON, REVIEW_EDIT_KEEPS_POSITIONS, WORKSTREAM_PENDING_CAP } from "../lib/proposals";
import { MockBackend } from "./mock";
import { MockProposals } from "./mockProposals";
import { bodyChange } from "./mockMarkdown";
import { itemRef, statusId } from "./mockConnector";

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

describe("mock draft hygiene, as proposals.rs keeps it", () => {
  const item = (key: string) => ({ connectionId: "mock", externalId: key, key });
  const move = (key: string, to: string): Intent => ({ type: "transition", item: item(key), to });
  const note = (text: string): Intent => ({ type: "comment", item: item("CA-1"), body: { blocks: [{ type: "paragraph", content: [{ type: "text", text, marks: [] }] }] } });
  const store = () => {
    const lines: [string, string, string, string | undefined][] = [];
    const proposals = new MockProposals(async () => []);
    proposals.audit = (p, actor, action, detail) => void lines.push([p.id, actor, action, detail]);
    return { proposals, lines };
  };
  const runOrigin = (workstream: string) => ({ type: "run" as const, runId: "r1", shortId: null, workstream });

  it("a newer Pip move of the same ticket in the workstream retires the older one, and says so in the audit", () => {
    const { proposals, lines } = store();
    const old = proposals.draft(move("CA-1", "ca-copy"), "Copy", "q1", "ws-1");
    const other = proposals.draft(move("CA-2", "ca-copy"), "Copy", "q1", "ws-1");
    const elsewhere = proposals.draft(move("CA-1", "ca-copy"), "Copy", "q1", "ws-2");
    const comment = proposals.draft(note("one"), null, "q1", "ws-1");
    const byHand = proposals.draft(move("CA-1", "ca-qa"), "QA", "q0");
    const next = proposals.draft(move("CA-1", "ca-qa"), "QA", "q2", "ws-1");
    proposals.draft(note("two"), null, "q2", "ws-1");
    const back = proposals.get(old.id)!;
    expect(back.state).toEqual({ type: "retired", reason: "Replaced by a newer draft" });
    expect(back.supersededBy).toBe(next.id);
    expect(lines).toContainEqual([old.id, "pip", "draft_superseded", next.id]);
    for (const p of [other, elsewhere, comment, byHand]) expect(proposals.get(p.id)!.state.type).toBe("pending");
  });

  it("a draft the person edited refuses Pip's and keeps an agent's alongside; a run's plan is never replaced by Pip", async () => {
    const { proposals } = store();
    const old = proposals.draft({ type: "subtasks", parent: item("CA-1"), summaries: ["a"] }, null, "q", "ws-1");
    await proposals.edit(old.id, { type: "subtasks", summaries: ["mine"] });
    expect(() => proposals.draft({ type: "subtasks", parent: item("CA-1"), summaries: ["b"] }, null, "q", "ws-1")).toThrow(`the user edited draft ${old.id} of the same kind on CA-1`);
    const agent = proposals.fromRun({ type: "subtasks", parent: item("CA-1"), summaries: ["c"] }, null, runOrigin("ws-1"));
    expect([proposals.get(old.id)!.state.type, agent.state.type]).toEqual(["pending", "pending"]);
    expect(proposals.list().length).toBe(2);

    const plan = proposals.fromRun({ type: "rewrite", item: item("CA-2"), title: null, body: bodyChange({ blocks: [] }, "## Gossamr Plan\n\n1. Do it"), flattened: [] }, null, runOrigin("ws-1"));
    expect(() => proposals.draft({ type: "rewrite", item: item("CA-2"), title: { from: "Old", to: "New" }, body: bodyChange({ blocks: [] }, "Pip's description"), flattened: [] }, null, "q", "ws-1")).toThrow("only the user changes it");
    expect(proposals.get(plan.id)!.state.type).toBe("pending");
    // A title change leaves the plan alone, so both stay.
    const title = proposals.draft({ type: "rewrite", item: item("CA-2"), title: { from: "Old", to: "New" }, body: null, flattened: [] }, null, "q", "ws-1");
    expect([proposals.get(plan.id)!.state.type, title.state.type]).toEqual(["pending", "pending"]);
  });

  it("refuses Pip's ninth waiting draft in a workstream without storing it, never an agent's, and a replacement frees a slot", () => {
    const { proposals } = store();
    for (let n = 1; n < 8; n++) proposals.draft(note(`c${n}`), null, "q", "ws-1");
    const old = proposals.draft(move("CA-1", "ca-copy"), "Copy", "q", "ws-1");
    const next = proposals.draft(move("CA-1", "ca-qa"), "QA", "q", "ws-1");
    expect(proposals.get(old.id)!.supersededBy).toBe(next.id);
    const before = proposals.list().length;
    expect(() => proposals.draft(note("ninth"), null, "q", "ws-1")).toThrow("Workstream ws-1 already has 8 drafts waiting for the user. Don't draft more until they decide some; revise one with revise_proposal or withdraw one with retire_proposal.");
    expect(proposals.list().length).toBe(before);
    expect(proposals.fromRun(note("found"), null, runOrigin("ws-1")).state.type).toBe("pending");
    expect(proposals.draft(note("elsewhere"), null, "q").state.type).toBe("pending");
  });

  it("approving one move retires the other waiting moves of that ticket, whoever made them", async () => {
    const backend = new MockBackend();
    const key = "CA-401";
    const ticket = itemRef(key);
    const mine = await backend.proposalsCreate({ type: "transition", item: ticket, to: statusId("CA", "Copy") }, "Copy");
    const pips = backend.proposals.draft({ type: "transition", item: ticket, to: statusId("CA", "QA") }, "QA", "q");
    const other = backend.proposals.draft({ type: "comment", item: ticket, body: { blocks: [] } });
    const done = await backend.proposalsApprove(pips.id);
    expect([done.state.type, done.error]).toEqual(["applied", null]);
    expect(backend.proposals.get(mine.id)!.state).toEqual({ type: "retired", reason: `Another move of ${key} was approved` });
    expect(backend.proposals.get(other.id)!.state.type).toBe("pending");
    expect(backend.proposals.writes.filter((w) => w.intent.type === "transition" && w.intent.item.key === key)).toHaveLength(1);
  });
});

describe("mock draft hygiene in Pip's words", () => {
  it("uses the backend's words and cap", () => {
    const rust = readFileSync(new URL("../../src-tauri/src/proposals.rs", import.meta.url), "utf8");
    expect(/pub const WORKSTREAM_PENDING_CAP: usize = (\d+);/.exec(rust)?.[1]).toBe(String(WORKSTREAM_PENDING_CAP));
    expect(/pub const REPLACED_REASON: &str = "([^"]*)";/.exec(rust)?.[1]).toBe(REPLACED_REASON);
    expect(rust.replace(/"\s*\n\s*"/g, "")).toContain(PLAN_IS_THE_USERS);
    expect(rust).toContain("drafts waiting for the user. Don't draft more until they decide some; revise one with revise_proposal or withdraw one with retire_proposal.");
    expect(rust).toContain('format!("Another move of {} was approved", item.key)');
  });

  it("has the scripted Pip say why a draft was refused, as a real turn reports a tool's refusal", async () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const ticket = { connectionId: "mock", externalId: "CA-401", key: "CA-401" };
    const ws = await b.workstreamsOpen(ticket);
    for (let n = 0; n < WORKSTREAM_PENDING_CAP; n++) b.proposals.draft({ type: "comment", item: ticket, body: { blocks: [] } }, null, "q", ws.id);
    mockPipTurns.begin(`ws:${ws.id}`, "ws-capped", "move it", { imageCount: 0 });
    let said = "";
    const stop = mockPipEvents.on((id, e) => {
      if (id === "ws-capped" && e.type === "text") said += e.text;
    });
    await mockAsk({ requestId: "ws-capped", prompt: "move it to QA", context: { screen: "board", item: ticket, selection: [] } as unknown as ScreenContext, conversation: `ws:${ws.id}` } as AskRequest, b, 0);
    stop();
    // In the person's words: no workstream id or tool names.
    expect(said).toBe("I couldn't draft that: this workstream already has 8 drafts waiting for you. Decide some and I'll draft more");
    expect(b.proposals.list().filter((p) => p.intent.type === "transition")).toEqual([]);
  });
});

describe("the person's edit of a review draft", () => {
  const at = (line: number, body: string) => ({ path: "src/consumer/retry.ts", line, side: "RIGHT" as const, body });
  const review: Intent = { type: "githubReview", connectionId: "github:sample", item: ref, runId: "run-1", repo: "acme/webshop", number: 218, commitSha: "a1b2c3d4e5f6", summary: "Gossamr review of #218.", comments: [at(42, "No backoff."), at(17, "Nit: name.")] };

  it("rewords and drops comments, keeps the pull request and commit, and is marked Edited", async () => {
    const proposals = new MockProposals(async () => []);
    const p = proposals.fromRun(review, null, { type: "run", runId: "run-1", shortId: "abc" });
    const edited = await proposals.edit(p.id, { type: "githubReview", comments: [at(42, " Please add a backoff. ")] });
    expect(edited.intent).toEqual({ ...review, comments: [at(42, "Please add a backoff.")] });
    expect(edited.revisions[edited.revisions.length - 1]?.note).toBe("Edited");
    const summary = await proposals.edit(p.id, { type: "githubReview", summary: " Mine. " });
    expect(summary.intent.type === "githubReview" && [summary.intent.summary, summary.intent.comments.length]).toEqual(["Mine.", 1]);
  });

  it("refuses to move a comment, add one or leave anything blank, and changes nothing", async () => {
    const proposals = new MockProposals(async () => []);
    const p = proposals.fromRun(review, null, { type: "run", runId: "run-1", shortId: "abc" });
    await expect(proposals.edit(p.id, { type: "githubReview", comments: [at(43, "x")] })).rejects.toThrow(REVIEW_EDIT_KEEPS_POSITIONS);
    await expect(proposals.edit(p.id, { type: "githubReview", comments: [at(42, "x"), { ...at(42, "y"), side: "LEFT" }] })).rejects.toThrow(REVIEW_EDIT_KEEPS_POSITIONS);
    await expect(proposals.edit(p.id, { type: "githubReview", summary: "  " })).rejects.toThrow("summary can't be empty");
    await expect(proposals.edit(p.id, { type: "githubReview", comments: [at(42, " ")] })).rejects.toThrow("comment can't be empty");
    expect(proposals.get(p.id)!.intent).toEqual(review);
    expect(proposals.get(p.id)!.revisions).toEqual([]);
  });
});
