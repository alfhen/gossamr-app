import { describe, expect, it } from "vitest";
import type { WatchState, WorkContainer } from "../types";
import { allContainers } from "../workspaceStore";
import { codeWatch, domainOfConnection, domainOfKind, isWorkConnection, workConnections, workContainers, workWatch } from "./domains";
import { railSplit } from "./watchLogic";

const container = (connectionId: string, key: string): WorkContainer => ({ ref: { connectionId, externalId: key }, key, name: key, workflow: null }) as unknown as WorkContainer;
const state = (connectionId: string): WatchState => ({ connectionId, mode: "selected", needsChoice: false, catalogSize: null, watches: [{ container: { connectionId, externalId: "acme/webshop" }, depth: "involved", pinned: true, source: "manual", addedAt: "", unwatchedAt: null, inaccessible: false, key: "acme/webshop", name: "webshop", cachedItems: 0 }] });

describe("work and code containers", () => {
  it("classifies connections by kind, and by id before they have loaded", () => {
    expect(domainOfKind("github")).toBe("code");
    expect(domainOfKind("jira")).toBe("work");
    expect(domainOfKind("mock")).toBe("work");
    expect(domainOfConnection([{ id: "github:ada", kind: "github" }], "github:ada")).toBe("code");
    expect(domainOfConnection([], "github:ada")).toBe("code");
    expect(domainOfConnection([], "jira:site:me")).toBe("work");
    expect(isWorkConnection("mock")).toBe(true);
    expect(isWorkConnection("github:ada")).toBe(false);
    expect(workConnections([{ kind: "jira" }, { kind: "github" }, { kind: "mock" }]).map((c) => c.kind)).toEqual(["jira", "mock"]);
  });

  it("keeps repositories out of the containers the rail, filters and switcher are made of", () => {
    const mixed = [container("mock", "CA"), container("github:ada", "acme/webshop"), container("mock", "WEB")];
    expect(workContainers(mixed).map((c) => c.key)).toEqual(["CA", "WEB"]);
    const containers = Object.fromEntries(mixed.map((c) => [`${c.ref.connectionId}:${c.key}`, c]));
    expect(allContainers({ containers }).map((c) => c.key)).toEqual(["CA", "WEB"]);
  });

  it("never gives a pinned repository a badge in the rail", () => {
    const mixed = [container("mock", "CA"), container("github:ada", "acme/webshop")];
    const split = railSplit(mixed, [state("github:ada")], null);
    expect([...split.badges, ...split.rest].map((c) => c.key)).toEqual(["CA"]);
    expect(split.badges.map((c) => c.key)).toEqual(["CA"]);
  });

  it("splits what is watched by domain", () => {
    const both = [state("mock"), state("github:ada")];
    expect(workWatch(both).map((w) => w.connectionId)).toEqual(["mock"]);
    expect(codeWatch(both).map((w) => w.connectionId)).toEqual(["github:ada"]);
  });
});
