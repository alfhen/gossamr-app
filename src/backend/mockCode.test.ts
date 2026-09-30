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
    expect(await b.codeSearch("CA-208")).toEqual([]);
    expect((await b.codeEvents()).every((e) => e.subject.type === "codeChange" && e.subject.repo === "acme/gateway")).toBe(true);
  });
});

describe("the mock's reads for the Activity feed and Pip's tools", () => {
  it("reads a pull request with its files, commits and reviews", async () => {
    const b = backend();
    const d = await b.codePullRequest({ connectionId: GH, repo: "acme/webshop", number: 208 });
    expect([d.change.number, d.files.length, d.filesTruncated, d.reviews[0].state]).toEqual([208, 2, true, "changesRequested"]);
    expect(d.files[1].patch).toBeNull();
    await expect(b.codePullRequest({ connectionId: GH, repo: "acme/webshop", number: 1 })).rejects.toThrow("couldn't find");
  });

  it("searches by key exactly and by words loosely", async () => {
    const b = backend();
    expect((await b.codeSearch("CA-208")).map((c) => c.externalId)).toEqual(["pr:acme/webshop#208", "commit:acme/webshop@9999999ccccccc"]);
    expect(await b.codeSearch("CA-20")).toEqual([]);
    expect((await b.codeSearch("category")).map((c) => c.number)).toEqual([212]);
    expect(await b.codeSearch("  ")).toEqual([]);
  });

  it("lists events newest first with code subjects", async () => {
    const events = await backend().codeEvents();
    expect(events.map((e) => e.kind)).toEqual(["checkFailed", "reviewSubmitted", "prMerged", "reviewRequested", "prOpened"]);
    expect(events.every((e) => e.subject.type === "codeChange")).toBe(true);
    expect(await backend().codeEvents(2)).toHaveLength(2);
  });

  it("reads files, directories, commits and code only inside watched repositories", async () => {
    const b = backend();
    await watching(b, ["acme/webshop"]);
    expect((await b.codeFile(GH, "acme/webshop", "src/gateway/routes.ts")).text).toContain("checkout");
    expect((await b.codeTree(GH, "acme/webshop", "")).map((e) => [e.name, e.kind])).toEqual([["src", "dir"], ["README.md", "file"]]);
    expect((await b.codeTree(GH, "acme/webshop", "src")).map((e) => e.name)).toEqual(["cart", "gateway"]);
    expect((await b.codeCommits(GH, "acme/webshop", { query: "ca-208" })).map((c) => c.title)).toEqual(["CA-208 hotfix for gateway timeout"]);
    expect(await b.codeCommits(GH, "acme/webshop", { since: new Date(Date.now() + 1000).toISOString() })).toEqual([]);
    const hits = await b.codeSearchCode(GH, "checkout");
    expect(hits.map((h) => h.path)).toEqual(["README.md", "src/gateway/routes.ts"]);
    expect(hits[1].fragments.length).toBeGreaterThan(0);

    for (const read of [
      () => b.codeFile(GH, "acme/gateway", "README.md"),
      () => b.codeTree(GH, "acme/gateway", ""),
      () => b.codeCommits(GH, "acme/gateway"),
      () => b.codeSearchCode(GH, "x", ["acme/gateway"]),
      () => b.codePullRequest({ connectionId: GH, repo: "acme/gateway", number: 14 }),
    ]) {
      await expect(read()).rejects.toThrow("isn't one of the repositories you watch");
    }
    await expect(b.codeFile(GH, "acme/webshop", "nope.txt")).rejects.toThrow("couldn't find");
  });
});
