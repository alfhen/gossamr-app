import { describe, expect, it } from "vitest";
import { docFromText, docText } from "../lib/docs";
import type { ItemRef, ScreenContext } from "../types";
import { MockBackend } from "./mock";
import { scriptPip } from "./mockPip";

const ref = (connectionId: string, key: string): ItemRef => ({ connectionId, externalId: key, key });
const acme = (key: string) => ref("mock", key);
const beta = (key: string) => ref("mock2", key);
const input = { site: "gamma", email: "alf@gamma.example", token: "t", expiresOn: "2027-10-30" };
const keysOf = (items: { item: ItemRef }[]) => items.map((i) => `${i.item.connectionId}:${i.item.key}`);

describe("the sample backend with two Jira accounts", () => {
  it("has one Jira connection unless asked for two", async () => {
    expect((await new MockBackend({ githubRepos: 6 }).connectionsList()).map((c) => c.instanceId)).toEqual(["jira", "github", "claude"]);
    const rows = await new MockBackend({ jira: 2, githubRepos: 6 }).connectionsList();
    expect(rows.map((c) => [c.instanceId, c.id, c.kind, c.displayName])).toEqual([
      ["jira", "mock", "jira", "acme.atlassian.net"],
      ["jira_2", "mock2", "jira", "beta.atlassian.net"],
      ["github", "github:ada", "github", "GitHub"],
      ["claude", "claude", "provider", "Claude"],
    ]);
  });

  it("shares a project key and a ticket key between the sites, each with its own text", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    const first = await b.cacheItem(acme("CA-402"));
    const second = await b.cacheItem(beta("CA-402"));
    expect(first?.title).toBe("Subject line variants");
    expect(second?.title).toBe("Quote template for the pilot");
    expect((await b.cacheContainers()).filter((c) => c.key === "CA").map((c) => [c.ref.connectionId, c.name])).toEqual([
      ["mock", "Campaigns"],
      ["mock2", "Client campaigns"],
    ]);
  });

  it("searches both sites at once and keeps a ticket's connection on its reference", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    const found = keysOf(await b.cacheSearch({ type: "and", filters: [] }));
    expect(found).toEqual(expect.arrayContaining(["mock:CA-402", "mock2:CA-402", "mock2:OPS-3"]));
    expect(new Set(found).size).toBe(found.length);
    expect(keysOf(await b.cacheSearch({ type: "mine" }))).toEqual(expect.arrayContaining(["mock:CA-402", "mock2:CA-402", "mock2:OPS-1"]));
  });

  it("reads a ticket's events, comments and moves from its own site", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    expect(docText((await b.cacheComments(beta("CA-402")))[0].body)).toContain("quote template");
    expect((await b.cacheComments(acme("CA-402"))).map((c) => docText(c.body)).join(" ")).not.toContain("quote template");
    expect((await b.cacheTransitions(beta("CA-402"))).map((m) => m.name).sort()).toEqual(["Shipped", "Working"]);
    expect(await b.cacheEvents(beta("DEVOPS-471"))).toEqual([]);
  });

  it("merges the feeds newest first with ids that never repeat, and counts unread across both", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    const { entries } = await b.cacheFeed({ limit: 200 });
    expect(entries.map((e) => e.at)).toEqual([...entries.map((e) => e.at)].sort().reverse());
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    expect(new Set(entries.map((e) => e.connectionId))).toEqual(new Set(["mock", "mock2"]));
    expect(await b.cacheFeedUnread()).toBe(entries.filter((e) => e.unread).length);
    const page = await b.cacheFeed({ limit: 5 });
    expect(page.next).not.toBeNull();
    const rest = await b.cacheFeed({ limit: 200, before: page.next! });
    expect([...page.entries, ...rest.entries].map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });

  it("narrows the feed to the project of one site when both have a project with that key", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    const { entries } = await b.cacheFeed({ limit: 200, container: { connectionId: "mock2", externalId: "CA" } });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.connectionId === "mock2" && e.item.key.startsWith("CA-"))).toBe(true);
  });

  it("marks an event read on the site that owns it", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    const mention = (await b.cacheFeed({ limit: 200, mentionsOnly: true })).entries.find((e) => e.connectionId === "mock2" && e.unread)!;
    await b.setUnread("mock2", mention.id, false);
    const after = (await b.cacheFeed({ limit: 200 })).entries.find((e) => e.id === mention.id);
    expect(after?.unread).toBe(false);
  });

  it("lists the person's accounts on both sites", async () => {
    const me = await new MockBackend({ jira: 2, githubRepos: 6 }).cacheMe();
    expect(me.accounts.map((a) => a.connectionId)).toEqual(["mock", "mock2"]);
  });

  it("writes an approved comment to the site the draft names", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    const draft = b.proposals.draft({ type: "comment", item: beta("CA-402"), body: docFromText("Sent it") });
    await b.proposalsApprove(draft.id);
    expect((await b.cacheComments(beta("CA-402"))).map((c) => docText(c.body))).toContain("Sent it");
    expect((await b.cacheComments(acme("CA-402"))).map((c) => docText(c.body))).not.toContain("Sent it");
  });

  it("keeps each site's watch list apart even where a project key repeats", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    await b.watchSetContainers("mock2", [{ containerId: "OPS", watched: true }]);
    const state = await b.watchGet();
    expect(state.map((w) => [w.connectionId, w.chosen])).toEqual([["mock", false], ["mock2", true], ["github:ada", false]]);
    expect(keysOf(await b.cacheSearch({ type: "and", filters: [] })).filter((k) => k.startsWith("mock2:"))).toEqual(expect.arrayContaining(["mock2:OPS-1"]));
    expect(keysOf(await b.cacheSearch({ type: "and", filters: [] })).filter((k) => k.startsWith("mock2:CA-"))).toEqual([]);
    expect(keysOf(await b.cacheSearch({ type: "and", filters: [] }))).toContain("mock:CA-402");
  });

  it("hides a site that is turned off and shows it again when it is turned back on", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    await b.connectionSetEnabled("jira_2", false);
    expect(keysOf(await b.cacheSearch({ type: "and", filters: [] })).some((k) => k.startsWith("mock2:"))).toBe(false);
    expect(await b.cacheItem(beta("CA-402"))).toBeNull();
    expect((await b.watchGet()).map((w) => w.connectionId)).toEqual(["mock", "github:ada"]);
    await b.connectionSetEnabled("jira_2", true);
    expect((await b.cacheItem(beta("CA-402")))?.title).toBe("Quote template for the pilot");
  });

  it("tells the page when a site is turned off", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    const told: string[] = [];
    b.onCacheChanged((c) => told.push(c.connectionId));
    await b.connectionSetEnabled("jira_2", false);
    expect(told).toEqual(["mock2"]);
  });

  it("removes the second account and leaves the first", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    await b.connectionRemove("jira_2");
    expect((await b.connectionsList()).map((c) => c.instanceId)).toEqual(["jira", "github", "claude"]);
    expect(await b.cacheItem(beta("CA-402"))).toBeNull();
    expect((await b.cacheItem(acme("CA-402")))?.title).toBe("Subject line variants");
  });
});

