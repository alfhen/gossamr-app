import { describe, expect, it } from "vitest";
import type { Intent, Proposal, WorkDoc, WorkstreamEvent, WorkstreamView } from "../types";
import { editedWords, jiraSent, sentWhat } from "./jiraSent";

const ago = (hours: number) => new Date(Date.parse("2026-10-13T12:00:00Z") - hours * 3_600_000).toISOString();
const ref = (key: string) => ({ connectionId: "c", externalId: key, key });
const doc = (text: string): WorkDoc => ({ blocks: text.split("\n\n").map((t) => ({ type: "paragraph", content: [{ type: "text", text: t, marks: [] }] })) }) as WorkDoc;

const draft = (id: string, intent: Intent, over: Partial<Proposal> = {}): Proposal =>
  ({ id, createdAt: ago(30), updatedAt: ago(5), origin: { type: "chat", requestId: "r", workstream: "w1" }, createdBy: "pip", intent, label: null, basis: null, state: { type: "applied" }, revisions: [], created: [], error: null, run: null, ...over }) as Proposal;

const comment = (key: string, text: string): Intent => ({ type: "comment", item: ref(key), body: doc(text) });

const view = (id: string, key: string): WorkstreamView => ({ workstream: { id, itemKey: key, title: `${key} title`, closedAt: null }, labels: [["r3", "R3"]], runs: [] }) as unknown as WorkstreamView;

const approved = (proposalId: string, at: string, actor: WorkstreamEvent["actor"] = "person"): WorkstreamEvent => ({ workstreamId: "w1", seq: 1, at, actor, action: "draft_approved", runId: null, proposalId, digest: null, detail: null });

