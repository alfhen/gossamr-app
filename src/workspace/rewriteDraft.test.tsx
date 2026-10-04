import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { bodyChange, docFromMarkdown } from "../backend/mockMarkdown";
import type { Proposal } from "../types";
import { DraftCard, draftSummary, draftTitle } from "./DraftCard";
import { DraftPreview, draftPreviewBody } from "./DraftPreview";
import { oneLine, rewriteBlocked, rewriteEdit, rewriteFields, takesBackendText, type Rewrite } from "./RewriteDiff";
import { targetOf } from "../lib/proposals";

const OLD = "Retries back off.\n\nBackoff starts at two seconds.\n\nOpen question: who owns the alert?";
const NEW = "Retries back off and cap at five attempts.\n\nBackoff starts at two seconds.\n\n## Scope\n\n- In: webhooks\n- Out: queue replay";

const intent = (over: Partial<Rewrite> = {}): Rewrite => ({
  type: "rewrite",
  item: itemRef("DEVOPS-471"),
  title: { from: "Retry failed payment webhooks", to: "Retry failed payment webhooks with a cap" },
  body: bodyChange(docFromMarkdown(OLD), NEW),
  flattened: [],
  ...over,
});

const draft = (i: Rewrite = intent(), over: Partial<Proposal> = {}): Proposal => ({
  id: "w1",
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  origin: { type: "chat", requestId: "r1" },
  createdBy: "pip",
  intent: i,
  label: null,
  basis: null,
  state: { type: "pending" },
  revisions: [],
  created: [],
  error: null,
  run: null,
  ...over,
});

const props = (p: Proposal) => ({ proposal: p, statusName: null, people: [], working: false, error: null, onApprove: vi.fn(), onSkip: vi.fn() });
const lines = (html: string, kind: string) => [...html.matchAll(new RegExp(`data-line="${kind}"[^>]*>.*?<span class="min-w-0[^>]*><span class="sr-only">[^<]*</span>(.*?)</span>`, "g"))].map((m) => m[1]);

describe("a description edit draft", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  });

  it("is named for what it changes and the ticket it is about", () => {
    expect(draftTitle(draft())).toBe("Update the title and description of DEVOPS-471");
    expect(draftTitle(draft(intent({ title: null })))).toBe("Update the description of DEVOPS-471");
    expect(draftTitle(draft(intent({ body: null })))).toBe("Update the title of DEVOPS-471");
    expect(targetOf(intent())?.key).toBe("DEVOPS-471");
  });

  it("summarises the title change and how many lines of the description change", () => {
    expect(draftSummary(draft(), null)).toBe("Title: Retry failed payment webhooks → Retry failed payment webhooks with a cap; Description: 5 added, 2 removed");
    const preview = draftPreviewBody(draft(), null);
    expect(preview.split("\n")).toEqual(["Title: Retry failed payment webhooks → Retry failed payment webhooks with a cap", "Description: 5 added, 2 removed"]);
  });

  it("shows the old lines removed and the new ones added, for the title and the description", () => {
    const html = renderToStaticMarkup(<DraftCard {...props(draft())} />);
    expect(html).toContain('data-diff="title"');
    expect(html).toContain('data-diff="description"');
    expect(lines(html, "del")).toEqual(["Retry failed payment webhooks", "Retries back off.", "Open question: who owns the alert?"]);
    expect(lines(html, "add")).toEqual(["Retry failed payment webhooks with a cap", "Retries back off and cap at five attempts.", "## Scope", "", "- In: webhooks", "- Out: queue replay"].map((t) => t || " "));
    expect(lines(html, "same")).toContain("Backoff starts at two seconds.");
    expect(html).toContain("Update title and description");
    expect(html).toContain(">Edit<");
    expect(html).toContain(">Skip<");
    expect(html).not.toContain("data-flattened");
  });

  it("tells a screen reader which lines were added, removed or left alone, apart from the visible markers", () => {
    const html = renderToStaticMarkup(<DraftCard {...props(draft())} />);
    expect(html).toContain('<span class="sr-only">Removed: </span>Retries back off.');
    expect(html).toContain('<span class="sr-only">Added: </span>Retries back off and cap at five attempts.');
    expect(html).toContain('<span class="sr-only">Unchanged: </span>Backoff starts at two seconds.');
    expect(html.match(/<span aria-hidden="true" class="w-3[^>]*>[+−]<\/span>/g)?.length).toBeGreaterThan(0);
    expect(html).toMatch(/role="group" aria-label="description changes"/);
  });

  it("shows only the part it changes", () => {
    const html = renderToStaticMarkup(<DraftCard {...props(draft(intent({ title: null })))} />);
    expect(html).toContain('data-diff="description"');
    expect(html).not.toContain('data-diff="title"');
    expect(renderToStaticMarkup(<DraftCard {...props(draft(intent({ body: null })))} />)).not.toContain('data-diff="description"');
  });

  it("says what the old description holds that approving turns into plain text", () => {
    const html = renderToStaticMarkup(<DraftCard {...props(draft(intent({ flattened: ["images and attachments", "tables"] })))} />);
    expect(html).toContain("data-flattened");
    expect(html).toContain("The old description has images and attachments, tables.");
    expect(html).toContain("Jira keeps the old text in the ticket&#x27;s history");
    expect(renderToStaticMarkup(<DraftCard {...props(draft(intent({ body: null, flattened: ["tables"] })))} />)).not.toContain("data-flattened");
  });

  it("shows why the last approval was refused, and offers no approve once decided", () => {
    const refused = "DEVOPS-471 changed since this was drafted, so nothing was written. Skip this draft and ask Pip to draft it again from the current text.";
    const html = renderToStaticMarkup(<DraftCard {...props(draft(intent(), { error: refused }))} />);
    expect(html).toContain("nothing was written");
    expect(html).toContain('role="alert"');
    const done = renderToStaticMarkup(<DraftCard {...props(draft(intent(), { state: { type: "applied" } }))} />);
    expect(done).toContain("Done");
    expect(done).not.toContain("Update title and description");
    const retired = renderToStaticMarkup(<DraftCard {...props(draft(intent(), { state: { type: "retired", reason: "the ticket's text changed since this was drafted" } }))} />);
    expect(retired).toContain("the ticket&#x27;s text changed since this was drafted");
  });

  it("appears in the conversation with its change and where to review it", () => {
    const html = renderToStaticMarkup(<DraftPreview proposal={draft()} statusName={null} targetTitle="Retry failed payment webhooks" onOpen={() => {}} />);
    expect(html).toContain("Update the title and description of DEVOPS-471");
    expect(html).toContain("Description: 5 added, 2 removed");
    expect(html).toContain("Review on DEVOPS-471 →");
  });
});

