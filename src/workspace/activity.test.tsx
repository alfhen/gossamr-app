import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { FeedEntry } from "../types";
import { DayHeading, EmptyNote, FeedRow, MentionsFilter, type FeedRowProps } from "./ActivityView";
import { INBOX_KINDS, inInbox } from "./activityLogic";
import { useActivity } from "./activityStore";

const entry = (over: Partial<FeedEntry> = {}): FeedEntry => ({
  id: "e1",
  connectionId: "mock",
  at: "2026-09-30T10:00:00Z",
  kind: "commentAdded",
  item: { connectionId: "mock", externalId: "WEB-101", key: "WEB-101" },
  itemTitle: "Lazy-load swatch images",
  actor: null,
  actorName: "Priya Nair",
  text: "Swatches flicker on Safari",
  mention: false,
  unread: true,
  done: false,
  ...over,
});

const row = (over: Partial<FeedRowProps> = {}, e: Partial<FeedEntry> = {}) =>
  renderToStaticMarkup(
    <FeedRow
      entry={entry(e)}
      actor="Priya Nair"
      title="Lazy-load swatch images"
      now={new Date("2026-09-30T12:00:00Z")}
      selected={false}
      openable
      position={1}
      total={4}
      onOpen={vi.fn()}
      onMarkRead={vi.fn()}
      onShow={vi.fn()}
      {...over}
    />,
  );

describe("FeedRow", () => {
  it("names who did what to which ticket, with a snippet and the time", () => {
    const out = row();
    expect(out).toContain("Priya Nair");
    expect(out).toContain("commented on");
    expect(out).toContain("WEB-101");
    expect(out).toContain("Lazy-load swatch images");
    expect(out).toContain("Swatches flicker on Safari");
    expect(out).toContain("2h");
    expect(out).toContain('aria-posinset="1"');
    expect(out).toContain('aria-setsize="4"');
  });

  it("emphasises unread entries and offers to mark them read", () => {
    const unread = row();
    expect(unread).toContain('data-unread="true"');
    expect(unread).toContain("font-semibold");
    expect(unread).toContain("Mark read");
    const read = row({}, { unread: false });
    expect(read).not.toContain("data-unread");
    expect(read).not.toContain("Mark read");
  });

  it("words a mention as one, and flags nothing as Your turn: a feed row is for information", () => {
    expect(row()).not.toContain("Your turn");
    expect(row({}, { mention: true })).toContain("mentioned you on");
    expect(row({}, { mention: true })).not.toContain("Your turn");
  });

  it("can't be opened once the ticket has left the cache", () => {
    const out = row({ openable: false, title: "" });
    expect(out).toMatch(/<button[^>]*disabled/);
    expect(out).not.toContain("Show me");
  });

  it("marks the selected entry as current", () => {
    expect(row({ selected: true })).toContain('aria-current="true"');
  });
});

