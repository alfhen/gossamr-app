import { describe, expect, it, vi } from "vitest";
import type { ItemRef } from "../types";
import { MockBackend } from "./mock";

const GH = "github:ada";
const ticket = (key: string): ItemRef => ({ connectionId: "mock", externalId: key, key });
const backend = () => new MockBackend({ githubRepos: 14 });

async function watching(b: MockBackend, repos: string[]) {
  await b.watchSetMode(GH, "selected");
  await b.watchSetContainers(GH, repos.map((containerId) => ({ containerId, watched: true })));
}

describe("the mock's development links", () => {
  it("ties the sample tickets to pull requests, strongest link first", async () => {
    const b = backend();
    const ca208 = await b.devLinks(ticket("CA-208"));
    expect(ca208.map((l) => [l.change.kind, l.change.number, l.provenance])).toEqual([
      ["pullRequest", 208, "branch"],
      ["commit", null, "commit"],
    ]);
    const draft = ca208[0].change;
    expect([draft.state, draft.checks, draft.review, draft.headRef]).toEqual(["draft", "failing", "changesRequested", "ca-208-gateway"]);
    expect(ca208[0].confidence).toBeGreaterThan(ca208[1].confidence);

    const devops = await b.devLinks(ticket("DEVOPS-471"));
    expect(devops.map((l) => [l.change.number, l.change.state, l.provenance])).toEqual([
      [14, "merged", "branch"],
      [208, "draft", "body"],
    ]);
    expect(devops[0].change.mergedAt).not.toBeNull();
    expect(await b.devLinks(ticket("CA-999"))).toEqual([]);
  });

  it("finds a branch without a pull request only through the live search, and says so", async () => {
    const b = backend();
    const changed = vi.fn();
    b.onDevLinksChanged(changed);
    expect(await b.devLinks(ticket("CA-209"))).toEqual([]);
    const live = await b.devLinksLive(ticket("CA-209"));
    expect(live.map((l) => [l.change.kind, l.change.title, l.change.state])).toEqual([["branch", "feature/CA-209_cache-warmup", "open"]]);
    expect(changed).toHaveBeenCalledWith({ connectionId: GH });
    expect(await b.devLinks(ticket("CA-209"))).toHaveLength(1);
    await b.devLinksLive(ticket("CA-209"));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("shows nothing from repositories that aren't watched", async () => {
    const b = backend();
    await watching(b, ["acme/gateway"]);
    expect((await b.devLinks(ticket("DEVOPS-471"))).map((l) => l.change.repo)).toEqual(["acme/gateway"]);
    expect(await b.devLinks(ticket("CA-208"))).toEqual([]);
  });
});

describe("the mock's pull request reads", () => {
  it("reads a pull request with its files, commits and reviews", async () => {
    const b = backend();
    const d = await b.codePullRequest({ connectionId: GH, repo: "acme/webshop", number: 208 });
    expect([d.change.number, d.files.length, d.filesTruncated, d.reviews[0].state]).toEqual([208, 2, true, "changesRequested"]);
    expect(d.files[1].patch).toBeNull();
    await expect(b.codePullRequest({ connectionId: GH, repo: "acme/webshop", number: 1 })).rejects.toThrow("couldn't find");
  });

  it("reads a pull request only inside a watched repository", async () => {
    const b = backend();
    await watching(b, ["acme/webshop"]);
    await expect(b.codePullRequest({ connectionId: GH, repo: "acme/gateway", number: 14 })).rejects.toThrow("isn't one of the repositories you watch");
  });
});