describe("signing in to another Jira account on the sample backend", () => {
  it("adds a connection with nothing watched yet, when an account is already signed in", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    await b.jiraConnect(input);
    const rows = await b.connectionsList();
    expect(rows.filter((c) => c.kind === "jira").map((c) => [c.instanceId, c.id, c.displayName])).toEqual([
      ["jira", "mock", "acme.atlassian.net"],
      ["jira_2", "mock2", "beta.atlassian.net"],
      ["jira_3", "mock3", "gamma.atlassian.net"],
    ]);
    expect((await b.watchGet()).find((w) => w.connectionId === "mock3")).toMatchObject({ chosen: true, watches: [] });
    expect(keysOf(await b.cacheSearch({ type: "and", filters: [] })).some((k) => k.startsWith("mock3:"))).toBe(false);
  });

  it("turns the sample into the first account rather than adding one", async () => {
    const b = new MockBackend();
    await b.jiraConnect(input);
    expect((await b.connectionsList()).filter((c) => c.kind === "jira")).toHaveLength(1);
    await b.jiraConnect({ ...input, site: "delta", email: "alf@delta.example" });
    expect((await b.connectionsList()).filter((c) => c.kind === "jira").map((c) => c.instanceId)).toEqual(["jira", "jira_2"]);
  });

  it("names a second account on the same site with its email", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    await b.jiraConnect({ ...input, site: "acme", email: "alf@contractor.com" });
    expect((await b.connectionsList()).find((c) => c.instanceId === "jira_3")?.displayName).toBe("acme.atlassian.net (alf@contractor.com)");
  });

  it("refuses an account either site already has", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    await expect(b.jiraConnect({ ...input, site: "beta", email: "alf@beta.example" })).rejects.toThrow("You already have this account");
    await expect(b.jiraConnect({ ...input, site: "acme", email: "alf@acme.com" })).rejects.toThrow("You already have this account");
  });

  it("replaces the account behind a row when the row is named, and never adds one", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    await b.jiraConnect({ ...input, site: "beta", email: "alf@beta.example", token: "new" }, "jira_2");
    expect((await b.connectionsList()).filter((c) => c.kind === "jira")).toHaveLength(2);
  });

  it("does not reuse the id of an account that was removed", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    await b.connectionRemove("jira_2");
    await b.jiraConnect(input);
    expect((await b.connectionsList()).filter((c) => c.kind === "jira").map((c) => c.instanceId)).toEqual(["jira", "jira_3"]);
  });
});

