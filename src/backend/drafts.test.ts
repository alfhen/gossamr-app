import { describe, expect, it } from "vitest";
import { docFromText } from "../lib/docs";
import { supersession, supersessionKey } from "../lib/proposals";
import type { Intent, Proposal } from "../types";
import { MockProposals } from "./mockProposals";
import { reviewText } from "./mockReviewDraft";

const item = { connectionId: "mock", externalId: "CA-1", key: "CA-1" };
const other = { ...item, externalId: "CA-2", key: "CA-2" };
const container = { connectionId: "mock", externalId: "CA" };
const intents: Intent[] = [
  { type: "comment", item, body: docFromText("A report") },
  { type: "transition", item, to: "done" },
  { type: "create", container, fields: { title: "A task", body: docFromText("Details"), kind: "task", parent: null, assignee: null, priority: null, labels: [] }, link: null },
  { type: "update", item, patch: { assignee: null, parent: null, priority: null } },
  { type: "rewrite", item, title: { from: "Old", to: "New" }, body: null, flattened: [] },
  { type: "link", from: item, to: other, kind: "blocks" },
  { type: "subtasks", parent: item, summaries: ["One", "Two"] },
  { type: "githubReview", connectionId: "github:ada", item, runId: "reviewer", repo: "acme/repo", number: 12, commitSha: "abc123", summary: "Please check the retry.", comments: [] },
];

const proposal = (intent: Intent, over: Partial<Proposal> = {}): Proposal => ({ id: "old", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", origin: { type: "board" }, createdBy: "user", intent, label: null, basis: null, state: { type: "pending" }, revisions: [], created: [], error: null, run: null, ...over });

describe("one supersession rule for eight write kinds", () => {
  it.each(intents.filter((intent) => intent.type !== "create"))("replaces the same $type target across makers, origins and workstreams", (intent) => {
    const older = proposal(intent, { createdBy: "pip" });
    const newer = proposal(intent, { id: "new", createdBy: "pip", origin: { type: "chat", requestId: "turn", workstream: "another" } });
    expect(supersession(older, newer).type).toBe("supersede");
    expect(supersession({ ...older, origin: { type: "run", runId: "agent", shortId: null, workstream: "old" } }, newer).type).toBe("supersede");
    expect(supersession({ ...older, state: { type: "applying" } }, newer).type).toBe("unrelated");
  });

  it.each(intents)("keeps an edited $type beside the new draft without refusing it", async (intent) => {
    const drafts = new MockProposals(async () => []);
    const older = drafts.draft(intent);
    const edited = proposal(intent, { ...older, revisions: [{ at: older.updatedAt, note: "Edited", intent }] });
    if (intent.type === "create") return expect(supersession(edited, proposal(intent, { id: "new" })).type).toBe("unrelated");
    expect(supersession(edited, proposal(intent, { id: "new" }))).toMatchObject({ type: "alongside", reason: "draft_kept_edited" });
  });

  it("stores the new draft beside the person's edit and writes only on approval", async () => {
    const drafts = new MockProposals(async () => []);
    const older = drafts.draft(intents[0]);
    await drafts.edit(older.id, { type: "comment", body: "My words", mentions: [] });
    const newer = drafts.draft(intents[0]);
    expect(drafts.list({ states: ["pending"] }).map((draft) => draft.id)).toEqual([newer.id, older.id]);
    expect(drafts.writes).toEqual([]);
    await drafts.approve(newer.id);
    expect(drafts.writes).toHaveLength(1);
    expect(drafts.get(older.id)?.state.type).toBe("pending");
  });

  it("has no workstream cap", () => {
    const drafts = new MockProposals(async () => []);
    for (let index = 0; index < 12; index++) drafts.draft({ type: "comment", item: { ...item, externalId: `CA-${index}` }, body: docFromText("Report") }, null, "turn", "workstream");
    expect(drafts.list({ states: ["pending"] })).toHaveLength(12);
  });

  it("includes connections and create parents in targets, but not link kinds or rewrite subfields", () => {
    expect(supersessionKey(intents[0])).not.toBe(supersessionKey({ type: "comment", item: { ...item, connectionId: "other" }, body: docFromText("Report") }));
    const create = intents[2] as Extract<Intent, { type: "create" }>;
    expect(supersessionKey(create)).toBeNull();
    expect(supersessionKey({ ...create, fields: { ...create.fields, parent: item } })).toBeNull();
    expect(supersessionKey(intents[5])).toBe(supersessionKey({ type: "link", from: item, to: other, kind: "relates" }));
    expect(supersessionKey(intents[4])).toBe(supersessionKey({ type: "rewrite", item, title: null, body: { from: docFromText("Old"), to: docFromText("New"), fromText: "Old", toText: "New" }, flattened: [] }));
  });

  it("keeps possibly posted reviews and partially created subtasks for reconciliation", () => {
    const review = proposal(intents[7], { maybePosted: { at: "2026-10-01T00:00:00Z", commitSha: "abc123", summary: "Sent", checkedAt: null } });
    expect(supersession(review, proposal(intents[7], { id: "new" })).type).toBe("alongside");
    const partial = proposal(intents[6], { created: [other] });
    expect(supersession(partial, proposal(intents[6], { id: "new" })).type).toBe("alongside");
  });
});

describe("review comments at the reviewed commit", () => {
  it("keeps commentable lines inline and moves the rest to the summary", () => {
    const comment = { path: "src/retry.ts", line: 2, side: "RIGHT" as const, body: "Check this retry." };
    const outside = { ...comment, line: 90, body: "Check the timeout." };
    const result = reviewText("Summary", [comment, outside], [{ path: comment.path, patch: "@@ -1,2 +1,2 @@\n keep\n-old\n+new" }]);
    expect(result.comments).toEqual([comment]);
    expect(result.summary).toContain("Check the timeout. (src/retry.ts:90)");
    expect(reviewText("Summary", [comment], null).comments).toEqual([]);
  });
});