describe("what the person's edit sends", () => {
  it("sends nothing when the text is as drafted, and only the parts that changed otherwise", () => {
    const i = intent();
    expect(rewriteEdit(i, i.title!.to, i.body!.toText)).toBeNull();
    expect(rewriteEdit(i, "My title", i.body!.toText)).toEqual({ type: "rewrite", title: "My title" });
    expect(rewriteEdit(i, i.title!.to, "My text")).toEqual({ type: "rewrite", body: "My text" });
    expect(rewriteEdit(i, "T", "B")).toEqual({ type: "rewrite", title: "T", body: "B" });
    expect(rewriteEdit(intent({ title: null }), "ignored", "B")).toEqual({ type: "rewrite", body: "B" });
  });

  it("blocks approval for a blank part or for text that matches the ticket as it is", () => {
    const i = intent();
    expect(rewriteBlocked(i, i.title!.to, i.body!.toText)).toBe(false);
    expect(rewriteBlocked(i, "  ", i.body!.toText)).toBe(true);
    expect(rewriteBlocked(i, i.title!.to, "\n ")).toBe(true);
    expect(rewriteBlocked(i, i.title!.from, i.body!.fromText)).toBe(true);
    expect(rewriteBlocked(i, i.title!.from, "changed")).toBe(false);
    expect(rewriteBlocked(intent({ body: null }), i.title!.from, "")).toBe(true);
  });

  it("compares a title as the backend will store it, so whitespace alone is not a change", () => {
    const same = intent({ body: null, title: { from: "A B", to: "A B and more" } });
    expect(rewriteBlocked(same, "A  B", "")).toBe(true);
    expect(rewriteBlocked(same, " A\tB\n", "")).toBe(true);
    expect(rewriteBlocked(same, "A  B  C", "")).toBe(false);
    expect(rewriteBlocked(same, " \t ", "")).toBe(true);
    expect(rewriteBlocked(intent({ body: null, title: { from: "A  B", to: "x" } }), "A  B", "")).toBe(false);
    expect(oneLine("  A \n  B\t C ")).toBe("A B C");
  });
});

describe("what the fields show after the backend saved the person's edit", () => {
  it("follows the backend's text while typing is not in the way, and during an approval, but not over unsaved typing", () => {
    expect(takesBackendText(false, false)).toBe(true);
    expect(takesBackendText(true, true)).toBe(true);
    expect(takesBackendText(true, false)).toBe(false);
  });

  it("is the normalised title and the Markdown the backend kept, not what was typed", async () => {
    const backend = new MockBackend();
    const now = backend.connector.item(itemRef("DEVOPS-471"))!;
    const p = backend.proposals.draft({ type: "rewrite", item: now.item, title: { from: now.title, to: "Pip's title" }, body: bodyChange(now.body, "Pip's text"), flattened: [] });
    expect(rewriteFields(p.intent as Rewrite)).toEqual({ title: "Pip's title", text: "Pip's text" });
    const saved = await backend.proposalsEdit(p.id, { type: "rewrite", title: "  My   title\n", body: "  My text  " });
    expect(rewriteFields(saved.intent as Rewrite)).toEqual({ title: "My title", text: "My text" });
    expect(rewriteFields(null)).toEqual({ title: "", text: "" });
    expect(rewriteFields(intent({ title: null }))).toEqual({ title: "", text: NEW });
  });
});

describe("approving through the backend", () => {
  it("applies the edit the person made, not the one Pip drafted", async () => {
    const backend = new MockBackend();
    const now = backend.connector.item(itemRef("DEVOPS-471"))!;
    const p = backend.proposals.draft({ type: "rewrite", item: now.item, title: null, body: bodyChange(now.body, "Pip's text"), flattened: [] });
    await backend.proposalsEdit(p.id, { type: "rewrite", body: "The person's text\n\n- one" });
    const done = await backend.proposalsApprove(p.id);
    expect(done.state.type).toBe("applied");
    const text = backend.connector.item(now.item)!.body.blocks.map((b) => b.type);
    expect(text).toEqual(["paragraph", "list"]);
  });
});
