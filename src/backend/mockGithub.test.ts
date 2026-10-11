import { describe, expect, it, vi } from "vitest";
import { REVIEW_CHANGED, REVIEW_MAYBE_POSTED_NOTE, REVIEW_NOT_FOUND_NOTE, REVIEW_OUTDATED_NOTE } from "../lib/proposals";
import type { Intent, RunSpec } from "../types";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import type { MockOptions } from "./mockWatch";

const GH = "github:ada";

describe("the mock GitHub connection", () => {
  it("is signed out until a sign-in command runs", async () => {
    const b = new MockBackend();
    expect((await b.connectionsList()).map((c) => c.kind)).toEqual(["mock"]);
    expect(await b.watchGet()).toHaveLength(1);
    expect(await b.githubSignInOptions()).toEqual({ deviceFlow: true, ghCli: true, token: true });
  });

  it("connects with a pasted token, refuses a bad one, and lists 14 repositories that wait for a choice", async () => {
    const b = new MockBackend();
    await expect(b.githubConnectToken("bad")).rejects.toThrow("didn't accept the token");
    await expect(b.githubConnectToken("  ")).rejects.toThrow();
    const connection = await b.githubConnectToken("ghp_x");
    expect([connection.id, connection.kind, connection.workspace]).toEqual([GH, "github", "ada"]);
    expect((await b.connectionsList()).map((c) => c.id)).toEqual(["mock", GH]);
    const state = (await b.watchGet()).find((s) => s.connectionId === GH)!;
    expect([state.mode, state.needsChoice, state.catalogSize]).toEqual(["unset", true, 13]);
  });

  it("connects through the gh import and the device flow, which must be started before it is polled", async () => {
    const gh = new MockBackend();
    expect((await gh.githubImportGhToken()).id).toBe(GH);

    const device = new MockBackend();
    await expect(device.githubDevicePoll()).rejects.toThrow("start signing in first");
    const start = await device.githubDeviceStart();
    expect([start.userCode, start.verificationUri]).toEqual(["WDJB-MJHT", "https://github.com/login/device"]);
    expect((await device.githubDevicePoll()).id).toBe(GH);
  });

  it("starts signed in with the requested number of repositories, at least the six samples", async () => {
    const big = new MockBackend({ githubRepos: 30 });
    expect((await big.watchCatalog(GH, "")).containers).toHaveLength(30);
    const small = new MockBackend({ githubRepos: 2 });
    expect((await small.watchCatalog(GH, "")).containers).toHaveLength(6);
    const [, state] = await small.watchGet();
    expect([state.mode, state.needsChoice]).toEqual(["everything", false]);
    const twelve = await new MockBackend({ githubRepos: 12 }).watchGet();
    expect(twelve[1].mode).toBe("everything");
    expect((await new MockBackend({ githubRepos: 13 }).watchGet())[1].mode).toBe("unset");
  });

  it("lists repositories like GitHub does: owner/name keys, permission, archived, most recently pushed first", async () => {
    const b = new MockBackend({ githubRepos: 14 });
    const first = await b.watchCatalog(GH, "");
    expect(first.containers[0]).toMatchObject({ key: "acme/webshop", name: "webshop", kind: "push", archived: false });
    expect(first.containers.find((c) => c.name === "legacy-admin")).toMatchObject({ archived: true, kind: "pull" });
    expect(first.containers.map((c) => c.lastActive)).toEqual([...first.containers.map((c) => c.lastActive)].sort().reverse());
    expect((await b.watchCatalog(GH, "gate")).containers.map((c) => c.key)).toEqual(["acme/gateway"]);
  });

  it("pages a big catalog fifty at a time", async () => {
    const b = new MockBackend({ githubRepos: 120 });
    const first = await b.watchCatalog(GH, "");
    expect([first.containers.length, first.next]).toEqual([50, "50"]);
    expect((await b.watchCatalog(GH, "", "100")).next).toBeNull();
  });

  it("watches what the person picks, without touching the Jira watch set", async () => {
    const b = new MockBackend({ githubRepos: 14 });
    const changed = vi.fn();
    const off = b.onWatchChanged(changed);
    await b.watchSetMode(GH, "selected");
    await b.watchSetContainers(GH, [{ containerId: "acme/gateway", watched: true, source: "footprint" }]);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed.mock.calls[0][0]).toEqual({ connectionId: GH });
    const [jira, github] = await b.watchGet();
    expect(jira.mode).toBe("everything");
    expect([github.mode, github.watches.map((w) => [w.container.externalId, w.name, w.source])]).toEqual(["selected", [["acme/gateway", "gateway", "footprint"]]]);
    const page = await b.watchCatalog(GH, "");
    expect(page.containers.filter((c) => c.watched).map((c) => c.key)).toEqual(["acme/gateway"]);
    off();
  });

  it("suggests the repositories the person was active in", async () => {
    const b = new MockBackend({ githubRepos: 14 });
    const rows = await b.watchSuggestions(GH);
    expect(rows.map((r) => r.key)).toEqual(["acme/webshop", "acme/gateway", "acme/storefront", "acme/infra"]);
    expect(rows[0]).toMatchObject({ reported: 2, assigned: 1 });
    expect(await b.watchUnwatchedAssigned(GH)).toEqual([]);
    expect((await b.watchSuggestions()).every((r) => !r.key.startsWith("acme/"))).toBe(true);
  });

  it("forgets the account on disconnect", async () => {
    const b = new MockBackend({ githubRepos: 14 });
    const changed = vi.fn();
    b.onWatchChanged(changed);
    await b.githubDisconnect(GH);
    expect((await b.connectionsList()).map((c) => c.id)).toEqual(["mock"]);
    expect(await b.watchGet()).toHaveLength(1);
    expect(changed).toHaveBeenCalledWith({ connectionId: GH });
  });
});

