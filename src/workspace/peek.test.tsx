import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { docFromText } from "../lib/docs";
import type { Proposal } from "../types";
import { useWorkspace } from "../workspaceStore";
import { DraftCard, draftSummary, draftTitle, type DraftCardProps } from "./DraftCard";
import { PeekView, type PeekViewProps } from "./PeekSheet";
import { PipAvatar } from "./PipAvatar";
import { FilterNote, Launcher, Nudge, PipFilterNote } from "./PipExtras";
import { ContextChip } from "./PipPane";
import { DraftPreview } from "./DraftPreview";
import { WorkDocView } from "./WorkDocView";

const ws = () => useWorkspace.getState();

beforeEach(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  await ws().init(new MockBackend());
});

const proposal = (over: Partial<Proposal>): Proposal => ({
  id: "p1",
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  origin: { type: "chat", requestId: "r" },
  createdBy: "pip",
  intent: { type: "comment", item: { connectionId: "mock", externalId: "DEVOPS-471", key: "DEVOPS-471" }, body: docFromText("Looks good.") },
  label: null,
  basis: null,
  state: { type: "pending" },
  revisions: [],
  created: [],
  error: null,
  ...over,
});

const card = (p: Proposal, over: Partial<DraftCardProps> = {}) =>
  renderToStaticMarkup(<DraftCard proposal={p} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} {...over} />);

describe("DraftCard", () => {
  it("previews a comment with approve, edit and skip, and a way to jump to its item", () => {
    const out = card(proposal({}), { onShow: vi.fn() });
    expect(out).toContain("Comment on DEVOPS-471");
    expect(out).toContain("Looks good.");
    for (const label of ["Post comment", "Edit", "Skip", "Show me"]) expect(out).toContain(label);
  });

  it("previews a transition with the target status", () => {
    const out = card(proposal({ intent: { type: "transition", item: { connectionId: "mock", externalId: "DEVOPS-471", key: "DEVOPS-471" }, to: "done" }, label: "Done" }), { statusName: "Done" });
    expect(out).toContain("Move DEVOPS-471");
    expect(out).toContain("<b>Done</b>");
  });

  it("lists subtasks as checkboxes and counts the ones it will create", () => {
    const out = card(proposal({ intent: { type: "subtasks", parent: { connectionId: "mock", externalId: "WEB-108", key: "WEB-108" }, summaries: ["One", "Two"] } }));
    expect(out.match(/type="checkbox"/g)).toHaveLength(2);
    expect(out).toContain("Create 2 subtasks");
  });

  it("previews a new item", () => {
    const out = card(
      proposal({
        intent: { type: "create", container: { connectionId: "mock", externalId: "DEVOPS" }, link: null, fields: { title: "Rotate keys", body: docFromText("Every quarter."), kind: "task", assignee: null, parent: null, priority: null, labels: [] } },
      }),
    );
    expect(out).toContain("New task");
    expect(out).toContain("Rotate keys");
    expect(out).toContain("Create task");
  });

  it("offers no buttons once it is decided, and says why a draft went stale", () => {
    const done = card(proposal({ state: { type: "applied" } }));
    expect(done).toContain("Done");
    expect(done).not.toContain("Skip");
    expect(card(proposal({ state: { type: "retired", reason: "the ticket moved on" } }))).toContain("the ticket moved on");
  });

  it("shows why an approval failed", () => {
    expect(card(proposal({}), { error: "Jira said no" })).toContain("Jira said no");
  });

  it("titles and summarises each kind for lists", () => {
    const t = proposal({ intent: { type: "transition", item: { connectionId: "mock", externalId: "A-1", key: "A-1" }, to: "x" }, label: "Ship it" });
    expect(draftTitle(t)).toBe("Move A-1");
    expect(draftSummary(t, "Done")).toBe("to Done");
    expect(draftSummary(proposal({}), null)).toBe("Looks good.");
  });
});

