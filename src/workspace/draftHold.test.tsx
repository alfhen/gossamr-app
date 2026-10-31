import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import { docFromText } from "../lib/docs";
import type { ConnectionInfo, Proposal } from "../types";
import { useWorkspace } from "../workspaceStore";
import { DraftCard } from "./DraftCard";
import { heldNote } from "../lib/proposals";
import { needGroups, needs } from "../lib/needs";
import { batchCommands, contextCommands, type ContextDeps } from "./contextCommands";
import { DraftPeekView } from "./DraftPeek";
import { DraftPreview } from "./DraftPreview";
import { fieldsOf } from "./draftTicket";
import { keyPlan } from "./needsActions";
import { postsAs } from "./draftHold";
import { sample } from "./reviewSample";
import { ReviewDraft } from "./ReviewDraft";
import { batchable } from "./workViewLogic";

const github: ConnectionInfo = { id: "github:ada", instanceId: "github", displayName: "GitHub", enabled: true, kind: "github", workspace: "ada", url: null, account: "Ada Example", lastSyncAt: null, syncing: false, error: null, transient: false, reauth: false, status: null, rechecking: false };
const jira: ConnectionInfo = { ...github, id: "jira:c:u", instanceId: "jira", displayName: "Acme Jira", kind: "jira", workspace: "acme.atlassian.net", account: "Alf Henderson" };
const sampleData: ConnectionInfo = { ...github, id: "mock", instanceId: "jira", displayName: "Sample data", kind: "mock" };

