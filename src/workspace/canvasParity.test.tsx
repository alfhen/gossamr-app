import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { ALL, itemKey, YOUR_TURN_WHY } from "../lib/filter";
import type { FeedEntry, StatusDef, WorkItem } from "../types";
import { itemsByFilter, useWorkspace } from "../workspaceStore";
import { moveHint } from "./boardLogic";
import { WorkflowLine } from "./BoardView";
import { AgeChip, AttentionDot, StatusPill } from "./CanvasBits";
import { ageLevel, initials, progressOf, selectHow, showsAge, statusTone, unreadItems } from "./canvasShared";
import { GroupHeader, ListRow } from "./ListView";
import { listGroups, selectionAfterCollapse, visibleOrder } from "./listLogic";
import { stepKey } from "./peekLogic";
import type { BoardSection } from "./boardLogic";

const s = () => useWorkspace.getState();
const NOW = new Date("2026-09-30T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

beforeEach(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  await s().init(new MockBackend());
});

const status = (name: string, category: StatusDef["category"]): StatusDef => ({ id: name, name, category });
const item = (key: string, over: Partial<WorkItem> = {}): WorkItem => ({
  ...s().items["mock:DEVOPS-473"],
  item: { connectionId: "mock", externalId: key, key },
  parent: null,
  links: [],
  updated: daysAgo(0),
  ...over,
});
const all = () => itemsByFilter(s(), ALL);

