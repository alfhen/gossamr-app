import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { ALL } from "../lib/filter";
import type { WorkItem } from "../types";
import { itemsByFilter, useWorkspace } from "../workspaceStore";
import { AgeView } from "./AgeView";
import { BoardView } from "./BoardView";
import { BulkBar } from "./BulkBar";
import { GhostCard, ItemCard, type ItemCardProps } from "./ItemCard";
import { useTabs, type Tab } from "./tabsStore";

const s = () => useWorkspace.getState();
const tab = (filter = ALL): Tab => ({ id: "t", title: null, filter, view: "board" });

beforeEach(async () => {
  // Server rendering reads a store's initial state; these tests want what the store holds now.
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  await s().init(new MockBackend());
});

const sync = () => {
  Object.assign(useWorkspace.getInitialState(), s());
  Object.assign(useTabs.getInitialState(), useTabs.getState());
};

const card = (over: Partial<ItemCardProps> = {}, item: WorkItem = s().items["mock:DEVOPS-473"]): ItemCardProps => ({
  item,
  assignee: "Jonas Berg",
  now: new Date("2026-09-30T12:00:00Z"),
  wither: 0,
  blocked: false,
  needsMe: false,
  unread: false,
  draft: null,
  moreDrafts: 0,
  selected: false,
  marked: false,
  menuOpen: false,
  moveTargets: [],
  onSelect: vi.fn(),
  onMenu: vi.fn(),
  onMove: vi.fn(),
  onApprove: vi.fn(),
  onSkip: vi.fn(),
  ...over,
});

const render = (props: ItemCardProps) => renderToStaticMarkup(<ItemCard {...props} />);

describe("ItemCard", () => {
  it("shows key, title, assignee, priority, labels and a bug marker", () => {
    const out = render(card());
    expect(out).toContain("DEVOPS-473");
    expect(out).toContain("Duplicate order events on retry");
    expect(out).toContain('title="Jonas Berg"');
    expect(out).toContain('aria-label="High priority"');
    expect(out).toContain('aria-label="Bug"');
    expect(out).toContain("bug");
    expect(out).toContain('draggable="true"');
  });

  it("marks a blocked card and counts the drafts it doesn't show", () => {
    const out = render(card({ blocked: true, moreDrafts: 2 }));
    expect(out).toContain("blocked");
    expect(out).toContain("✦ 2");
    expect(render(card())).not.toContain("⛓");
  });

  it("shows a pending move as a badge with approve and skip", () => {
    const out = render(card({ draft: { id: "d1", to: "Done" } }));
    expect(out).toContain("→ Done (draft)");
    expect(out).toContain('aria-label="Approve move to Done"');
    expect(out).toContain('aria-label="Skip move to Done"');
    expect(out).toContain("ws-card-draft");
  });

  it("keeps the age chip on cards that have gone quiet, above the wither overlay, and puts none on fresh or finished ones", () => {
    const stale = { ...s().items["mock:DEVOPS-473"], updated: "2026-09-20T12:00:00Z" };
    const out = render(card({ wither: 5 }, stale));
    expect(out).toContain("ws-wither ws-wither-3");
    expect(out).toMatch(/ws-age[^>]*>10d</);
    expect(out).toContain('class="cobweb"');
    expect(render(card({ wither: 0 }, { ...stale, updated: "2026-09-30T00:00:00Z" }))).not.toContain("ws-age");
    expect(render(card({ wither: 0 }, { ...stale, status: { id: "x", name: "Done", category: "done" } }))).not.toContain("ws-age");
    expect(render(card({ wither: 0 }))).not.toContain("ws-wither");
  });

  it("opens an actions menu with a move for each target, and approve and skip for a draft", () => {
    const targets = s().containers["mock:DEVOPS"].workflow.statuses.slice(0, 2);
    const closed = render(card({ moveTargets: targets }));
    expect(closed).not.toContain('role="menu"');
    expect(closed).toContain('aria-haspopup="menu"');
    expect(closed).toContain('aria-expanded="false"');

    const open = render(card({ menuOpen: true, moveTargets: targets, draft: { id: "d1", to: "Done" } }));
    expect(open).toContain('role="menu"');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("Move to To Do");
    expect(open).toContain("Move to In Progress");
    expect(open).toContain("Approve → Done");
    expect(open).toContain("Skip the draft");
    expect(render(card({ menuOpen: true }))).toContain("No moves from Blocked");
  });

  it("is a keyboard stop that says when it is selected or ticked", () => {
    const out = render(card({ selected: true, marked: true }));
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('aria-current="true"');
    expect(out).toContain("Ticked for a bulk action");
    expect(render(card())).not.toContain("aria-current");
  });
});

