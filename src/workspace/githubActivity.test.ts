import { describe, expect, it } from "vitest";
import type { FeedEntry, ItemRef, WorkEvent } from "../types";
import { buildRows, codeEventUnread, codeMatchesChip, toCodeEntry, ticketOfChange, type CodeEntry } from "./activityLogic";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const ref = (key: string): ItemRef => ({ connectionId: "mock", externalId: key, key });
const ctx = { byKey: new Map([["CA-208", ref("CA-208")]]), byChange: new Map<string, ItemRef>(), read: new Set<string>(), now: NOW };

const event = (id: string, kind: WorkEvent["kind"], at: string, over: Partial<WorkEvent> = {}): WorkEvent => ({
  id,
  connectionId: "github:ada",
  at,
  kind,
  subject: { type: "codeChange", repo: "acme/webshop", number: 208 },
  actor: null,
  payload: { text: "bob requested changes on acme/webshop#208: CA-208: Route", title: "CA-208: Route", url: "https://github.com/acme/webshop/pull/208" },
  ...over,
});

const feed = (id: string, at: string): FeedEntry => ({ id, connectionId: "mock", at, kind: "commentAdded", item: ref("CA-1"), itemTitle: "T", actor: null, actorName: "Sam", text: "", mention: false, unread: false, done: false });

describe("GitHub events as feed rows", () => {
  it("links an event to its ticket through a known link, else through a key in the title", () => {
    expect(toCodeEntry(event("a", "prOpened", "2026-09-30T10:00:00Z"), ctx)?.item).toEqual(ref("CA-208"));
    const known = new Map([["pr:acme/webshop#208", ref("DEVOPS-471")]]);
    expect(ticketOfChange("acme/webshop", 208, "no key here", { byKey: ctx.byKey, byChange: known })).toEqual(ref("DEVOPS-471"));
    expect(ticketOfChange("acme/webshop", 9, "no key here", ctx)).toBeNull();
  });

  it("asks for attention on review requests, failed checks, mentions and verdicts until they are read", () => {
    const e = (kind: WorkEvent["kind"], read = new Set<string>()) => toCodeEntry(event(`x-${kind}`, kind, "2026-09-30T10:00:00Z"), { ...ctx, read })!;
    expect([e("reviewRequested").unread, e("checkFailed").unread, e("prMentioned").unread, e("reviewSubmitted").unread]).toEqual([true, true, true, true]);
    expect([e("prMerged").unread, e("prOpened").unread, e("prClosed").needsYou]).toEqual([false, false, false]);
    expect(e("checkFailed", new Set(["x-checkFailed"])).unread).toBe(false);
    expect(toCodeEntry(event("old", "checkFailed", "2026-08-01T00:00:00Z"), ctx)?.unread).toBe(false);
  });

  it("counts what is unread and falls back to the pull request page for the address", () => {
    const events = [event("1", "checkFailed", "2026-09-30T10:00:00Z"), event("2", "prOpened", "2026-09-30T09:00:00Z"), event("3", "reviewRequested", "2026-09-30T08:00:00Z")];
    expect(codeEventUnread(events, new Set(["3"]), NOW)).toBe(1);
    expect(toCodeEntry(event("u", "prOpened", "2026-09-30T10:00:00Z", { payload: { url: "javascript:alert(1)" } }), ctx)?.url).toBe("https://github.com/acme/webshop/pull/208");
  });

  it("is ignored when the event isn't about a code change", () => {
    expect(toCodeEntry(event("i", "commentAdded", "2026-09-30T10:00:00Z", { subject: { type: "item", item: ref("CA-1") } }), ctx)).toBeNull();
  });
});

describe("the merged feed and its source chips", () => {
  const code = (id: string, at: string, over: Partial<CodeEntry> = {}): CodeEntry => ({ ...toCodeEntry(event(id, "checkFailed", at), ctx)!, ...over });
  const input = { chip: "all" as const, container: null, jira: [feed("j1", "2026-09-30T11:00:00Z"), feed("j2", "2026-09-28T11:00:00Z")], more: false, code: [code("g1", "2026-09-30T10:00:00Z"), code("g2", "2026-09-29T10:00:00Z", { kind: "prMerged", needsYou: false, unread: false })], containerOf: () => null };
  const ids = (rows: ReturnType<typeof buildRows>) => rows.map((r) => r.entry.id);

  it("shows both sources newest first, or one of them", () => {
    expect(ids(buildRows({ ...input, source: "all" }))).toEqual(["j1", "g1", "g2", "j2"]);
    expect(ids(buildRows({ ...input, source: "jira" }))).toEqual(["j1", "j2"]);
    expect(ids(buildRows({ ...input, source: "github" }))).toEqual(["g1", "g2"]);
  });

  it("holds back GitHub events older than the last loaded tracker entry while more of those follow", () => {
    expect(ids(buildRows({ ...input, source: "all", more: true }))).toEqual(["j1", "g1", "g2", "j2"]);
    expect(ids(buildRows({ ...input, source: "all", more: true, jira: [feed("j1", "2026-09-30T11:00:00Z")] }))).toEqual(["j1"]);
    expect(ids(buildRows({ ...input, source: "all", more: true, jira: [feed("j1", "2026-09-30T11:00:00Z"), feed("j0", "2026-09-30T09:30:00Z")] }))).toEqual(["j1", "g1", "j0"]);
  });

  it("narrows GitHub events by chip and, through their ticket, by project", () => {
    expect(codeMatchesChip("needsMe", { kind: "checkFailed", mention: false, unread: true })).toBe(true);
    expect(codeMatchesChip("needsMe", { kind: "prMerged", mention: false, unread: false })).toBe(false);
    expect(codeMatchesChip("comments", { kind: "prMentioned", mention: true, unread: true })).toBe(false);
    expect(codeMatchesChip("mentions", { kind: "prMentioned", mention: true, unread: true })).toBe(true);
    expect(ids(buildRows({ ...input, source: "github", chip: "needsMe" }))).toEqual(["g1"]);
    const inCa = { connectionId: "mock", externalId: "CA" };
    expect(ids(buildRows({ ...input, source: "github", container: inCa, containerOf: () => inCa }))).toEqual(["g1", "g2"]);
    expect(ids(buildRows({ ...input, source: "github", container: { connectionId: "mock", externalId: "WEB" }, containerOf: () => inCa }))).toEqual([]);
  });
});
