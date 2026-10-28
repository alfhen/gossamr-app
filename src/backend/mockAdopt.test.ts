import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Intent, RunSpec } from "../types";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import { UNDO_WINDOW_MS } from "./mockWorkstreams";
import { NOTHING_TO_ADOPT } from "../lib/workstreamAdopt";
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
const spec = (over: Partial<RunSpec> = {}): RunSpec => ({ role: "investigate", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: `ca-401-${Math.random().toString(16).slice(2, 8)}`, brief: "", ticketBlock: null, ...over });
const lines = (backend: MockBackend, id: string) => backend.workstreamsEvents(id).then((events) => events.map((e) => [e.actor, e.action, e.detail ?? null]));

/** A run on CA-401 approved in General, as the board does it. */
async function runInGeneral(backend: MockBackend) {
  return backend.runs.start(spec(), CA401);
}

beforeEach(() => saved.clear());
afterEach(() => vi.useRealTimers());

describe("reopening a closed workstream (the mock of reopen_workstream)", () => {
  it("puts it back as it stood, once, and says so in its audit", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const ws = await backend.workstreamsOpen(CA401);
    backend.workstreams.setNotes(ws.id, "Waiting on Sam.");
    await backend.workstreamsClose(ws.id);
    const back = await backend.workstreamsReopen(ws.id);
    expect(back).toMatchObject({ id: ws.id, closedAt: null, notes: "Waiting on Sam." });
    expect(await backend.workstreamsReopen(ws.id)).toEqual(back);
    expect((await backend.workstreamsList()).map((v) => v.workstream.id)).toEqual([ws.id]);
    expect((await lines(backend, ws.id)).map(([, a]) => a)).toEqual(["opened", "notes_set", "closed", "reopened"]);
  });

  it("is refused when the ticket has another open workstream by now, or for one that isn't there", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const ws = await backend.workstreamsOpen(CA401);
    await backend.workstreamsClose(ws.id);
    const fresh = await backend.workstreamsOpen(CA401);
    await expect(backend.workstreamsReopen(ws.id)).rejects.toThrow("has another workstream open");
    expect((await backend.workstreams.get(fresh.id))?.workstream.closedAt).toBeNull();
    await expect(backend.workstreamsReopen("ws-404")).rejects.toThrow("there is no workstream ws-404");
  });
});

describe("bringing a ticket's runs and drafts into its workstream (the mock of adopt_into_workstream)", () => {
  it("offers what is in General, moves nothing when the workstream opens, and moves it only on the ask", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const run = await runInGeneral(backend);
    const draft = backend.proposals.draft(comment, null, "q1");
    const ws = await backend.workstreamsOpen(CA401);
    expect((await backend.runs.get(run.id))?.spec.workstream).toBeUndefined();
    const before = await backend.workstreams.get(ws.id);
    expect(before).toMatchObject({ stage: "intake", runs: [], adoptable: { runs: [run.id], drafts: [draft.id] } });
    expect((await backend.workstreamsList())[0].adoptable).toEqual(before?.adoptable);

    const moved = await backend.workstreamsAdopt(ws.id);
    expect(moved).toEqual({ runs: [run.id], drafts: [draft.id] });
    expect((await backend.runs.get(run.id))?.spec.workstream).toBe(ws.id);
    expect((await backend.proposalsList({ workstream: ws.id })).map((p) => p.id)).toEqual([draft.id]);
    const after = await backend.workstreams.get(ws.id);
    expect(after).toMatchObject({ stage: "investigate", runs: [run.id] });
    expect(after?.adoptable).toBeUndefined();
    expect(await lines(backend, ws.id)).toEqual([
      ["person", "opened", null],
      ["person", "adopted", "1 run, 1 draft"],
    ]);
    await expect(backend.workstreamsAdopt(ws.id)).rejects.toThrow(NOTHING_TO_ADOPT);
  });

  it("leaves what belongs to another workstream, another ticket and a closed one, and a draft with nowhere to record one", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const other = await backend.workstreamsOpen(itemRef("CA-402"));
    const runElsewhere = backend.runs.start(spec({ workstream: other.id }), itemRef("CA-402"));
    const board = await backend.proposalsCreate(comment, null);
    const ws = await backend.workstreamsOpen(CA401);
    expect((await backend.workstreams.get(ws.id))?.adoptable).toBeUndefined();
    await expect(backend.workstreamsAdopt(ws.id)).rejects.toThrow(NOTHING_TO_ADOPT);
    expect((await backend.proposals.get(board.id))?.origin.type).toBe("board");
    expect((await backend.runs.get(runElsewhere.id))?.spec.workstream).toBe(other.id);
    await backend.workstreamsClose(ws.id);
    backend.proposals.draft(comment, null, "q2");
    expect((await backend.workstreams.get(ws.id))?.adoptable).toBeUndefined();
    await expect(backend.workstreamsAdopt(ws.id)).rejects.toThrow("is closed");
    const ticketless = await backend.workstreamsOpen(null, "Why is it slow?");
    await expect(backend.workstreamsAdopt(ticketless.id)).rejects.toThrow("no ticket");
  });

  it("is undone right after, putting each back in General, and refused once anything else happened or after the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T09:00:00Z"));
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const run = await runInGeneral(backend);
    const draft = backend.proposals.draft(comment, null, "q1");
    const ws = await backend.workstreamsOpen(CA401);
    const moved = await backend.workstreamsAdopt(ws.id);
    const back = await backend.workstreamsUndo(ws.id, { type: "adopt", ...moved });
    expect(back.id).toBe(ws.id);
    expect((await backend.runs.get(run.id))?.spec.workstream).toBeUndefined();
    expect(await backend.proposalsList({ workstream: ws.id })).toEqual([]);
    expect((await backend.workstreams.get(ws.id))?.adoptable).toEqual({ runs: [run.id], drafts: [draft.id] });
    const all = await lines(backend, ws.id);
    expect(all[all.length - 1]).toEqual(["person", "undone", "adopted"]);
    await expect(backend.workstreamsUndo(ws.id, { type: "adopt", ...moved })).rejects.toThrow(/can't be undone/);

    await backend.workstreamsAdopt(ws.id);
    await backend.workstreamsPause(ws.id);
    await expect(backend.workstreamsUndo(ws.id, { type: "adopt", ...moved })).rejects.toThrow(/can't be undone/);
    expect((await backend.runs.get(run.id))?.spec.workstream).toBe(ws.id);

    await backend.workstreamsResume(ws.id);
    const second = backend.proposals.draft(comment, null, "q2");
    const again = await backend.workstreamsAdopt(ws.id);
    expect(again).toEqual({ runs: [], drafts: [second.id] });
    vi.setSystemTime(Date.now() + UNDO_WINDOW_MS + 1);
    await expect(backend.workstreamsUndo(ws.id, { type: "adopt", ...again })).rejects.toThrow(/can't be undone/);
  });
});
