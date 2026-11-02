import { describe, expect, it } from "vitest";
import type { ConnectionInfo, ItemRef, WorkContainer, WorkItem } from "../types";
import { cachedWithKey, refsForKey, siteNamer } from "./keyLookup";

const conn = (id: string, kind: string, enabled = true) => ({ id, kind, enabled, displayName: `${id}.example` }) as ConnectionInfo;
const item = (connectionId: string, key: string) => ({ item: { connectionId, externalId: key, key }, title: `${connectionId} ${key}` }) as WorkItem;
const container = (connectionId: string, key: string) => ({ ref: { connectionId, externalId: key }, key }) as WorkContainer;
const ref = (connectionId: string, key: string): ItemRef => ({ connectionId, externalId: key, key });
const state = (over: { items?: WorkItem[]; containers?: WorkContainer[]; connections?: ConnectionInfo[]; watch?: { connectionId: string }[] }) => ({
  items: Object.fromEntries((over.items ?? []).map((i) => [`${i.item.connectionId}:${i.item.externalId}`, i])),
  containers: Object.fromEntries((over.containers ?? []).map((c) => [`${c.ref.connectionId}:${c.ref.externalId}`, c])),
  connections: over.connections ?? [],
  watch: over.watch ?? [],
});
const twoSites = [conn("github:me", "github"), conn("jira:acme", "jira"), conn("jira:beta", "jira")];

describe("refsForKey", () => {
  it("is nothing until a work connection or a watched work ticket is there, which is what the palette's lookup waits for", () => {
    expect(refsForKey(state({ connections: [conn("github:me", "github")] }), "TAF-12")).toEqual([]);
    expect(refsForKey(state({ connections: [conn("github:me", "github")], watch: [{ connectionId: "jira:acme" }] }), "TAF-12")).toEqual([ref("jira:acme", "TAF-12")]);
    expect(refsForKey(state({ connections: [conn("github:me", "github"), conn("jira:acme", "jira")] }), "TAF-12")).toEqual([ref("jira:acme", "TAF-12")]);
  });

  it("names every site that has the key cached, whatever the case it was typed in", () => {
    const s = state({ connections: twoSites, items: [item("jira:acme", "TAF-12"), item("jira:beta", "TAF-12"), item("jira:beta", "TAF-13")] });
    expect(refsForKey(s, "taf-12")).toEqual([ref("jira:acme", "TAF-12"), ref("jira:beta", "TAF-12")]);
    expect(refsForKey(s, "TAF-13")).toEqual([ref("jira:beta", "TAF-13")]);
  });

  it("reads an uncached key from the sites that have its project, or from every site that is on when none does", () => {
    const s = state({ connections: twoSites, containers: [container("jira:beta", "TAF")] });
    expect(refsForKey(s, "TAF-99")).toEqual([ref("jira:beta", "TAF-99")]);
    expect(refsForKey(s, "ZZ-1")).toEqual([ref("jira:acme", "ZZ-1"), ref("jira:beta", "ZZ-1")]);
    expect(refsForKey(state({ connections: [...twoSites.slice(0, 2), conn("jira:beta", "jira", false)] }), "ZZ-1")).toEqual([ref("jira:acme", "ZZ-1")]);
  });

  it("offers both sites for an uncached key when both have the project", () => {
    const s = state({ connections: twoSites, containers: [container("jira:acme", "TAF"), container("jira:beta", "TAF")] });
    expect(refsForKey(s, "TAF-99").map((r) => r.connectionId)).toEqual(["jira:acme", "jira:beta"]);
  });
});

describe("cachedWithKey", () => {
  it("finds the same key on each site", () => {
    const items = state({ items: [item("jira:acme", "TAF-12"), item("jira:beta", "TAF-12")] }).items;
    expect(cachedWithKey(items, "TAF-12")).toHaveLength(2);
  });
});

describe("siteNamer", () => {
  it("names a ticket's site only while more than one Jira site is on", () => {
    expect(siteNamer(twoSites)(ref("jira:beta", "TAF-12"))).toBe("jira:beta.example");
    expect(siteNamer(twoSites.slice(0, 2))(ref("jira:acme", "TAF-12"))).toBeNull();
    expect(siteNamer([...twoSites.slice(0, 2), conn("jira:beta", "jira", false)])(ref("jira:acme", "TAF-12"))).toBeNull();
  });
});
