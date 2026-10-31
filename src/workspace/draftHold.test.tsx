import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import { docFromText } from "../lib/docs";
import type { ConnectionInfo, Proposal } from "../types";
import { useWorkspace } from "../workspaceStore";
import { DraftCard } from "./DraftCard";
import { heldNote } from "../lib/proposals";
import { postsAs } from "./draftHold";
import { sample } from "./reviewSample";
import { ReviewDraft } from "./ReviewDraft";
import { batchable } from "./workViewLogic";

const github: ConnectionInfo = { id: "github:ada", instanceId: "github", displayName: "GitHub", enabled: true, kind: "github", workspace: "ada", url: null, account: "Ada Example", lastSyncAt: null, syncing: false, error: null, transient: false, reauth: false, status: null };
const jira: ConnectionInfo = { ...github, id: "jira:c:u", instanceId: "jira", displayName: "Acme Jira", kind: "jira", workspace: "acme.atlassian.net", account: "Alf Henderson" };
const sampleData: ConnectionInfo = { ...github, id: "mock", instanceId: "jira", displayName: "Sample data", kind: "mock" };

const base: Proposal = { id: "p1", createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z", origin: { type: "board" }, createdBy: "user", intent: { type: "comment", item: { ...itemRef("CA-1"), connectionId: jira.id }, body: docFromText("Hi") }, label: null, basis: null, state: { type: "pending" }, revisions: [], created: [], error: null, run: null };
const review: Proposal = { ...base, id: "r1", intent: { type: "githubReview", connectionId: github.id, item: null, runId: "run-1", repo: "acme/webshop", number: 218, commitSha: "a1b2c3d4e5f6", summary: "Looks fine.", comments: [] } };

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

  it("are left out of Approve N safe drafts", () => {
    seen([{ ...jira, enabled: false }]);
    expect(batchable([base])).toEqual([]);
    seen([jira]);
    expect(batchable([base]).map((p) => p.id)).toEqual(["p1"]);
  });
});
