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
});
