import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Proposal, WorkContainer } from "../types";
import { containerRef, itemRef } from "../backend/mockConnector";
import { DraftPeekView } from "./DraftPeek";
import { fieldsOf } from "./draftTicket";
const container = (key: string): WorkContainer => ({ ref: containerRef(key), key, name: key, workflow: { statuses: [], transitions: { type: "any" } } }) as unknown as WorkContainer;

describe("the draft ticket made from a run", () => {
  const draft = (over: Partial<Proposal> = {}): Proposal & { intent: Extract<Proposal["intent"], { type: "create" }> } =>
    ({
      id: "p1",
      createdAt: "2026-09-30T10:00:00Z",
      updatedAt: "2026-09-30T10:00:00Z",
      origin: { type: "run", runId: "run-3", shortId: "ab12cd34" },
      createdBy: "user",
      intent: { type: "create", container: containerRef("CA"), fields: { title: "Add a backoff", body: { blocks: [] }, kind: "bug", assignee: null, parent: null, priority: null, labels: [] }, link: null },
      label: "From agent run ab12cd34",
      basis: null,
      state: { type: "pending" },
      revisions: [],
      created: [],
      error: null,
      run: null,
      ...over,
    }) as Proposal & { intent: Extract<Proposal["intent"], { type: "create" }> };
  const view = (p: ReturnType<typeof draft>, over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<DraftPeekView proposal={p} fields={fieldsOf(p)} containers={[container("CA"), container("SUP")]} people={[]} working={false} error={null} onChange={vi.fn()} onCommit={vi.fn()} onCreate={vi.fn()} onSkip={vi.fn()} onClose={vi.fn()} {...over} />);

  it("says where it came from with a link to the run, lets the project change while pending, and offers Finish with Pip", () => {
    const html = view(draft(), { onOpenRun: vi.fn(), onFinishWithPip: vi.fn() });
    expect(html).toMatch(/From <button[^>]*title="Open the run this draft came from"[^>]*>an agent run<\/button>/);
    expect(html).not.toContain("ab12cd34");
    expect(html).toContain("Finish with Pip");
    expect(html).toMatch(/<select[^>]*aria-label="Project"/);
    expect(html).not.toMatch(/<select[^>]*aria-label="Project"[^>]*disabled=""/);
  });

  it("offers neither once it is decided, and a draft that is not from a run has no run header", () => {
    expect(view(draft({ state: { type: "applied" }, created: [itemRef("CA-9")] }), { onOpenRun: vi.fn(), onFinishWithPip: vi.fn() })).not.toContain("Finish with Pip");
    const plain = view(draft({ origin: { type: "board" }, createdBy: "user" }));
    expect(plain).not.toContain("From <");
    expect(plain).not.toContain("Finish with Pip");
  });
});
