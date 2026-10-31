import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";

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
    await b.githubConnectToken("ghp_x");
    expect((await b.connectionsList()).map((c) => c.instanceId)).toEqual(["jira", "github_2"]);
  });

  it("refuses the sample data and an instance that is gone", async () => {
    const b = new MockBackend({ githubRepos: 6 });
    await expect(b.connectionRemove("jira")).rejects.toThrow("built in");
    await expect(b.connectionRemove("github_9")).rejects.toThrow("gone");
    expect(await b.connectionsList()).toHaveLength(2);
  });
});