describe("the filter and notes", () => {
  it("offers one filter, for mentions, and nothing else", () => {
    const out = renderToStaticMarkup(<MentionsFilter filter="mentions" onChange={vi.fn()} />);
    expect(out.match(/<button/g)).toHaveLength(1);
    expect(out).toMatch(/aria-pressed="true"[^>]*>Mentions/);
    expect(renderToStaticMarkup(<MentionsFilter filter="all" onChange={vi.fn()} />)).toMatch(/aria-pressed="false"/);
  });

  it("renders a day heading and a status note", () => {
    expect(renderToStaticMarkup(<DayHeading label="Today" />)).toContain("Today");
    expect(renderToStaticMarkup(<DayHeading label="Today" />)).toContain("<h3");
    // Under a page's own level 1, a day is a level 2 (G14).
    expect(renderToStaticMarkup(<DayHeading label="Today" level={2} />)).toMatch(/<h2[^>]*>Today<\/h2>/);
    expect(renderToStaticMarkup(<EmptyNote>All quiet</EmptyNote>)).toContain('role="status"');
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the activity store on the mock", () => {
  let backend: MockBackend;

  beforeEach(async () => {
    backend = new MockBackend();
    useActivity.setState({ filter: "all" });
    useActivity.getState().init(backend);
    await flush();
  });

  it("loads the feed and the unread count", () => {
    const s = useActivity.getState();
    expect(s.status).toBe("ready");
    expect(s.entries.length).toBeGreaterThan(10);
    expect(s.unread).toBeGreaterThan(3);
  });

  it("narrows to mentions and back", async () => {
    useActivity.getState().setFilter("mentions");
    await flush();
    expect(useActivity.getState().entries.length).toBeGreaterThan(0);
    expect(useActivity.getState().entries.every((e) => e.mention)).toBe(true);
    useActivity.getState().setFilter("all");
    await flush();
    expect(useActivity.getState().entries.some((e) => !e.mention)).toBe(true);
  });

  it("marks one entry read at once and keeps it read after the backend answers", async () => {
    const first = useActivity.getState().entries.find((e) => e.unread)!;
    const before = useActivity.getState().unread;
    const done = useActivity.getState().markRead([first.id]);
    expect(useActivity.getState().entries.find((e) => e.id === first.id)!.unread).toBe(false);
    expect(useActivity.getState().unread).toBe(before - 1);
    await done;
    await flush();
    expect(useActivity.getState().entries.find((e) => e.id === first.id)!.unread).toBe(false);
    expect(await backend.cacheFeedUnread(INBOX_KINDS)).toBe(before - 1);
  });

  it("marks everything read, including entries past the loaded page", async () => {
    await useActivity.getState().markAllRead();
    await flush();
    expect(await backend.cacheFeedUnread(INBOX_KINDS)).toBe(0);
    expect(useActivity.getState().unread).toBe(0);
    expect(useActivity.getState().entries.every((e) => !e.unread)).toBe(true);
  });

  /** Recent field changes by a teammate: in the feed and unread, but not something the Inbox lists. */
  const addHidden = async (n: number) => {
    for (let i = 0; i < n; i++) backend.connector["record"]("WEB-101", "fieldChanged", "sam", new Date(Date.now() + 60_000 * (i + 1)).toISOString(), { text: "Priority" });
    useActivity.getState().init(backend);
    await flush();
  };

  it("asks the backend only for the kinds the Inbox lists, so newer entries it would hide never fill the page", async () => {
    await addHidden(5);
    const spy = vi.spyOn(backend, "cacheFeed");
    await useActivity.getState().reload();
    expect(spy).toHaveBeenLastCalledWith({ kinds: INBOX_KINDS });
    const all = (await backend.cacheFeed({ limit: 200 })).entries;
    expect(all.slice(0, 5).every((e) => !inInbox(e))).toBe(true);
    expect(useActivity.getState().entries.length).toBeGreaterThan(10);
    expect(useActivity.getState().entries.every(inInbox)).toBe(true);
  });

  it("counts unread only among the kinds the Inbox lists, and Mark all read leaves the others alone", async () => {
    await addHidden(3);
    const unreadShown = (await backend.cacheFeed({ unreadOnly: true, kinds: INBOX_KINDS, limit: 200 })).entries.length;
    expect(useActivity.getState().unread).toBe(unreadShown);
    expect(await backend.cacheFeedUnread()).toBe(unreadShown + 3);
    await useActivity.getState().markAllRead();
    await flush();
    expect(await backend.cacheFeedUnread(INBOX_KINDS)).toBe(0);
    expect(await backend.cacheFeedUnread()).toBe(3);
  });

  it("reports a failed load and recovers on retry", async () => {
    const failing = vi.spyOn(backend, "cacheFeed").mockRejectedValueOnce(new Error("offline"));
    await useActivity.getState().reload();
    expect(useActivity.getState()).toMatchObject({ status: "error", error: "offline" });
    failing.mockRestore();
    await useActivity.getState().reload();
    expect(useActivity.getState().status).toBe("ready");
  });

  it("reports a failed mark-all-read instead of rejecting", async () => {
    vi.spyOn(backend, "cacheFeed").mockRejectedValueOnce(new Error("offline"));
    await expect(useActivity.getState().markAllRead()).resolves.toBeUndefined();
  });

  it("stops showing a stale page-load as pending once the feed reloads", async () => {
    const all = (await backend.cacheFeed({ limit: 200 })).entries;
    let release: (page: { entries: typeof all; next: null }) => void = () => {};
    const spy = vi.spyOn(backend, "cacheFeed");
    spy.mockResolvedValueOnce({ entries: all.slice(0, 5), next: { at: all[4].at, id: all[4].id } });
    await useActivity.getState().reload();
    spy.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const more = useActivity.getState().loadMore();
    expect(useActivity.getState().loadingMore).toBe(true);
    spy.mockResolvedValueOnce({ entries: all.slice(0, 5), next: null });
    await useActivity.getState().reload();
    expect(useActivity.getState().loadingMore).toBe(false);
    release({ entries: all.slice(5, 10), next: null });
    await more;
    expect(useActivity.getState().entries).toHaveLength(5);
  });

  it("appends the next page without repeating entries", async () => {
    const spy = vi.spyOn(backend, "cacheFeed");
    const all = (await backend.cacheFeed({ limit: 200 })).entries;
    spy.mockImplementation((q) => Promise.resolve({ entries: all.slice(q.before ? 5 : 0, q.before ? 10 : 5), next: q.before ? null : { at: all[4].at, id: all[4].id } }));
    await useActivity.getState().reload();
    expect(useActivity.getState().entries).toHaveLength(5);
    await useActivity.getState().loadMore();
    expect(useActivity.getState().entries.map((e) => e.id)).toEqual(all.slice(0, 10).map((e) => e.id));
    expect(useActivity.getState().next).toBeNull();
  });
});