describe("a sync error on one Jira account", () => {
  it("shows on its row only, and clears when its token is renewed", async () => {
    const b = new MockBackend({ jira: 2, jiraToken: "expiring", githubRepos: 6 });
    b.failJira("jira_2", "refused");
    const rows = await b.connectionsList();
    expect(rows.find((c) => c.instanceId === "jira")).toMatchObject({ error: null, reauth: false });
    expect(rows.find((c) => c.instanceId === "jira_2")).toMatchObject({ error: expect.stringContaining("turned down"), reauth: true, transient: false });
    await b.jiraConnect({ site: "beta", email: "alf@beta.example", token: "fresh", expiresOn: "2027-10-30" }, "jira_2");
    expect((await b.connectionsList()).find((c) => c.instanceId === "jira_2")).toMatchObject({ error: null, reauth: false });
  });

  it("is a retry for a network failure, and still reads the cached tickets", async () => {
    const b = new MockBackend({ jira: 2, githubRepos: 6 });
    b.failJira("jira_2", "offline");
    expect((await b.connectionsList()).find((c) => c.instanceId === "jira_2")).toMatchObject({ error: expect.stringContaining("beta.atlassian.net"), transient: true, reauth: false });
    expect((await b.cacheItem(beta("CA-402")))?.title).toBe("Quote template for the pilot");
    b.failJira("jira_2", null);
    expect((await b.connectionsList()).find((c) => c.instanceId === "jira_2")?.error).toBeNull();
  });

  it("refuses an account that does not exist", () => {
    expect(() => new MockBackend({ jira: 2, githubRepos: 6 }).failJira("jira_9", "offline")).toThrow("no Jira account");
  });
});

describe("the scripted Pip and a key that two sites have", () => {
  const context = (item: ItemRef | null, selection: ItemRef[] = []): ScreenContext => ({ view: "Board", item, filter: null, selection });

  it("moves the key on the open ticket's site", () => {
    const move = scriptPip("move CA-402 to Working", context(beta("OPS-1")));
    expect(move.draft?.intent).toMatchObject({ type: "transition", item: beta("CA-402") });
    const other = scriptPip("move CA-402 to Copy", context(acme("CA-401")));
    expect(other.draft?.intent).toMatchObject({ type: "transition", item: acme("CA-402") });
  });

  it("takes a ticket's description edit from the site of the open ticket", () => {
    const s = scriptPip("Rewrite the description of CA-402", context(beta("OPS-1")));
    expect(s.rewrite?.item).toEqual(beta("CA-402"));
  });

  it("starts an agent on the key in the selection's site when no ticket is open", () => {
    const s = scriptPip("start an agent to investigate CA-402", context(null, [beta("OPS-3")]));
    expect(s.start?.item).toEqual(beta("CA-402"));
  });

  it("falls back to the first site when nothing says which", () => {
    const s = scriptPip("move CA-402 to Copy", context(null));
    expect(s.draft?.intent).toMatchObject({ item: acme("CA-402") });
  });
});