const base: Proposal = { id: "p1", createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z", origin: { type: "board" }, createdBy: "user", intent: { type: "comment", item: { ...itemRef("CA-1"), connectionId: jira.id }, body: docFromText("Hi") }, label: null, basis: null, state: { type: "pending" }, revisions: [], created: [], error: null, run: null };
const review: Proposal = { ...base, id: "r1", intent: { type: "githubReview", connectionId: github.id, item: null, runId: "run-1", repo: "acme/webshop", number: 218, commitSha: "a1b2c3d4e5f6", summary: "Looks fine.", comments: [] } };

const withComments: Proposal = { ...review, intent: { ...review.intent, comments: [{ path: "src/a.ts", line: 4, side: "RIGHT", body: "Why?" }, { path: "src/b.ts", line: 9, side: "RIGHT", body: "Nit." }] } as Proposal["intent"] };

describe("a draft whose connection is off", () => {
  it("waits, and says so in the words the backend refuses it with", () => {
    expect(heldNote(review, [{ ...github, enabled: false }])).toBe("GitHub is off. This draft waits until you turn it on.");
    expect(heldNote(base, [{ ...jira, displayName: "Work Jira", enabled: false }])).toBe("Work Jira is off. This draft waits until you turn it on.");
  });

  it("is not held while its connection is on, unknown, or the draft has been decided", () => {
    expect(heldNote(review, [github])).toBeNull();
    expect(heldNote(review, [])).toBeNull();
    expect(heldNote({ ...review, state: { type: "skipped" } }, [{ ...github, enabled: false }])).toBeNull();
  });

  it("follows the code host a review posts to, not the ticket it hangs on", () => {
    const onTicket: Proposal = { ...review, intent: { ...(review.intent as Extract<Proposal["intent"], { type: "githubReview" }>), item: { ...itemRef("CA-1"), connectionId: jira.id } } };
    expect(heldNote(onTicket, [jira, { ...github, enabled: false }])).not.toBeNull();
    expect(heldNote(onTicket, [{ ...jira, enabled: false }, github])).toBeNull();
  });
});

describe("a draft whose connection was turned back on", () => {
  it("waits for the first sync, and says so in the words the backend refuses it with", () => {
    expect(heldNote(review, [{ ...github, rechecking: true }])).toBe("Checking this draft against GitHub.");
    expect(heldNote(base, [{ ...jira, displayName: "Work Jira", rechecking: true }])).toBe("Checking this draft against Work Jira.");
  });

  it("says it is off, not that it is being checked, when it is off again", () => {
    expect(heldNote(review, [{ ...github, enabled: false, rechecking: true }])).toBe("GitHub is off. This draft waits until you turn it on.");
  });

  it("is let go when the sync has finished or the draft has been decided", () => {
    expect(heldNote(review, [{ ...github, rechecking: false }])).toBeNull();
    expect(heldNote({ ...review, state: { type: "skipped" } }, [{ ...github, rechecking: true }])).toBeNull();
  });
});

describe("the account a draft posts as", () => {
  it("names the GitHub login or the Jira person, and the connection", () => {
    expect(postsAs(review, [github])).toBe("Posts as ada via GitHub");
    expect(postsAs(base, [jira])).toBe("Posts as Alf Henderson via Acme Jira");
  });

  it("says nothing for the sample, which sends nothing, or for a draft that is decided", () => {
    expect(postsAs({ ...base, intent: { ...base.intent, item: itemRef("CA-1") } as Proposal["intent"] }, [sampleData])).toBeNull();
    expect(postsAs({ ...review, state: { type: "applied" } } as Proposal, [github])).toBeNull();
  });
});

describe("the cards of a draft that waits", () => {
  beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));
  afterEach(() => {
    vi.unstubAllGlobals();
    seen([]);
  });
  /** The server render reads the store's initial state, so that is where the connections go. */
  const seen = (connections: ConnectionInfo[]) => {
    useWorkspace.setState({ connections });
    Object.assign(useWorkspace.getInitialState(), { connections });
  };

  const props = { statusName: null, people: [], working: false, error: null, onApprove: vi.fn(), onSkip: vi.fn() };
  const approve = (html: string) => html.match(/<button[^>]*>Approve<\/button>/)?.[0] ?? "";

  it("show who a draft posts as, and keep Approve live", () => {
    seen([jira]);
    const html = renderToStaticMarkup(<DraftCard proposal={base} {...props} />);
    expect(html).toContain("Posts as Alf Henderson via Acme Jira");
    expect(approve(html)).not.toContain("disabled");
  });

  it("show the wait in place of the account and turn Approve off, on a comment and on a review", () => {
    seen([{ ...jira, enabled: false }, { ...github, enabled: false }]);
    const comment = renderToStaticMarkup(<DraftCard proposal={base} {...props} />);
    expect(comment).toContain("Acme Jira is off. This draft waits until you turn it on.");
    expect(comment).not.toContain("Posts as");
    expect(approve(comment)).toContain("disabled");
    const post = renderToStaticMarkup(<ReviewDraft proposal={review} {...props} access={{ canPost: true, reason: null }} diff={sample()} />);
    expect(post).toContain("GitHub is off. This draft waits until you turn it on.");
    expect(approve(post)).toContain("disabled");
  });

  it("head a review Waiting and say once that GitHub is off, not that each comment's diff couldn't be read", () => {
    seen([{ ...github, enabled: false }]);
    const error = { status: "error" as const, error: "GitHub is off, so acme/webshop isn't read." };
    const post = renderToStaticMarkup(<ReviewDraft proposal={withComments} {...props} access={{ canPost: true, reason: null }} diff={error} />);
    expect(post).toContain("Waiting");
    expect(post).not.toContain("Needs your approval");
    expect(post).not.toContain("Couldn&#x27;t read the diff");
    expect(post.match(/ is off<\/p>/g)).toHaveLength(1);
    seen([github]);
    const live = renderToStaticMarkup(<ReviewDraft proposal={withComments} {...props} access={{ canPost: true, reason: null }} diff={error} />);
    expect(live).toContain("Needs your approval");
    expect(live).toContain("Couldn&#x27;t read the diff: GitHub is off");
  });

  it("show how old the draft is beside the wait", () => {
    vi.useFakeTimers({ now: new Date("2026-10-04T10:00:00Z"), toFake: ["Date"] });
    seen([{ ...jira, rechecking: true }, { ...github, rechecking: true }]);
    const comment = renderToStaticMarkup(<DraftCard proposal={base} {...props} />);
    expect(comment).toContain("Checking this draft against Acme Jira. Made 3 days ago.");
    expect(approve(comment)).toContain("disabled");
    const post = renderToStaticMarkup(<ReviewDraft proposal={review} {...props} access={{ canPost: true, reason: null }} diff={sample()} />);
    expect(post).toContain("Checking this draft against GitHub. Made 3 days ago.");
    expect(approve(post)).toContain("disabled");
    vi.useRealTimers();
  });

  it("are left out of Approve N safe drafts", () => {
    seen([{ ...jira, enabled: false }]);
    expect(batchable([base])).toEqual([]);
    seen([{ ...jira, rechecking: true }]);
    expect(batchable([base])).toEqual([]);
    seen([jira]);
    expect(batchable([base]).map((p) => p.id)).toEqual(["p1"]);
  });

  it("follow the connections the step rail was drawn with, not only what the store holds now", () => {
    seen([jira]);
    expect(batchable([base], [{ ...jira, enabled: false }])).toEqual([]);
  });
});

