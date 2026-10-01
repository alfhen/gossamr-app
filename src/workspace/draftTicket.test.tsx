import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { docFromText } from "../lib/docs";
import type { ContainerRef, Proposal, WorkContainer } from "../types";
import { useWorkspace } from "../workspaceStore";
import { DraftPeekView, type DraftPeekViewProps } from "./DraftPeek";
import { createdItemKey, draftIdOf, draftItem, draftKey, draftSections, editFor, fieldsOf, showsAsDraftTicket } from "./draftTicket";
import { useTabs } from "./tabsStore";

const container = (id: string): ContainerRef => ({ connectionId: "mock", externalId: id });

const create = (over: Partial<Proposal> = {}) =>
  ({
    id: "p1",
    createdAt: "2026-09-30T10:00:00Z",
    updatedAt: "2026-09-30T10:00:00Z",
    origin: { type: "chat", requestId: "r" },
    createdBy: "pip",
    intent: {
      type: "create",
      container: container("DEVOPS"),
      fields: { title: "Rotate the keys", body: docFromText("Do it before Friday."), kind: "task", assignee: null, parent: null, priority: null, labels: [] },
      link: null,
    },
    label: null,
    basis: null,
    state: { type: "pending" },
    revisions: [],
    created: [],
    error: null,
    ...over,
  }) as Proposal & { intent: Extract<Proposal["intent"], { type: "create" }> };

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));

describe("draft selection keys", () => {
  it("never read as an item key and give back the proposal id", () => {
    expect(draftKey("p1")).toBe("draft:p1");
    expect(draftIdOf(draftKey("p1"))).toBe("p1");
    expect(draftIdOf("mock:DEVOPS-1")).toBeNull();
    expect(draftIdOf(null)).toBeNull();
  });

  it("is what showing a draft selects, from any screen", () => {
    useTabs.setState({ route: "activity", selected: "mock:CA-1" });
    useTabs.getState().setRoute("workspace");
    useTabs.getState().select(draftKey("p1"));
    expect(useTabs.getState()).toMatchObject({ route: "workspace", selected: "draft:p1" });
  });
});

describe("which sections a draft ticket has", () => {
  it("keeps the description and hides everything that needs a ticket that exists", () => {
    expect(draftSections()).toEqual({ description: true, subtasks: false, links: false, development: false, comments: false, history: false, drafts: false });
  });

  it("shows only create drafts that are open or just created", () => {
    expect(showsAsDraftTicket(create())).toBe(true);
    expect(showsAsDraftTicket(create({ state: { type: "applied" } }))).toBe(true);
    expect(showsAsDraftTicket(create({ state: { type: "skipped" } }))).toBe(false);
    expect(showsAsDraftTicket(create({ state: { type: "retired", reason: "x" } }))).toBe(false);
    expect(showsAsDraftTicket({ ...create(), intent: { type: "transition", item: { connectionId: "mock", externalId: "A-1", key: "A-1" }, to: "x" } })).toBe(false);
    expect(showsAsDraftTicket(undefined)).toBe(false);
  });

  it("stands in for an item keyed NEW whose id cannot be looked up", () => {
    const item = draftItem(create());
    expect(item.item.key).toBe("NEW");
    expect(item.title).toBe("Rotate the keys");
    expect(draftIdOf(item.item.externalId)).toBe("p1");
  });
});

describe("the edit a change becomes", () => {
  const p = create();
  const same = fieldsOf(p);

  it("is nothing when nothing changed, however the text is padded", () => {
    expect(editFor(p, same)).toBeNull();
    expect(editFor(p, { ...same, title: "  Rotate the keys ", body: "Do it before Friday.\n" })).toBeNull();
  });

  it("names only what changed", () => {
    expect(editFor(p, { ...same, title: "Rotate the API keys" })).toEqual({ type: "create", title: "Rotate the API keys" });
    expect(editFor(p, { ...same, kind: "bug" })).toEqual({ type: "create", kind: "bug" });
    expect(editFor(p, { ...same, container: container("WEB") })).toEqual({ type: "create", container: container("WEB") });
  });

  it("sends the description with the mentions still in it", () => {
    const sam = { accountId: "sam", name: "Sam" };
    const edit = editFor(p, { ...same, body: "Ask @Sam first", mentions: [sam, { accountId: "gone", name: "Gone" }] });
    expect(edit).toEqual({ type: "create", body: "Ask @Sam first", mentions: [sam] });
  });

  it("reads the real ticket of an applied draft by its key", () => {
    expect(createdItemKey(create())).toBeNull();
    expect(createdItemKey(create({ state: { type: "applied" }, created: [{ connectionId: "mock", externalId: "DEVOPS-9", key: "DEVOPS-9" }] }))).toBe("mock:DEVOPS-9");
  });
});

