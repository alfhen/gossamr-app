import { describe, expect, it } from "vitest";
import type { CodeChange, DevLink, WorkItem } from "../types";
import { compileFilter, describeFilter, parseQuery, usesCode, withoutCode, ALL, and } from "./filter";
import { checksLine, codeFilterMatches, developmentLine, diffStat, keysIn, orderLinks, pillOf, provenanceHint, reviewLine, summarize, summaryLine } from "./devLinks";

const change = (over: Partial<CodeChange>): CodeChange => ({
  connectionId: "github:ada",
  externalId: "pr:acme/webshop#1",
  kind: "pullRequest",
  repo: "acme/webshop",
  number: 1,
  title: "T",
  headRef: "b",
  baseRef: "main",
  state: "open",
  mergedAt: null,
  createdAt: null,
  updatedAt: "2026-09-29T10:00:00Z",
  author: null,
  reviewers: [],
  checks: "none",
  review: "none",
  url: "https://github.com/acme/webshop/pull/1",
  sha: null,
  additions: null,
  deletions: null,
  changedFiles: null,
  body: "",
  linkedKeys: [],
  ...over,
});

const link = (over: Partial<CodeChange>): DevLink => ({ item: { connectionId: "mock", externalId: "CA-1", key: "CA-1" }, change: change(over), provenance: "branch", confidence: 0.95 });

describe("the state of a ticket's pull requests", () => {
  it("picks the most relevant state: open, then draft, merged, closed", () => {
    const pick = (...states: CodeChange["state"][]) => summarize(states.map((state, i) => link({ state, number: i + 1, externalId: `pr:r#${i + 1}` }))).state;
    expect(pick("closed", "merged")).toBe("merged");
    expect(pick("merged", "draft")).toBe("draft");
    expect(pick("draft", "open", "merged")).toBe("open");
    expect(pick()).toBeNull();
  });

  it("counts kinds separately and flags failing checks only on unfinished pull requests", () => {
    const s = summarize([link({ state: "merged", checks: "failing" }), link({ kind: "branch", externalId: "branch:r:b", number: null, state: "open" }), link({ kind: "commit", externalId: "commit:r@1", number: null, state: "merged" })]);
    expect([s.prs, s.branches, s.commits, s.failing]).toEqual([1, 1, 1, false]);
    expect(summarize([link({ state: "draft", checks: "failing" })]).failing).toBe(true);
  });

  it("ignores the same change linked twice", () => {
    expect(summarize([link({}), link({})]).prs).toBe(1);
  });

  it("writes the tooltip and the Pip line", () => {
    const s = summarize([link({ state: "draft", checks: "failing", number: 208, externalId: "pr:acme/webshop#208" }), link({ state: "merged", externalId: "pr:acme/gateway#14", repo: "acme/gateway", number: 14 })]);
    expect(summaryLine(s)).toBe("2 pull requests: 1 draft, 1 merged. Checks failing on acme/webshop#208");
    expect(developmentLine(s)).toBe("Development: 2 pull requests linked (1 draft, 1 merged. Checks failing on acme/webshop#208)");
    expect(developmentLine(summarize([]))).toBeNull();
    expect(developmentLine(undefined)).toBeNull();
    expect(summaryLine(summarize([link({ kind: "branch", externalId: "branch:r:b", number: null })]))).toBe("1 branch without a pull request yet");
  });
});

describe("rows and their marks", () => {
  it("names the pill, the checks and the review", () => {
    expect(pillOf({ kind: "pullRequest", state: "merged" })).toEqual({ label: "Merged", tone: "merged" });
    expect(pillOf({ kind: "pullRequest", state: "draft" }).label).toBe("Draft");
    expect(pillOf({ kind: "branch", state: "open" }).label).toBe("Branch");
    expect(checksLine("failing")).toEqual({ label: "Checks failing", tone: "bad" });
    expect(checksLine("pending")?.tone).toBe("pending");
    expect(checksLine("none")).toBeNull();
    expect(reviewLine("changesRequested")?.label).toBe("Changes requested");
    expect(reviewLine("requested")?.label).toBe("Review requested");
    expect(reviewLine("approved")?.tone).toBe("good");
    expect(reviewLine("none")).toBeNull();
  });

  it("knows when nothing is known about the size of a change", () => {
    expect(diffStat(change({}))).toBeNull();
    expect(diffStat(change({ additions: 3, deletions: 1, changedFiles: 2 }))).toEqual({ additions: 3, deletions: 1, files: 2 });
  });

  it("explains where a link came from and orders pull requests before branches and commits", () => {
    expect(provenanceHint("branch")).toMatch(/branch name/);
    expect(provenanceHint("commit")).toMatch(/commit message/);
    const ordered = orderLinks([link({ kind: "commit", externalId: "c", state: "merged" }), link({ kind: "branch", externalId: "b" }), link({ state: "merged", externalId: "m" }), link({ state: "open", externalId: "o" })]);
    expect(ordered.map((l) => l.change.externalId)).toEqual(["o", "m", "b", "c"]);
  });

  it("finds ticket keys in a title", () => {
    expect(keysIn("CA-208: route, see DEVOPS-471 and DEVOPS-471")).toEqual(["CA-208", "DEVOPS-471"]);
    expect(keysIn("feature/ca-209_cache-warmup")).toEqual(["CA-209"]);
    expect(keysIn("CA-208fix")).toEqual([]);
  });
});

describe("the filter chips over linked code", () => {
  const item = (key: string) => ({ item: { connectionId: "mock", externalId: key, key } }) as WorkItem;
  const index = new Map([
    ["mock:A", summarize([link({ state: "open" })])],
    ["mock:B", summarize([link({ state: "merged" })])],
    ["mock:C", summarize([link({ state: "draft", checks: "failing" })])],
    ["mock:D", summarize([])],
  ]);
  const ctx = { me: [], now: 0, needsMe: new Set<string>(), code: index };
  const pass = (check: Parameters<typeof codeFilterMatches>[0]) => ["A", "B", "C", "D", "E"].filter((k) => compileFilter({ type: "code", check }, [], ctx)(item(k)));

  it("has, none, open, merged and failing", () => {
    expect(pass("has")).toEqual(["A", "B", "C"]);
    expect(pass("none")).toEqual(["D"]);
    expect(pass("open")).toEqual(["A", "C"]);
    expect(pass("merged")).toEqual(["B"]);
    expect(pass("failing")).toEqual(["C"]);
  });

  it("match nothing for an item whose links haven't been read, even No PR", () => {
    expect(codeFilterMatches("none", undefined)).toBe(false);
    expect(pass("none")).not.toContain("E");
  });

  it("are typed as words, described, and kept away from the backend", () => {
    const lookup = { containers: [], people: [], me: [] };
    expect(parseQuery("has:pr no:pr pr:open pr:merged checks:failing", lookup)).toEqual(and(...(["has", "none", "open", "merged", "failing"] as const).map((check) => ({ type: "code" as const, check }))));
    expect(describeFilter({ type: "code", check: "failing" }, lookup)).toBe("Checks failing");
    const mixed = and({ type: "mine" }, { type: "code", check: "has" });
    expect(usesCode(mixed)).toBe(true);
    expect(withoutCode(mixed)).toEqual({ type: "mine" });
    expect(usesCode(ALL)).toBe(false);
  });
});
