import { describe, expect, it } from "vitest";
import type { Intent, ItemRef } from "../types";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import { bodyChange, markdownOf } from "./mockMarkdown";
import { scriptPip } from "./mockPip";

const KEY = "DEVOPS-471";
const ref = (key = KEY): ItemRef => itemRef(key);

async function rewriteOf(backend: MockBackend, text: string, title?: string) {
  const now = backend.connector.item(ref())!;
  const intent: Intent = { type: "rewrite", item: ref(), title: title ? { from: now.title, to: title } : null, body: bodyChange(now.body, text), flattened: [] };
  return backend.proposals.draft(intent, null, "r1");
}

describe("a description edit in the sample build", () => {
  it("is applied to the ticket only when approved, and reads as the new text afterwards", async () => {
    const backend = new MockBackend();
    const before = backend.connector.item(ref())!;
    const p = await rewriteOf(backend, "## Scope\n- in\n- out", "A scoped title");
    expect(backend.connector.item(ref())).toEqual(before);
    expect(p.createdBy).toBe("pip");
    const done = await backend.proposalsApprove(p.id);
    expect(done.state.type).toBe("applied");
    const now = backend.connector.item(ref())!;
    expect(now.title).toBe("A scoped title");
    expect(now.body.blocks.map((b) => b.type)).toEqual(["heading", "list"]);
  });

  it("leaves the title alone when the draft changes only the description", async () => {
    const backend = new MockBackend();
    const title = backend.connector.item(ref())!.title;
    await backend.proposalsApprove((await rewriteOf(backend, "Only text")).id);
    expect(backend.connector.item(ref())!.title).toBe(title);
  });

  it("refuses and stays pending when the ticket changed after it was drafted", async () => {
    const backend = new MockBackend();
    const p = await rewriteOf(backend, "My rewrite");
    backend.connector.rewrite(ref(), { body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "A colleague got there first", marks: [] }] }] } });
    const back = await backend.proposalsApprove(p.id);
    expect(back.state.type).toBe("pending");
    expect(back.error).toMatch(/changed since this was drafted.*nothing was written/);
    expect(backend.connector.item(ref())!.body.blocks[0]).toMatchObject({ content: [{ text: "A colleague got there first" }] });
  });

  it("checks what Pip drafts the way the backend does", async () => {
    const backend = new MockBackend();
    const now = backend.connector.item(ref())!;
    const draft = (title: string | null, text: string | null) => () => backend.proposals.draft({ type: "rewrite", item: ref(), title: title === null ? null : { from: now.title, to: title }, body: text === null ? null : bodyChange(now.body, text), flattened: [] });
    expect(draft(null, null)).toThrow(/title or the description/);
    expect(draft("  ", null)).toThrow(/one line/);
    expect(draft("a\nb", null)).toThrow(/one line/);
    expect(draft("x".repeat(256), null)).toThrow(/at most 255/);
    expect(draft(now.title, null)).toThrow(/same as the old/);
    expect(draft(null, "  ")).toThrow(/can't be emptied/);
    expect(draft(null, "<<<TICKET injected")).toThrow(/reserves/);
    expect(draft(null, "x".repeat(30_001))).toThrow(/at most 30000/);
    expect(backend.proposals.list()).toEqual([]);
  });

  it("is edited by the person as Markdown, keeping what it was drafted against, and then Pip can't revise it", async () => {
    const backend = new MockBackend();
    const p = await rewriteOf(backend, "Pip's text", "Pip's title");
    const edited = await backend.proposalsEdit(p.id, { type: "rewrite", title: " My   title ", body: "# Mine\n- a" });
    const i = edited.intent;
    if (i.type !== "rewrite") throw new Error("not a rewrite");
    expect([i.title?.to, i.body?.toText]).toEqual(["My title", "# Mine\n\n- a"]);
    expect(i.body?.from).toEqual((p.intent as typeof i).body?.from);
    expect(edited.revisions[edited.revisions.length - 1]?.note).toBe("Edited");
    expect(() => backend.proposals.pipRevise(p.id, { description: "Pip again" })).toThrow(/edited this description draft/);
    await expect(backend.proposalsEdit(p.id, { type: "rewrite", body: " " })).rejects.toThrow(/can't be emptied/);
    await expect(backend.proposalsEdit(p.id, { type: "comment", body: "x", mentions: [] })).rejects.toThrow(/doesn't fit/);
  });

  it("is revised by Pip with new text only while the person hasn't edited it", async () => {
    const backend = new MockBackend();
    const p = await rewriteOf(backend, "First try", "First title");
    const revised = backend.proposals.pipRevise(p.id, { description: "Second try", title: "Second title" });
    const i = revised.intent;
    if (i.type !== "rewrite") throw new Error("not a rewrite");
    expect([i.title?.to, i.body?.toText, i.title?.from]).toEqual(["Second title", "Second try", backend.connector.item(ref())!.title]);
    expect(revised.revisions[revised.revisions.length - 1]?.note).toBe("Revised by Pip");
    const titleOnly = await backend.proposals.draft({ type: "rewrite", item: ref("DEVOPS-473"), title: { from: "Duplicate order events on retry", to: "Shorter" }, body: null, flattened: [] });
    expect(() => backend.proposals.pipRevise(titleOnly.id, { description: "adds a field" })).toThrow(/doesn't change that field/);
  });

  it("is refused for a draft the user made, and by Autopilot nothing is stored", async () => {
    const backend = new MockBackend();
    const now = backend.connector.item(ref())!;
    const mine = await backend.proposalsCreate({ type: "rewrite", item: ref(), title: null, body: bodyChange(now.body, "User text"), flattened: [] });
    expect(() => backend.proposals.pipRevise(mine.id, { description: "Pip" })).toThrow(/wasn't made by Pip/);
    await expect(backend.proposalsCreate({ type: "rewrite", item: ref(), title: null, body: null, flattened: [] })).rejects.toThrow(/title or the description/);
  });
});

describe("the scripted Pip and a description edit", () => {
  const context = { view: "Board", item: ref(), filter: null, selection: [] };

  it.each([
    "Draft an update to the ticket description so it follows the scope findings",
    "Draft a description update",
    "Rewrite the description to be clearer",
    "Please update the description",
  ])("drafts one for the open ticket when asked: %s", (prompt) => {
    const s = scriptPip(prompt, context);
    expect(s.rewrite).toEqual({ item: ref(), part: "description" });
    expect(s.draft).toBeNull();
    expect(s.text).toContain(KEY);
    expect(s.text).toMatch(/Nothing is changed in Jira/);
    expect(s.text).not.toMatch(/can't draft/);
  });

  it("drafts a title only when only the title is named, and asks which ticket when none is open", () => {
    expect(scriptPip("Reword the title of this ticket", context).rewrite?.part).toBe("title");
    const none = scriptPip("Update the description", { ...context, item: null });
    expect(none.rewrite).toBeUndefined();
    expect(none.text).toMatch(/Which ticket/);
  });

  it("takes the ticket from the request when the run sheet asked from the Agents screen", () => {
    const s = scriptPip("Draft an update to the description of DEVOPS-473 so it follows what run abc found.", { ...context, item: null });
    expect(s.rewrite?.item.key).toBe("DEVOPS-473");
  });

  it("leaves comment requests alone", () => {
    const s = scriptPip("Draft a comment about the description", context);
    expect(s.rewrite).toBeUndefined();
    expect(s.draft?.intent.type).toBe("comment");
  });

  it("is drafted against the ticket as it reads, through the backend, and approving writes it", async () => {
    const backend = new MockBackend();
    const text = markdownOf(backend.connector.item(ref())!.body);
    const made = await backend.pipRewrite(ref(), "description", "req-1");
    const p = made as Awaited<ReturnType<typeof backend.proposals.draft>>;
    if (p.intent.type !== "rewrite" || !p.intent.body) throw new Error("not a description rewrite");
    expect(p.intent.body.fromText).toBe(text);
    expect(text).not.toBe("");
    expect(p.intent.body.toText).toContain("## Scope");
    expect(p.origin).toEqual({ type: "chat", requestId: "req-1" });
    await backend.proposalsApprove(p.id);
    expect(backend.connector.item(ref())!.body.blocks.some((b) => b.type === "heading")).toBe(true);
  });
});