describe("the draft ticket in the peek sheet", () => {
  const containers: WorkContainer[] = [
    { ref: container("DEVOPS"), key: "DEVOPS", name: "DevOps", workflow: { statuses: [], transitions: [] } as never },
    { ref: container("WEB"), key: "WEB", name: "Webshop", workflow: { statuses: [], transitions: [] } as never },
  ];
  const view = (p = create(), over: Partial<DraftPeekViewProps> = {}) =>
    renderToStaticMarkup(
      <DraftPeekView proposal={p} fields={fieldsOf(p)} containers={containers} people={[]} working={false} error={null} onChange={vi.fn()} onCommit={vi.fn()} onCreate={vi.fn()} onSkip={vi.fn()} onClose={vi.fn()} {...over} />,
    );

  it("says it is a draft that doesn't exist yet, outlined as drafts are, with NEW for the key", () => {
    const out = view();
    expect(out).toContain("New ticket draft");
    expect(out).toContain("not created yet");
    expect(out).toContain("outline-dashed");
    expect(out).toContain(">NEW<");
    expect(out).not.toContain("peek ·");
  });

  it("prefills the title, description, project and type from the proposal", () => {
    const out = view();
    expect(out).toMatch(/aria-label="Title"[^>]*value="Rotate the keys"|value="Rotate the keys"[^>]*aria-label="Title"/);
    expect(out).toContain("Do it before Friday.");
    expect(out).toMatch(/<option value="mock:DEVOPS" selected="">DEVOPS · DevOps<\/option>/);
    expect(out).toMatch(/<option value="task" selected="">task<\/option>/);
  });

  it("offers Create task and Skip, and has no comments, history, links or sections to jump to", () => {
    const out = view();
    expect(out).toContain("Create task");
    expect(out).toContain("Skip");
    for (const gone of ["Comments", "History", "Links", "Development", "Drafts waiting", 'aria-label="Sections"', "Draft comment"]) expect(out).not.toContain(gone);
  });

  it("names the kind on the button and holds it back while there is no title", () => {
    const p = create();
    expect(view(p, { fields: { ...fieldsOf(p), kind: "bug" } })).toContain("Create bug");
    expect(view(p, { fields: { ...fieldsOf(p), title: " " } })).toMatch(/<button[^>]*disabled[^>]*>Create task/);
  });

  it("shows the error and the last revision note", () => {
    expect(view(create(), { error: "Couldn't save" })).toContain("Couldn&#x27;t save");
    expect(view(create({ revisions: [{ at: "2026-09-30T10:05:00Z", note: "Revised by Pip", intent: create().intent }] }))).toContain("Revised by Pip");
  });

  it("locks the fields and drops the buttons once it is created", () => {
    const out = view(create({ state: { type: "applied" }, created: [{ connectionId: "mock", externalId: "DEVOPS-9", key: "DEVOPS-9" }] }));
    expect(out).toContain("Created DEVOPS-9");
    expect(out).toMatch(/aria-label="Title"[^>]*disabled/);
    expect(out).not.toContain("Create task");
  });
});

describe("approving a draft ticket in the sample backend", () => {
  it("applies the edit to the proposal and only creates the ticket on approval", async () => {
    const backend = new MockBackend();
    await useWorkspace.getState().init(backend);
    const before = Object.keys(useWorkspace.getState().items).length;
    const made = create();
    const stored = backend.proposals.draft(made.intent, null, "r");
    const edited = await backend.proposalsEdit(stored.id, { type: "create", title: "Rotate the API keys", kind: "bug" });
    expect(edited.intent).toMatchObject({ type: "create", fields: { title: "Rotate the API keys", kind: "bug" } });
    expect(edited.state.type).toBe("pending");
    expect((await backend.cacheSearch({ type: "and", filters: [] })).length).toBe(before);

    const done = await backend.proposalsApprove(stored.id);
    expect(done.state.type).toBe("applied");
    expect(done.created).toHaveLength(1);
    const items = await backend.cacheSearch({ type: "and", filters: [] });
    expect(items.find((i) => i.item.key === done.created[0].key)).toMatchObject({ title: "Rotate the API keys", kind: "bug" });
  });
});