describe("PeekView", () => {
  const item = () => ws().items["mock:DEVOPS-473"];
  const view = (over: Partial<PeekViewProps> = {}) =>
    renderToStaticMarkup(
      <PeekView
        item={item()}
        assignee="Jonas Berg"
        now={new Date("2026-09-30T12:00:00Z")}
        moves={[]}
        menuOpen={false}
        links={[]}
        comments={[]}
        history={[]}
        description={<p>Body text</p>}
        drafts={null}
        composer={<textarea aria-label="composer" />}
        notice={null}
        onMenu={vi.fn()}
        onMove={vi.fn()}
        onLink={vi.fn()}
        onClose={vi.fn()}
        {...over}
      />,
    );

  it("shows the header facts and a labelled region", () => {
    const out = view();
    expect(out).toContain('aria-label="Details for DEVOPS-473"');
    expect(out).toContain(item().title);
    expect(out).toContain("Blocked");
    expect(out).toContain("Jonas Berg");
    expect(out).toContain("Body text");
    expect(out).toContain("No comments yet.");
  });

  it("offers the valid moves in a menu, as drafts", () => {
    const moves = [{ id: "s2", name: "In Progress", category: "active" as const }];
    const closed = view({ moves });
    expect(closed).toContain('aria-haspopup="menu"');
    expect(closed).not.toContain('role="menu"');
    const open = view({ moves, menuOpen: true });
    expect(open).toContain("Draft a move to");
    expect(open).toContain('role="menuitem"');
  });

  it("disables the status chip when no moves are known", () => {
    expect(view()).toMatch(/<button[^>]*disabled[^>]*>Blocked/);
  });

  it("renders links, comments and history", () => {
    const out = view({
      links: [{ kind: "blockedBy", label: "Blocked by", ref: { connectionId: "mock", externalId: "DEVOPS-490", key: "DEVOPS-490" }, title: "Second client" }],
      comments: [{ id: "c", at: "2026-09-30T11:00:00Z", who: "Sam", text: "Hello there" }],
      history: [{ id: "h", at: "2026-09-29T11:00:00Z", who: "Sam", text: "moved it To Do → Blocked" }],
    });
    expect(out).toContain("Blocked by");
    expect(out).toContain("DEVOPS-490");
    expect(out).toContain("Hello there");
    expect(out).toContain("moved it To Do → Blocked");
  });

  it("puts pending drafts inline, above the description", () => {
    const out = view({ drafts: <div id="inline-drafts">drafts</div> });
    expect(out.indexOf("inline-drafts")).toBeLessThan(out.indexOf("Body text"));
  });
});

describe("Pip pane parts", () => {
  it("shows what Pip sees and the open item", () => {
    const out = renderToStaticMarkup(<ContextChip kind="Ticket" label="DEVOPS-471 · Rotate keys" following open={false} onToggle={vi.fn()} />);
    expect(out).toContain("Ticket");
    expect(out).toContain("DEVOPS-471 · Rotate keys");
    expect(out).toContain('aria-expanded="false"');
  });

  it("previews a draft on any item as a card that opens its ticket, and a new-item draft as one to review", () => {
    const on = renderToStaticMarkup(<DraftPreview proposal={proposal({})} statusName={null} targetTitle="Rotate keys" onOpen={vi.fn()} />);
    expect(on).toContain("Review on DEVOPS-471");
    expect(on).toContain("Rotate keys");
    const create = proposal({
      intent: { type: "create", container: { connectionId: "mock", externalId: "DEVOPS" }, link: null, fields: { title: "New thing", body: { blocks: [] }, kind: "task", assignee: null, parent: null, priority: null, labels: [] } },
    });
    expect(renderToStaticMarkup(<DraftPreview proposal={create} statusName={null} targetTitle={null} onOpen={vi.fn()} />)).toContain("Review draft");
  });

  it("draws the avatar with its own gradient ids", () => {
    const one = renderToStaticMarkup(<PipAvatar />);
    expect(one).toContain("<svg");
    expect(one).toContain('aria-hidden="true"');
  });

  it("says Pip filtered the view, with undo", () => {
    const out = renderToStaticMarkup(
      <PipFilterNote filtered={{ tabId: "t", before: { type: "and", filters: [] }, beforeTitle: null, filter: { type: "blocked" }, note: "Blocked tickets" }} onUndo={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(out).toContain("Pip filtered this view");
    expect(out).toContain("Blocked tickets");
    expect(out).toContain("Undo");
    expect(renderToStaticMarkup(<FilterNote />)).toBe("");
  });

  it("shows the nudge beside the launcher with a way to dismiss it", () => {
    const out = renderToStaticMarkup(<Launcher drafts={2} onOpen={vi.fn()} nudge={<Nudge text="I can help you filter tasks in this view." onOpen={vi.fn()} onDismiss={vi.fn()} />} />);
    expect(out).toContain("I can help you filter tasks in this view.");
    expect(out).toContain("Dismiss suggestion");
    expect(out).toContain("2 drafts waiting");
  });
});

describe("WorkDocView", () => {
  it("renders blocks, marks and lists", () => {
    const out = renderToStaticMarkup(
      <WorkDocView
        doc={{
          blocks: [
            { type: "paragraph", content: [{ type: "text", text: "bold", marks: ["bold"] }, { type: "lineBreak" }, { type: "mention", person: { connectionId: "m", accountId: "a" }, name: "Sam" }] },
            { type: "list", ordered: false, items: [[{ type: "paragraph", content: [{ type: "text", text: "one", marks: [] }] }]] },
            { type: "code", language: null, text: "x = 1" },
          ],
        }}
      />,
    );
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("@Sam");
    expect(out).toContain("<li>");
    expect(out).toContain("x = 1");
  });
});
