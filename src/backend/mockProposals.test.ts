import { describe, expect, it } from "vitest";
import { docText } from "../lib/docs";
import type { Intent } from "../types";
import { MockBackend } from "./mock";

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

  it("creates only the subtasks not yet made when retried", async () => {
    const backend = new MockBackend();
    const p = backend.proposals.draft({ type: "subtasks", parent: ref, summaries: ["a", "b"] });
    const done = await backend.proposalsApprove(p.id);
    expect(done.created).toHaveLength(2);
    expect((await backend.load()).tickets["CA-412"].subtasks.filter((s) => ["a", "b"].includes(s.summary))).toHaveLength(2);
  });
});