describe("What Jira saw from me", () => {
  it("lists what was posted, newest first: comments, moves, description edits and subtasks", () => {
    const proposals = [
      draft("c1", comment("CA-401", "Investigated: the cache key is wrong.\n\nFix is one line."), { updatedAt: ago(8) }),
      draft("t1", { type: "transition", item: ref("CA-401"), to: "31" }, { label: "In Review", updatedAt: ago(4) }),
      draft("r1", { type: "rewrite", item: ref("CA-402"), title: { from: "Old", to: "New" }, body: { from: doc("a"), to: doc("b"), fromText: "a", toText: "A better description.\n\nWith detail." }, flattened: [] }, { updatedAt: ago(2) }),
      draft("s1", { type: "subtasks", parent: ref("CA-403"), summaries: ["Write tests", "Update docs"] }, { updatedAt: ago(1) }),
    ];
    const out = jiraSent({ proposals, events: {}, workstreams: [view("w1", "CA-401")] });
    expect(out.map((e) => [e.id, e.kind, e.ticketKey])).toEqual([
      ["s1", "subtasks", "CA-403"],
      ["r1", "description", "CA-402"],
      ["t1", "transition", "CA-401"],
      ["c1", "comment", "CA-401"],
    ]);
    expect(out.map((e) => e.summary)).toEqual(["2 subtasks: Write tests; Update docs", "Description rewritten and title changed", "Moved to In Review", "Investigated: the cache key is wrong."]);
    expect(out[3].detail).toEqual(["Investigated: the cache key is wrong.", "", "Fix is one line."]);
    expect(out[1].detail).toEqual(["Title: Old → New", "New description:", "A better description.", "", "With detail."]);
  });

  it("leaves out what Jira never saw: waiting, skipped, retired and approving-in-progress drafts, runs and GitHub reviews", () => {
    const states = (["pending", "applying", "skipped"] as const).map((s, i) => draft(`x${i}`, comment("CA-401", "hello"), { state: { type: s } as Proposal["state"] }));
    const retired = draft("x3", comment("CA-401", "hello"), { state: { type: "retired", reason: "Replaced" } });
    const run = draft("x4", { type: "startRun", connectionId: "c", item: null, spec: {} } as unknown as Intent);
    const review = draft("x5", { type: "githubReview", connectionId: "g", item: null, runId: "r", repo: "a/b", number: 1, commitSha: "abc", summary: "S", comments: [] });
    const follow = draft("x6", { type: "followUp", connectionId: "c", runId: "r", item: null, message: "m", reason: "r" });
    expect(jiraSent({ proposals: [...states, retired, run, review, follow], events: {}, workstreams: [] })).toEqual([]);
  });

  it("takes when it was approved, and which workstream, from the audit's draft_approved line when it has one", () => {
    const p = draft("c1", comment("CA-401", "hello"), { origin: { type: "board" }, updatedAt: ago(1) });
    const out = jiraSent({ proposals: [p], events: { w1: [approved("c1", ago(20))] }, workstreams: [view("w1", "CA-401")] });
    expect(out[0]).toMatchObject({ at: ago(20), workstreamId: "w1", workstream: "CA-401" });
    // Only the person's line is an approval; without one the draft says when it last changed.
    const other = jiraSent({ proposals: [p], events: { w1: [approved("c1", ago(20), "pip")] }, workstreams: [] });
    expect(other[0]).toMatchObject({ at: ago(1), workstreamId: null, workstream: null });
  });

  it("says where the draft came from and who made it", () => {
    const pip = draft("a", comment("CA-401", "x"));
    const run = draft("b", comment("CA-401", "x"), { origin: { type: "run", runId: "r3", shortId: null, workstream: "w1" }, createdBy: "agent" });
    const board = draft("c", comment("CA-401", "x"), { origin: { type: "board" }, createdBy: "user" });
    const asked = draft("d", comment("CA-401", "x"), { createdBy: "user", label: "Questions for the reporter" });
    const nudge = draft("e", comment("CA-401", "x"), { createdBy: "user", label: "Nudge for the reporter" });
    const out = Object.fromEntries(jiraSent({ proposals: [pip, run, board, asked, nudge], events: {}, workstreams: [view("w1", "CA-401")] }).map((e) => [e.id, [e.madeBy, e.from]]));
    expect(out).toEqual({ a: ["Pip", "Pip's conversation"], b: ["An agent run", "run R3"], c: ["You", "the board"], d: ["Gossamr", "Gossamr"], e: ["Gossamr", "Gossamr"] });
    const labels = Object.fromEntries(jiraSent({ proposals: [pip, asked, nudge], events: {}, workstreams: [view("w1", "CA-401")] }).map((e) => [e.id, [e.kind, e.label]]));
    expect(labels).toEqual({ a: ["comment", undefined], d: ["comment", "Questions to the reporter"], e: ["comment", "Nudge to the reporter"] });
  });

  it("says whether the person edited the draft before approving it", () => {
    const edited = draft("a", comment("CA-401", "x"), { revisions: [{ at: ago(6), note: "Revised by Pip", intent: comment("CA-401", "y") }, { at: ago(5), note: "Edited", intent: comment("CA-401", "z") }] });
    const pipOnly = draft("b", comment("CA-401", "x"), { revisions: [{ at: ago(6), note: "Revised by Pip", intent: comment("CA-401", "y") }] });
    const out = jiraSent({ proposals: [edited, pipOnly], events: {}, workstreams: [] });
    expect(Object.fromEntries(out.map((e) => [e.id, e.edited]))).toEqual({ a: true, b: false });
    expect(editedWords({ madeBy: "Pip", edited: true })).toBe("Pip drafted it; you edited it before approving");
    expect(editedWords({ madeBy: "Pip", edited: false })).toBe("Pip drafted it; posted without changes");
    expect(editedWords({ madeBy: "You", edited: false })).toBe("You wrote it");
    expect(editedWords({ madeBy: "You", edited: true })).toBe("You wrote it and edited it before approving");
  });

  it("keeps a long comment short on its line and whole behind the disclosure", () => {
    const long = "A".repeat(300);
    const what = sentWhat(comment("CA-401", long), null)!;
    expect(what.summary.length).toBeLessThanOrEqual(120);
    expect(what.summary.endsWith("…")).toBe(true);
    expect(what.detail).toEqual([long]);
  });

  it("covers the other writes: a new ticket, a change and a link, and no ticket key for a created one without a target", () => {
    const create = draft("n", { type: "create", container: { connectionId: "c", externalId: "p", key: "CA" } as never, fields: { title: "Fix it", body: doc("Details"), kind: "task", assignee: null, parent: null, priority: null, labels: [] }, link: null }, { created: [ref("CA-500")] });
    const link = draft("l", { type: "link", from: ref("CA-1"), to: ref("CA-2"), kind: "blocks" });
    const update = draft("u", { type: "update", item: ref("CA-3"), patch: { assignee: null, parent: null, priority: "high" } });
    const out = Object.fromEntries(jiraSent({ proposals: [create, link, update], events: {}, workstreams: [] }).map((e) => [e.id, [e.kind, e.summary, e.ticketKey]]));
    expect(out).toEqual({ n: ["ticket", "Created “Fix it”", "CA-500"], l: ["link", "Linked CA-1 blocks CA-2", "CA-1"], u: ["change", "Changed the priority to high", "CA-3"] });
  });
});

describe("what the row shows of a comment to the reporter", () => {
  const asked = (id: string, text: string) => draft(id, comment("CA-401", text), { createdBy: "user", label: "Questions for the reporter", updatedAt: ago(Number(id.slice(1))) });
  const first = "Hi Mette,\n\nBefore CA-401 can be planned we need a few things cleared up:\n\n- What is the goal?";
  const again = "Hi Mette,\n\nThanks for your answer above. Before CA-401 can be planned, a few things are still open:\n\n- What is in scope?";

  it("skips the greeting line in the short preview and keeps it in the whole", () => {
    const [e] = jiraSent({ proposals: [asked("a1", first)], events: {}, workstreams: [] });
    expect(e.summary).toBe("Before CA-401 can be planned we need a few things cleared up:");
    expect(e.detail[0]).toBe("Hi Mette,");
    expect(sentWhat(comment("CA-401", "Hi,"), null)!.summary).toBe("Hi,");
    expect(sentWhat(comment("CA-401", "Hello there, I moved this."), null)!.summary).toBe("Hello there, I moved this.");
  });

  it("calls a second ask after a reply a follow-up, not the same row twice", () => {
    const out = jiraSent({ proposals: [asked("a8", first), asked("a2", again)], events: {}, workstreams: [] });
    expect(out.map((e) => e.label)).toEqual(["Follow-up questions to the reporter", "Questions to the reporter"]);
  });
});