describe("every way to approve a draft that waits", () => {
  beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));
  afterEach(() => {
    vi.unstubAllGlobals();
    seen([]);
  });
  const seen = (connections: ConnectionInfo[]) => {
    useWorkspace.setState({ connections, proposals: {} });
    Object.assign(useWorkspace.getInitialState(), { connections });
  };
  const comment = (id: string, text: string): Proposal => ({ ...base, id, intent: { ...base.intent, body: docFromText(text) } as Proposal["intent"] });
  const drafts = [comment("c1", "One"), comment("c2", "Two"), comment("c3", "Three")];
  const listed = (connections: ConnectionInfo[], proposals = drafts) => needs({ workstreams: [], runs: [], proposals, dismissed: new Set(), connections });
  const deps = (): ContextDeps => ({ needAct: vi.fn(), openInWorkstream: vi.fn(), approveDraft: vi.fn(), openDraft: vi.fn(), skipDraft: vi.fn(), draftInWorkstream: vi.fn(), openRun: vi.fn(), pause: vi.fn(), resume: vi.fn(), openWorkstream: vi.fn(), approveSafe: vi.fn() });

  it("leaves a held draft out of the Needs you batch and the palette's batch entry", () => {
    const held = [{ ...jira, enabled: false }];
    expect(needGroups(listed([jira]))[0].safeBatch).toHaveLength(3);
    expect(needGroups(listed(held))[0].safeBatch).toHaveLength(0);
    expect(batchCommands(needGroups(listed([jira])), { approveSafe: vi.fn() })).toHaveLength(1);
    expect(batchCommands(needGroups(listed(held)), { approveSafe: vi.fn() })).toEqual([]);
  });

  it("counts only the drafts that are not held when one connection of two is off", () => {
    const other: Proposal = { ...comment("c4", "Four"), intent: { ...base.intent, item: { ...itemRef("CB-1"), connectionId: "jira:d:v" }, body: docFromText("Four") } as Proposal["intent"] };
    const connections = [{ ...jira, enabled: false }, { ...jira, id: "jira:d:v", instanceId: "jira_2" }];
    expect(needGroups(listed(connections, [...drafts, other]))[0].safeBatch.map((n) => n.key)).toEqual(["draft:c4"]);
  });

  it("makes a on a held draft open its card, and approves in place once the connection is on", () => {
    seen([{ ...jira, enabled: false }]);
    useWorkspace.setState({ proposals: { c1: drafts[0] } });
    const need = listed([jira], [drafts[0]])[0];
    expect(keyPlan(need, "approve")).toEqual({ type: "open", edit: false });
    seen([jira]);
    useWorkspace.setState({ proposals: { c1: drafts[0] } });
    expect(keyPlan(need, "approve")).toMatchObject({ type: "ask" });
  });

  it("offers Review and approve in the palette in place of Approve this draft while it waits", () => {
    const entries = () => contextCommands({ type: "draft", id: "c1" }, { needs: [], proposals: { c1: drafts[0] }, runs: [], workstreams: [] }, deps()).map((c) => c.label);
    seen([jira]);
    expect(entries()[0]).toBe("Approve this draft");
    seen([{ ...jira, enabled: false }]);
    expect(entries()[0]).toBe("Review and approve this draft");
  });

  it("shows the wait on the compact card in the conversation and keeps its key from approving", () => {
    seen([{ ...jira, enabled: false }]);
    const html = renderToStaticMarkup(<DraftPreview proposal={base} statusName={null} targetTitle={null} onOpen={vi.fn()} onApprove={vi.fn()} onSkip={vi.fn()} />);
    expect(html).toContain("Acme Jira is off. This draft waits until you turn it on.");
    seen([jira]);
    const live = renderToStaticMarkup(<DraftPreview proposal={base} statusName={null} targetTitle={null} onOpen={vi.fn()} onApprove={vi.fn()} onSkip={vi.fn()} />);
    expect(live).toContain("Posts as Alf Henderson via Acme Jira");
  });

  it("turns Create off on a ticket draft that waits, and says why", () => {
    const create: Proposal = { ...base, id: "n1", intent: { type: "create", container: { connectionId: jira.id, externalId: "DEVOPS" }, fields: { title: "Rotate the keys", body: docFromText("Soon."), kind: "task", assignee: null, parent: null, priority: null, labels: [] }, link: null } };
    const view = () => renderToStaticMarkup(<DraftPeekView proposal={create as never} fields={fieldsOf(create as never)} containers={[]} people={[]} working={false} error={null} onChange={vi.fn()} onCommit={vi.fn()} onCreate={vi.fn()} onSkip={vi.fn()} onClose={vi.fn()} />);
    const button = (html: string) => html.match(/<button[^>]*>Create task[\s\S]*?<\/button>/)?.[0] ?? "";
    seen([jira]);
    expect(button(view())).not.toContain("disabled");
    expect(view()).toContain("Posts as Alf Henderson via Acme Jira");
    seen([{ ...jira, enabled: false }]);
    expect(button(view())).toContain("disabled");
    expect(view()).toContain("Acme Jira is off. This draft waits until you turn it on.");
  });
});