describe("GhostCard", () => {
  it("shows where a draft will land, with its own approve and skip", () => {
    const out = renderToStaticMarkup(<GhostCard item={s().items["mock:DEVOPS-471"]} draft={{ id: "d", to: "Done" }} onApprove={vi.fn()} onSkip={vi.fn()} />);
    expect(out).toContain("Draft: DEVOPS-471 moves here");
    expect(out).toContain("border-dashed");
    expect(out).toContain('aria-label="Approve move to Done"');
  });
});

describe("BulkBar", () => {
  const bar = (over = {}) =>
    renderToStaticMarkup(
      <BulkBar count={3} targets={[{ name: "Done", count: 3 }, { name: "Blocked", count: 1 }]} approvable={[]} confirming={false} onMoveAll={vi.fn()} onAsk={vi.fn()} onCancel={vi.fn()} onApprove={vi.fn()} onClear={vi.fn()} {...over} />,
    );

  it("offers a move to every reachable status and says how many can get there", () => {
    const out = bar();
    expect(out).toContain('role="toolbar"');
    expect(out).toContain("3 selected");
    expect(out).toContain(">Done<");
    expect(out).toContain("Blocked (1 of 3)");
    expect(out).not.toContain("Approve 0");
  });

  it("offers approval only when transition drafts are ticked, and lists each move before it happens", () => {
    const approvable = [{ id: "a", key: "CA-402", from: "Copy", to: "Design" }, { id: "b", key: "WEB-101", from: "Code review", to: "Testing" }];
    expect(bar({ approvable })).toContain("Approve 2 moves…");
    expect(bar({ approvable })).not.toContain("Confirm bulk approval");
    const confirming = bar({ approvable, confirming: true });
    expect(confirming).toContain("Confirm bulk approval");
    expect(confirming).toContain("CA-402: Copy → Design");
    expect(confirming).toContain("WEB-101: Code review → Testing");
    expect(confirming).toContain("Approve all 2");
  });
});

describe("BoardView", () => {
  const board = (items: WorkItem[], filter = ALL) => {
    sync();
    return renderToStaticMarkup(<BoardView tab={tab(filter)} items={items} />);
  };

  it("falls back to the three status categories across projects and names each card's status", () => {
    const out = board(itemsByFilter(s(), ALL));
    expect(out).toContain('aria-label="All projects board"');
    for (const name of ["To do", "In progress", "Done"]) expect(out).toMatch(new RegExp(`aria-label="${name}, \\d+"`));
    expect(out).not.toContain('aria-label="DevOps board"');
    expect(out).toContain("DEVOPS-471");
    expect(out).toContain(">In Review<");
  });

  it("shows one project's own workflow columns when a project is chosen", () => {
    const devops = s().containers["mock:DEVOPS"].ref;
    const filter = { type: "container" as const, container: devops };
    const out = board(itemsByFilter(s(), filter), filter);
    expect(out).toContain('aria-label="DevOps board"');
    expect(out).toContain('aria-label="In Review, 2"');
    expect(out).not.toContain('aria-label="To do,');
  });

  it("shows a pending move as a ghost in the target column and a badge on the card", async () => {
    const wf = s().containers["mock:DEVOPS"].workflow;
    await s().draftTransition(s().items["mock:DEVOPS-490"].item, wf.statuses.find((x) => x.name === "In Review")!);
    const filter = { type: "container" as const, container: s().containers["mock:DEVOPS"].ref };
    const out = board(itemsByFilter(s(), filter), filter);
    expect(out).toContain("Draft: DEVOPS-490 moves here");
    expect(out).toContain("→ In Review (draft)");
  });

  it("says when nothing matches", () => {
    expect(board([])).toContain("Nothing matches this filter");
  });
});

describe("AgeView", () => {
  it("ranks open tickets as bars by default, longest quiet first, without finished ones", () => {
    sync();
    const out = renderToStaticMarkup(<AgeView tab={{ ...tab(), view: "age" }} items={itemsByFilter(s(), ALL)} />);
    expect(out).toContain('aria-label="Open tickets by days quiet"');
    expect(out).not.toContain("DEVOPS-478");
    const days = [...out.matchAll(/quiet for (\d+) days/g)].map((m) => Number(m[1]));
    expect(days.length).toBeGreaterThan(3);
    expect(days).toEqual([...days].sort((a, b) => b - a));
  });

  it("has a column per age bucket, holds open items only, and lets cards wither, when the person picked columns", () => {
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "gossamr-age-layout" ? JSON.stringify("columns") : null), setItem: () => {}, removeItem: () => {} });
    sync();
    const out = renderToStaticMarkup(<AgeView tab={{ ...tab(), view: "age" }} items={itemsByFilter(s(), ALL)} />);
    for (const label of ["Fresh", "This week", "Stale", "Forgotten"]) expect(out).toContain(`aria-label="${label},`);
    expect(out).toContain("ws-wither");
    expect(out).not.toContain('draggable="true"');
    expect(out).not.toContain("DEVOPS-478");
  });
});
