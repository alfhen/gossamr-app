import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { FeedEntry } from "../types";
import { ChipBar, DayHeading, EmptyNote, FeedRow, type FeedRowProps } from "./ActivityView";
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
      needsMe={false}
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

  it("flags tickets waiting on the person and words a mention as one", () => {
    expect(row({ needsMe: true })).toContain("Needs you");
    expect(row({ needsMe: false })).not.toContain("Needs you");
    expect(row({}, { mention: true })).toContain("mentioned you on");
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

describe("the chips and notes", () => {
  it("lists every filter and presses the chosen one, with counts", () => {
    const out = renderToStaticMarkup(<ChipBar chip="mentions" counts={{ needsMe: 3, drafts: 2 }} onChange={vi.fn()} />);
    for (const label of ["All", "Needs me", "Mentions", "Comments", "Status changes", "Assigned to me", "Drafts"]) expect(out).toContain(label);
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-pressed="true"[^>]*>Mentions/);
    expect(out).toContain('ml-1 font-normal">3<');
    expect(out).toContain('ml-1 font-normal">2<');
  });

  it("renders a day heading and a status note", () => {
    expect(renderToStaticMarkup(<DayHeading label="Today" />)).toContain("Today");
    expect(renderToStaticMarkup(<EmptyNote>All quiet</EmptyNote>)).toContain('role="status"');
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the activity store on the mock", () => {
  let backend: MockBackend;

  beforeEach(async () => {
    backend = new MockBackend();
    useActivity.setState({ chip: "all", container: null });
    useActivity.getState().init(backend);
    await flush();
  });

  it("loads the feed and the unread count", () => {
    const s = useActivity.getState();
    expect(s.status).toBe("ready");
    expect(s.entries.length).toBeGreaterThan(10);
    expect(s.unread).toBeGreaterThan(3);
  });

  it("filters by chip and by project", async () => {
    useActivity.getState().setChip("assigned");
    await flush();
    expect(useActivity.getState().entries.every((e) => e.kind === "assigned")).toBe(true);
    useActivity.getState().setChip("all");
    useActivity.getState().showProject({ connectionId: "mock", externalId: "SUP" });
    await flush();
    expect(useActivity.getState().entries.every((e) => e.item.key.startsWith("SUP-"))).toBe(true);
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
    expect(await backend.cacheFeedUnread()).toBe(before - 1);
  });

  it("marks everything read, including entries past the loaded page", async () => {
    await useActivity.getState().markAllRead();
    await flush();
    expect(await backend.cacheFeedUnread()).toBe(0);
    expect(useActivity.getState().unread).toBe(0);
    expect(useActivity.getState().entries.every((e) => !e.unread)).toBe(true);
  });

  it("shows only unread entries under Needs me and empties once they are read", async () => {
    useActivity.getState().setChip("needsMe");
    await flush();
    expect(useActivity.getState().entries.length).toBeGreaterThan(0);
    await useActivity.getState().markAllRead();
    await flush();
    expect(useActivity.getState().entries).toEqual([]);
  });

  it("reports a failed load and recovers on retry", async () => {
    const failing = vi.spyOn(backend, "cacheFeed").mockRejectedValueOnce(new Error("offline"));
    await useActivity.getState().reload();
    expect(useActivity.getState()).toMatchObject({ status: "error", error: "offline" });
    failing.mockRestore();
    await useActivity.getState().reload();
    expect(useActivity.getState().status).toBe("ready");
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
