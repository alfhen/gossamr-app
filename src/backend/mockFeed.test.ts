import { describe, expect, it, vi } from "vitest";
import { MockConnector, containerRef, itemRef } from "./mockConnector";

const NOW = Date.parse("2026-06-30T12:00:00Z");

describe("the mock connector's feed", () => {
  const c = new MockConnector(NOW);
  const all = c.feed({ limit: 200 }).entries;

  it("is rich: comments, mentions, status changes and assignments across projects, newest first", () => {
    expect(new Set(all.map((e) => e.kind))).toEqual(new Set(["commentAdded", "statusChanged", "assigned"]));
    expect(all.filter((e) => e.mention).length).toBeGreaterThanOrEqual(3);
    expect(new Set(all.map((e) => e.item.key.split("-")[0])).size).toBe(4);
    expect(all.map((e) => e.at)).toEqual([...all.map((e) => e.at)].sort().reverse());
    expect(all.every((e) => e.itemTitle && e.actorName)).toBe(true);
  });

  it("starts recent teammate activity unread and leaves the person's own and older events read", () => {
    const unread = all.filter((e) => e.unread);
    expect(unread.length).toBeGreaterThan(3);
    expect(unread.length).toBeLessThan(all.length);
    expect(all.filter((e) => e.actor?.accountId === "me").every((e) => !e.unread)).toBe(true);
    expect(c.feedUnread()).toBe(unread.length);
  });

  it("narrows by kind, mention, unread and project", () => {
    expect(c.feed({ kinds: ["assigned"] }).entries.every((e) => e.kind === "assigned" && e.text === "Assigned to you")).toBe(true);
    const mentions = c.feed({ mentionsOnly: true }).entries;
    expect(mentions.length).toBeGreaterThan(0);
    expect(mentions.every((e) => e.mention)).toBe(true);
    expect(c.feed({ unreadOnly: true }).entries.every((e) => e.unread)).toBe(true);
    const web = c.feed({ container: containerRef("WEB"), limit: 200 }).entries;
    expect(web.length).toBeGreaterThan(0);
    expect(web.every((e) => e.item.key.startsWith("WEB-"))).toBe(true);
  });

  it("pages with a cursor and never repeats an entry", () => {
    const seen: string[] = [];
    let before = null;
    let pages = 0;
    do {
      const page = c.feed({ limit: 7, before });
      seen.push(...page.entries.map((e) => e.id));
      before = page.next;
      pages++;
    } while (before);
    expect(pages).toBeGreaterThan(2);
    expect(seen).toEqual(all.map((e) => e.id));
  });

  it("marks entries read and unread, tells the page, and ignores ids it doesn't know", () => {
    const onChange = vi.fn();
    const own = new MockConnector(NOW, onChange);
    const first = own.feed({ unreadOnly: true }).entries[0];
    const before = own.feedUnread();
    expect(own.setRead(first.id, true)).toBe(true);
    expect(own.feedUnread()).toBe(before - 1);
    expect(onChange).toHaveBeenCalledOnce();
    own.setRead(first.id, false);
    expect(own.feedUnread()).toBe(before);
    expect(own.setRead("legacy-1", true)).toBe(false);
  });

  it("shows a new comment from the person as an entry that is already read", () => {
    const own = new MockConnector(NOW);
    own.comment(itemRef("WEB-101"), "on it");
    const top = own.feed({ limit: 1 }).entries[0];
    expect(top).toMatchObject({ kind: "commentAdded", text: "on it", unread: false });
  });
});