describe("posting a review draft to the mock GitHub", () => {
  const spec: RunSpec = { kind: "review", repo: "acme/webshop", clonePath: "/Users/sample/Code/webshop", base: "main", name: "ca-402-review", instruction: "", pr: 218, focus: null, focusFromRun: null, ticketBlock: "CA-402: sample" };

  /** A backend whose review of #218 has finished, and the GitHub review draft it left. */
  async function reviewed(options: MockOptions = {}) {
    const backend = new MockBackend({ githubRepos: 14, ...options });
    await backend.watchSetMode(GH, "everything");
    const made = await backend.runsDraft(spec, itemRef("CA-402"));
    const run = await backend.runsApprove(made.id, (await backend.runsReview(made.id)).digest);
    for (let i = 0; i < 3; i++) backend.runs.advance(run.id);
    const draft = backend.proposals.list().find((p) => p.intent.type === "githubReview")!;
    return { backend, draft, intent: draft.intent as Extract<Intent, { type: "githubReview" }> };
  }

  it("posts exactly one comment review with the draft's comments, once, and writes nothing to Jira", async () => {
    const { backend, draft, intent } = await reviewed();
    expect(backend.github.writes).toEqual([]);
    expect(await backend.codeReviewAccess(GH, "acme/webshop")).toEqual({ canPost: true, reason: null });
    const posted = await backend.proposalsPostReview(draft.id, draft.revisions.length);
    expect(posted.state.type).toBe("applied");
    expect(posted.posted?.url).toMatch(/^https:\/\/github\.com\/acme\/webshop\/pull\/218#pullrequestreview-\d+$/);
    expect(backend.github.writes).toEqual([{ proposalId: draft.id, repo: "acme/webshop", number: 218, event: "COMMENT", commitId: "a1b2c3d4e5f6", body: intent.summary, comments: intent.comments, id: posted.posted!.id }]);
    expect(backend.github.writes[0].comments.map((c) => `${c.path}:${c.line}`)).toEqual(["src/consumer/retry.ts:42", "src/consumer/retry.ts:17"]);
    await expect(backend.proposalsPostReview(draft.id, draft.revisions.length)).rejects.toThrow("that draft is applied");
    expect(backend.github.writes).toHaveLength(1);
    expect(backend.proposals.writes).toEqual([]);
  });

  it("refuses with GitHub's 403 when the token can't write, and remembers it", async () => {
    const { backend, draft } = await reviewed({ reviewAccess: "none" });
    const access = await backend.codeReviewAccess(GH, "acme/webshop");
    expect(access.canPost).toBe(false);
    expect(access.reason).toBe("This GitHub token can't post reviews on acme/webshop (it lacks write access to its pull requests).");
    const back = await backend.proposalsPostReview(draft.id, draft.revisions.length);
    expect(back.state.type).toBe("pending");
    expect(back.error).toContain("the token can't write to pull requests in acme/webshop");
    expect(backend.github.writes).toEqual([]);
  });

  it("can't post on a repository the sample can only read", async () => {
    const backend = new MockBackend({ githubRepos: 14 });
    await backend.watchSetMode(GH, "everything");
    expect((await backend.codeReviewAccess(GH, "acme/mobile-app")).canPost).toBe(false);
    expect((await backend.codeReviewAccess(GH, "acme/gateway")).canPost).toBe(true);
  });

  it("refuses with GitHub's 422 once a force-push took the reviewed commit out of the pull request, leaving the draft outdated", async () => {
    const { backend, draft } = await reviewed();
    expect(backend.movePullHead("acme/webshop", 218)).toBe(true);
    expect(backend.github.code.headSha("acme/webshop", 218)).not.toBe("a1b2c3d4e5f6");
    const back = await backend.proposalsPostReview(draft.id, draft.revisions.length);
    expect([back.state.type, back.error]).toEqual(["pending", REVIEW_OUTDATED_NOTE]);
    expect(backend.github.writes).toEqual([]);
  });

  it("posts a review whose pull request's head merely moved on, at the commit it read, as GitHub takes it", async () => {
    const { backend, draft } = await reviewed();
    const change = backend.github.code.change("acme/webshop", 218)!;
    backend.github.code.addPullRequest({ ...change, sha: "f00dfeed0000" });
    expect((await backend.proposalsPostReview(draft.id, draft.revisions.length)).state.type).toBe("applied");
    expect(backend.github.writes.map((w) => w.commitId)).toEqual(["a1b2c3d4e5f6"]);
  });

  it("refuses a review Pip revised since the person looked at it, and posts nothing", async () => {
    const { backend, draft } = await reviewed();
    await backend.pipRevise(draft.id, { body: "Pip's summary." });
    await expect(backend.proposalsPostReview(draft.id, draft.revisions.length)).rejects.toThrow(REVIEW_CHANGED);
    expect(backend.github.writes).toEqual([]);
    expect(backend.proposals.get(draft.id)?.state.type).toBe("pending");
  });

  it("keeps a post whose answer was lost as maybe posted through an edit, and finds the review sent with the old summary instead of sending it again", async () => {
    const { backend, draft, intent } = await reviewed();
    backend.github.loseNextAnswer(true);
    const back = await backend.proposalsPostReview(draft.id, 0);
    expect(back.state.type).toBe("pending");
    expect(back.error?.startsWith(REVIEW_MAYBE_POSTED_NOTE)).toBe(true);
    expect(back.maybePosted).toMatchObject({ commitSha: "a1b2c3d4e5f6", summary: intent.summary, checkedAt: null });
    const edited = await backend.proposalsEdit(draft.id, { type: "githubReview", summary: "My own words." });
    expect([edited.error, edited.maybePosted]).toEqual([null, back.maybePosted]);
    const done = await backend.proposalsPostReview(draft.id, edited.revisions.length);
    expect([done.state.type, done.posted?.id, done.maybePosted]).toEqual(["applied", backend.github.writes[0].id, null]);
    expect(backend.github.writes.map((w) => w.body)).toEqual([intent.summary]);
    expect(backend.github.tried).toBe(1);
  });

  it("holds a maybe posted review GitHub doesn't show until the person posts anyway, then sends it once", async () => {
    const { backend, draft } = await reviewed();
    backend.github.loseNextAnswer(false);
    await backend.proposalsPostReview(draft.id, 0);
    const held = await backend.proposalsPostReview(draft.id, 0);
    expect([held.state.type, held.error]).toEqual(["pending", REVIEW_NOT_FOUND_NOTE]);
    expect(held.maybePosted?.checkedAt).toBeTruthy();
    expect(backend.github.tried).toBe(1);
    const done = await backend.proposalsPostReview(draft.id, 0, true);
    expect([done.state.type, done.maybePosted]).toEqual(["applied", null]);
    expect([backend.github.tried, backend.github.writes.length]).toEqual([2, 1]);
  });

  it("serves every sample pull request's diff for the PR view, with the files, additions and deletions its stats say", async () => {
    const { backend } = await reviewed();
    for (const change of backend.github.code.changes.filter((c) => c.kind === "pullRequest")) {
      const { files } = await backend.codePullDiff(GH, change.repo, change.number!);
      expect([files.length, files.reduce((n, f) => n + f.additions, 0), files.reduce((n, f) => n + f.deletions, 0)], `${change.repo}#${change.number}`).toEqual([change.changedFiles, change.additions, change.deletions]);
      expect(files.every((f) => f.patch?.startsWith("@@ "))).toBe(true);
    }
  });

  it("serves the pull request's files to the card and the PR view", async () => {
    const { backend } = await reviewed();
    expect((await backend.codePullFiles(GH, "acme/webshop", 218)).map((f) => f.path)).toEqual(["src/consumer/retry.ts", "src/consumer/index.ts"]);
    await expect(backend.codePullFiles(GH, "acme/webshop", 999)).rejects.toThrow("couldn't find pull request #999");
  });
});
