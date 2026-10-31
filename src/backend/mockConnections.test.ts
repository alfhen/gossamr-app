import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";

describe("the mock connection actions", () => {
  it("opens Terminal on the fix of the instance, and refuses one that has nothing to run", async () => {
    const b = new MockBackend({ githubRepos: 6, githubProbe: "notSignedIn" });
    await b.connectionOpenTerminal("github");
    expect(b.terminals).toEqual(["gh auth login -h github.com"]);
    await expect(b.connectionOpenTerminal("jira")).rejects.toThrow("nothing to run");
    await expect(b.connectionOpenTerminal("github_9")).rejects.toThrow("nothing to run");
    expect(b.terminals).toHaveLength(1);
  });

  it("renames an instance, trimmed, and tells the page", async () => {
    const b = new MockBackend({ githubRepos: 6 });
    let told = 0;
    b.onConnectionsChanged(() => told++);
    await b.connectionRename("github", "  Work GitHub ");
    expect((await b.connectionsList()).find((c) => c.instanceId === "github")?.displayName).toBe("Work GitHub");
    expect(told).toBe(1);
  });

  it("refuses an empty name and an instance that is gone", async () => {
    const b = new MockBackend({ githubRepos: 6 });
    await expect(b.connectionRename("github", "  ")).rejects.toThrow("name");
    await expect(b.connectionRename("github_9", "Work")).rejects.toThrow("gone");
    expect((await b.connectionsList()).find((c) => c.instanceId === "github")?.displayName).toBe("GitHub");
  });

  it("removes GitHub, closes the review drafts that post there with a reason, and never gives its id to the next account", async () => {
    const b = new MockBackend({ githubRepos: 6 });
    const draft = b.proposals.draft({ type: "githubReview", connectionId: "github:ada", item: null, runId: "r1", repo: "acme/webshop", number: 1, commitSha: "abcdef1", summary: "Fine.", comments: [] }, "Review from Pip");
    let told = 0;
    b.onConnectionsChanged(() => told++);
    await b.connectionRemove("github");
    expect((await b.connectionsList()).map((c) => c.instanceId)).toEqual(["jira"]);
    expect(b.proposals.get(draft.id)?.state).toEqual({ type: "retired", reason: "GitHub was removed." });
    expect(told).toBe(1);
    await b.githubConnect();
    expect((await b.connectionsList()).map((c) => c.instanceId)).toEqual(["jira", "github_2"]);
  });

  it("refuses to remove GitHub while one of its reviews is being posted, and leaves every draft as it was", async () => {
    const b = new MockBackend({ githubRepos: 6 });
    const review = { type: "githubReview" as const, connectionId: "github:ada", item: null, runId: "r1", repo: "acme/webshop", number: 1, commitSha: "abcdef1", summary: "Fine.", comments: [] };
    const posting = b.proposals.draft(review, "Review from Pip");
    const waiting = b.proposals.draft({ ...review, number: 2 }, "Review from Pip");
    void b.proposals.postReview(posting.id, 0, () => new Promise(() => {}), async () => null);
    await expect(b.connectionRemove("github")).rejects.toThrow("posting a draft for GitHub right now");
    expect(b.proposals.get(waiting.id)?.state).toEqual({ type: "pending" });
    expect((await b.connectionsList()).map((c) => c.instanceId)).toEqual(["jira", "github"]);
  });

  it("refuses the sample data and an instance that is gone", async () => {
    const b = new MockBackend({ githubRepos: 6 });
    await expect(b.connectionRemove("jira")).rejects.toThrow("built in");
    await expect(b.connectionRemove("github_9")).rejects.toThrow("gone");
    expect(await b.connectionsList()).toHaveLength(2);
  });
});