describe("shared canvas helpers", () => {
  it("turns the age chip amber at 3 days, orange at 5 and red at 7", () => {
    expect([0, 2, 3, 4, 5, 6, 7, 30].map(ageLevel)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it("shows age only for open work that has been quiet two days", () => {
    expect(showsAge(item("A-1"), 1)).toBe(false);
    expect(showsAge(item("A-1"), 2)).toBe(true);
    expect(showsAge(item("A-1", { status: status("Done", "done") }), 40)).toBe(false);
  });

  it("makes initials from up to two words and a question mark for nobody", () => {
    expect(initials("Sam Holt")).toBe("SH");
    expect(initials("Mary Ann Smith")).toBe("MA");
    expect(initials("")).toBe("?");
    expect(initials("😀 smile")).toBe("😀S");
  });

  it("tells review, blocked and finished statuses apart from plain ones", () => {
    expect(statusTone(status("Code review", "active"))).toBe("review");
    expect(statusTone(status("QA", "active"))).toBe("review");
    expect(statusTone(status("Blocked", "active"))).toBe("blocked");
    expect(statusTone(status("In Progress", "active"))).toBe("active");
    expect(statusTone(status("Reviewed", "done"))).toBe("done");
    expect(statusTone(status("Backlog", "todo"))).toBe("todo");
  });

  it("finds the items that have an unread feed entry", () => {
    const entry = (id: string, key: string, unread: boolean) => ({ id, item: { connectionId: "mock", externalId: key, key }, unread }) as FeedEntry;
    expect([...unreadItems([entry("1", "A-1", true), entry("2", "A-2", false), entry("3", "A-1", false)])]).toEqual(["mock:A-1"]);
  });

  it("counts progress, and says 0 percent of nothing", () => {
    const p = progressOf([item("A-1", { status: status("Done", "done") }), item("A-2"), item("A-3")]);
    expect(p).toEqual({ done: 1, total: 3, percent: 33 });
    expect(progressOf([]).percent).toBe(0);
  });

  it("reads the modifier keys into a selection mode", () => {
    const k = (over: object) => ({ shiftKey: false, metaKey: false, ctrlKey: false, ...over });
    expect(selectHow(k({}))).toBe("one");
    expect(selectHow(k({ shiftKey: true }))).toBe("range");
    expect(selectHow(k({ metaKey: true }))).toBe("toggle");
    expect(selectHow(k({ ctrlKey: true }))).toBe("toggle");
  });
});

describe("listGroups", () => {
  it("groups children under their epic and leaves the epic out of the rows", () => {
    const groups = listGroups(all(), s().items, s().containers);
    const epic = groups.find((g) => g.sub === "DEVOPS-470")!;
    expect(epic.label).toBe("Checkout resilience");
    expect(epic.parentKey).toBe("mock:DEVOPS-470");
    expect(groups.flatMap((g) => g.items).some((i) => itemKey(i.item) === "mock:DEVOPS-470")).toBe(false);
    expect(epic.items.every((i) => i.parent && itemKey(i.parent) === "mock:DEVOPS-470")).toBe(true);
  });

  it("puts what has no epic under its project, after the epics", () => {
    const groups = listGroups(all(), s().items, s().containers);
    const loose = groups.filter((g) => !g.parentKey);
    expect(loose.length).toBeGreaterThan(0);
    expect(loose.every((g) => g.label === "No epic")).toBe(true);
    expect(loose.map((g) => g.sub)).toContain("DEVOPS");
    const firstLoose = groups.findIndex((g) => !g.parentKey);
    expect(groups.slice(firstLoose).every((g) => !g.parentKey)).toBe(true);
  });

  it("measures an epic's progress over every child, not only the ones the filter shows", () => {
    const children = Object.values(s().items).filter((i) => i.parent && itemKey(i.parent) === "mock:DEVOPS-480");
    const one = children.slice(0, 1);
    const [group] = listGroups(one, s().items, s().containers);
    expect(group.items).toHaveLength(1);
    expect(group.progress.total).toBe(children.length);
    expect(group.progress.done).toBe(children.filter((i) => i.status.category === "done").length);
  });

  it("orders rows as they are given within a group", () => {
    const loose = all().filter((i) => !i.parent && i.container.externalId === "DEVOPS");
    const group = listGroups([...loose].reverse(), s().items, s().containers).find((g) => g.sub === "DEVOPS" && !g.parentKey)!;
    expect(group.items.map((i) => i.item.key)).toEqual([...loose].reverse().filter((i) => group.items.includes(i)).map((i) => i.item.key));
  });
});

describe("list order for j and k", () => {
  const groups = () => listGroups(all(), s().items, s().containers);

  it("runs top to bottom through the groups", () => {
    expect(visibleOrder(groups(), new Set())).toEqual(groups().flatMap((g) => g.items.map((i) => itemKey(i.item))));
  });

  it("skips the rows of a collapsed group", () => {
    const g = groups();
    const hidden = new Set([g[0].key]);
    const order = visibleOrder(g, hidden);
    for (const i of g[0].items) expect(order).not.toContain(itemKey(i.item));
    expect(order.length).toBe(visibleOrder(g, new Set()).length - g[0].items.length);
    const last = itemKey(g[0].items[0].item);
    expect(stepKey(order, last, 1)).toBe(order[0]);
  });

  it("moves a selection that a collapse hides to the next visible row, else the previous", () => {
    const g = groups();
    const inFirst = itemKey(g[0].items[0].item);
    expect(selectionAfterCollapse(g, new Set([g[0].key]), inFirst)).toBe(itemKey(g[1].items[0].item));
    expect(selectionAfterCollapse(g, new Set(), inFirst)).toBeNull();
    expect(selectionAfterCollapse(g, new Set([g[1].key]), inFirst)).toBeNull();
    const last = g[g.length - 1];
    const before = itemKey(g[g.length - 2].items[g[g.length - 2].items.length - 1].item);
    expect(selectionAfterCollapse(g, new Set([last.key]), itemKey(last.items[0].item))).toBe(before);
    expect(selectionAfterCollapse(g, new Set(g.map((x) => x.key)), inFirst)).toBeNull();
    expect(selectionAfterCollapse(g, new Set([g[0].key]), null)).toBeNull();
  });

  it("steps from the last visible row of a group into the next group", () => {
    const g = groups();
    const order = visibleOrder(g, new Set());
    const lastOfFirst = itemKey(g[0].items[g[0].items.length - 1].item);
    expect(stepKey(order, lastOfFirst, 1)).toBe(itemKey(g[1].items[0].item));
  });
});

const rowProps = (over: Partial<Parameters<typeof ListRow>[0]> = {}): Parameters<typeof ListRow>[0] => ({
  item: item("DEVOPS-9", { title: "Fix the thing", status: status("In Progress", "active"), updated: daysAgo(6) }),
  assignee: "Jonas Berg",
  now: NOW,
  blocked: false,
  needsMe: false,
  unread: false,
  draft: null,
  moreDrafts: 0,
  selected: false,
  marked: false,
  onSelect: vi.fn(),
  ...over,
});

describe("ListRow", () => {
  it("shows key, title, age, status and assignee initials", () => {
    const out = renderToStaticMarkup(<ListRow {...rowProps()} />);
    expect(out).toContain("DEVOPS-9");
    expect(out).toContain("Fix the thing");
    expect(out).toMatch(/No update for 6 days[^>]*>6d</);
    expect(out).toContain("text-[#d2701f]");
    expect(out).toContain(">JB<");
    expect(out).toContain("In Progress");
  });

  it("marks what needs the person, what is unread, blocked and drafted", () => {
    const out = renderToStaticMarkup(<ListRow {...rowProps({ needsMe: true, blocked: true, draft: { id: "d", to: "Done" }, moreDrafts: 2 })} />);
    expect(out).toContain('aria-label="Your turn"');
    expect(out).toContain(`title="${YOUR_TURN_WHY}"`);
    expect(out).toContain("Your turn</span>");
    expect(out).not.toContain("Needs you");
    expect(out).toContain("blocked");
    expect(out).toContain("draft → Done");
    expect(out).toContain("data-pip-glyph");
    expect(out).toContain("</svg> 2");
    expect(renderToStaticMarkup(<ListRow {...rowProps({ unread: true })} />)).toContain('aria-label="Unread updates"');
    expect(renderToStaticMarkup(<ListRow {...rowProps()} />)).not.toContain("role=\"img\"");
  });

  it("has no age chip for finished work and flags selection and ticks", () => {
    const done = renderToStaticMarkup(<ListRow {...rowProps({ item: item("D-1", { status: status("Done", "done"), updated: daysAgo(30) }) })} />);
    expect(done).not.toContain("No update for");
    const on = renderToStaticMarkup(<ListRow {...rowProps({ selected: true })} />);
    expect(on).toContain('aria-selected="true"');
    const ticked = renderToStaticMarkup(<ListRow {...rowProps({ marked: true })} />);
    expect(ticked).toContain("Ticked for a bulk action");
    expect(ticked).toContain('data-marked="true"');
  });
});

describe("GroupHeader", () => {
  const group = () => listGroups(all(), s().items, s().containers).find((g) => g.sub === "DEVOPS-480")!;

  it("shows the epic, its done count and a progress bar", () => {
    const g = group();
    const out = renderToStaticMarkup(<GroupHeader group={g} collapsed={false} onToggle={vi.fn()} />);
    expect(out).toContain("DEVOPS-480");
    expect(out).toContain("Shopify event pipeline");
    expect(out).toContain(`${g.progress.done}/${g.progress.total} done`);
    expect(out).toContain('role="progressbar"');
    expect(out).toContain(`aria-valuenow="${g.progress.percent}"`);
    expect(out).toContain('aria-expanded="true"');
  });

  it("says when it is collapsed, and counts items instead of progress for a project", () => {
    expect(renderToStaticMarkup(<GroupHeader group={group()} collapsed onToggle={vi.fn()} />)).toContain('aria-expanded="false"');
    const loose = listGroups(all(), s().items, s().containers).find((g) => !g.parentKey)!;
    const out = renderToStaticMarkup(<GroupHeader group={loose} collapsed={false} onToggle={vi.fn()} />);
    expect(out).toContain("No epic");
    expect(out).not.toContain("progressbar");
    expect(out).toMatch(/\d+ items?/);
  });
});

describe("board workflow line", () => {
  const section = (): BoardSection => {
    const c = s().containers["mock:DEVOPS"];
    return { key: "mock:DEVOPS", name: c.name, code: c.key, workflow: c.workflow, columns: [], count: 0 };
  };

  it("lists the project's statuses in order with what each can move to", () => {
    const out = renderToStaticMarkup(<WorkflowLine section={section()} />);
    expect(out).toContain("DevOps workflow");
    const names = section().workflow.statuses.map((x) => x.name);
    const at = names.map((n) => out.indexOf(`>${n}</span>`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(out).toContain("Can move to");
  });

  it("explains the categories when no project is picked", () => {
    expect(renderToStaticMarkup(<WorkflowLine section={null} />)).toContain("Columns are status categories");
  });

  it("gives no hint where moves are revealed per ticket", () => {
    const wf = { statuses: [status("To Do", "todo")], transitions: { kind: "graph" as const, moves: [] } };
    expect(moveHint(wf, wf.statuses[0])).toBeUndefined();
    expect(moveHint({ ...wf, transitions: { kind: "any" } }, wf.statuses[0])).toBe("Can move to any status");
  });
});

describe("markers on the other canvases", () => {
  it("renders the dot, pill and chip parts on their own", () => {
    expect(renderToStaticMarkup(<AttentionDot needsMe={false} unread={false} />)).toBe("");
    expect(renderToStaticMarkup(<AttentionDot needsMe unread />)).toContain("bg-ws-pip");
    expect(renderToStaticMarkup(<AgeChip days={12} />)).toContain("text-ws-blocked");
    expect(renderToStaticMarkup(<StatusPill status={status("In Review", "active")} />)).toContain("--color-ws-review");
  });
});