describe("the mock on/off switch", () => {
  const github = async (b: MockBackend) => (await b.connectionsList()).find((c) => c.instanceId === "github")!;

  it("turns GitHub off, so its row reads Off, and back on, so the probe answers again, telling the page each time", async () => {
    const b = new MockBackend({ githubRepos: 6 });
    let told = 0;
    b.onConnectionsChanged(() => told++);
    await b.connectionSetEnabled("github", false);
    expect(await github(b)).toMatchObject({ enabled: false, status: { state: "off" } });
    await b.connectionSetEnabled("github", true);
    expect(await github(b)).toMatchObject({ enabled: true, status: { state: "ready" } });
    expect(told).toBe(2);
  });

  it("brings back the state the probe was in, and turns on a connection whose probe was forced off", async () => {
    const b = new MockBackend({ githubRepos: 6, githubProbe: "notSignedIn" });
    await b.connectionSetEnabled("github", false);
    await b.connectionSetEnabled("github", true);
    expect((await github(b)).status?.state).toBe("notSignedIn");
    const forced = new MockBackend({ githubRepos: 6, githubProbe: "off" });
    expect((await github(forced)).enabled).toBe(false);
    await forced.connectionSetEnabled("github", true);
    expect(await github(forced)).toMatchObject({ enabled: true, status: { state: "ready" } });
  });

  it("refuses to turn off while a review is being posted, and refuses the sample data and a connection that is gone", async () => {
    const b = new MockBackend({ githubRepos: 6 });
    const draft = b.proposals.draft({ type: "githubReview", connectionId: "github:ada", item: null, runId: "r1", repo: "acme/webshop", number: 1, commitSha: "abcdef1", summary: "Fine.", comments: [] }, "Review from Pip");
    void b.proposals.postReview(draft.id, 0, () => new Promise(() => {}), async () => null);
    await expect(b.connectionSetEnabled("github", false)).rejects.toThrow("posting a draft for GitHub right now");
    expect((await github(b)).enabled).toBe(true);
    await expect(b.connectionSetEnabled("jira", false)).rejects.toThrow("built in");
    await expect(b.connectionSetEnabled("github_9", false)).rejects.toThrow("gone");
  });

  it("keeps a review for GitHub from being posted while GitHub is off, and sends it on once GitHub is on", async () => {
    const b = new MockBackend({ githubRepos: 6 });
    const draft = b.proposals.draft({ type: "githubReview", connectionId: "github:ada", item: null, runId: "r1", repo: "acme/webshop", number: 1, commitSha: "abcdef1", summary: "Fine.", comments: [] }, "Review from Pip");
    await b.connectionSetEnabled("github", false);
    await expect(b.proposalsPostReview(draft.id, 0)).rejects.toThrow("GitHub is off. This draft waits until you turn it on.");
    expect(b.proposals.get(draft.id)?.state).toEqual({ type: "pending" });
    await b.connectionSetEnabled("github", true);
    await expect(b.proposalsPostReview(draft.id, 0)).resolves.toBeDefined();
  });

  it("hides the code linked to a ticket while GitHub is off, tells the page, and shows it again on without asking GitHub", async () => {
    const b = new MockBackend({ githubRepos: 6 });
    const ticket = itemRef("CA-402");
    let told = 0;
    b.onDevLinksChanged(() => told++);
    const shown = (await b.devLinks(ticket)).length;
    expect(shown).toBeGreaterThan(0);
    await b.connectionSetEnabled("github", false);
    expect(await b.devLinks(ticket)).toEqual([]);
    expect(await b.devLinksLive(ticket)).toEqual([]);
    await expect(b.codePullRequest({ connectionId: "github:ada", repo: "acme/webshop", number: 212 })).rejects.toThrow("GitHub is off, so acme/webshop isn't read.");
    expect(b.github.watchedRepos()).toEqual([]);
    await b.connectionSetEnabled("github", true);
    expect(await b.devLinks(ticket)).toHaveLength(shown);
    expect(told).toBe(2);
  });

  it("starts a new account on, even when the one removed was off", async () => {
    const b = new MockBackend({ githubRepos: 6 });
    await b.connectionSetEnabled("github", false);
    await b.connectionRemove("github");
    await b.githubConnect();
    expect((await b.connectionsList()).find((c) => c.instanceId === "github_2")?.enabled).toBe(true);
  });
});
