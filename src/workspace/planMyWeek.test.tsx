import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { isoWeek, ticketPick, type PlanItem } from "../lib/planMyWeek";
import type { WorkItem, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { buildCommands, rankCommands, type CommandActions } from "./commands";
import { PLAN_EMPTY, PlanMyWeek, PlanMyWeekView, afterMove, afterRemove, ThisWeekView, findTicket } from "./PlanMyWeek";
import { WorkstreamList } from "./PipHome";
import { usePipHome } from "./pipHomeStore";
import { loadPrefs, usePrefs } from "./prefs";
import { StartMyDayView } from "./StartMyDay";
import { useWorkstreams } from "./workstreamsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

const pick = (key: string, over: Partial<PlanItem> = {}): PlanItem => ({ id: `ticket:${key}`, kind: "ticket", workstreamId: null, ticketKey: key, title: `${key} Something`, because: "assigned to you for 4 days, no workstream yet.", ...over });
const noop = () => undefined;

beforeEach(() => void vi.stubGlobal("localStorage", memory()));
afterEach(() => {
  usePipHome.getState().reset();
  usePrefs.setState({ weekPlans: {} });
  vi.unstubAllGlobals();
});

describe("the Plan my week card", () => {
  const view = (picks: PlanItem[], over: Partial<Parameters<typeof PlanMyWeekView>[0]> = {}) =>
    renderToStaticMarkup(<PlanMyWeekView week="2026-W42" picks={picks} kept={false} tickets={[]} onChange={noop} onKeep={noop} onClose={noop} onPropose={noop} {...over} />);

  it("lists each pick in order with its one-line because, and says nothing goes to Jira", () => {
    const html = view([pick("CA-1"), pick("CA-2", { because: "2 things need you here: Draft comment." })]);
    expect(html).toContain("Plan my week");
    expect(html).toContain("2026-W42");
    expect(html.indexOf("CA-1 Something")).toBeLessThan(html.indexOf("CA-2 Something"));
    expect(html).toContain("Because assigned to you for 4 days, no workstream yet.");
    expect(html).toContain("Because 2 things need you here: Draft comment.");
    expect(html).toContain("Nothing is written to Jira.");
    expect(html).toContain("Keep this plan");
    expect(html).toContain('aria-label="Remove CA-1 Something"');
  });

  it("offers up and down, with the first's up and the last's down off, and says Alt and the arrows move a row", () => {
    const html = view([pick("CA-1"), pick("CA-2")]);
    expect(html).toMatch(/aria-label="Move CA-1 Something up" disabled/);
    expect(html).toMatch(/aria-label="Move CA-2 Something down" disabled/);
    expect(html).not.toMatch(/aria-label="Move CA-1 Something down" disabled/);
    expect(html).toContain("Alt and the arrow keys move it.");
    expect(html).toContain('draggable="true"');
  });

  it("says so when nothing is free, and keeps the add field", () => {
    const html = view([]);
    expect(html).toContain(PLAN_EMPTY);
    expect(html).toContain("data-plan-add");
  });

  it("says Start over once the week has a kept plan", () => {
    expect(view([pick("CA-1")], { kept: true })).toContain("Start over");
    expect(view([pick("CA-1")])).toContain("Propose again");
  });
});

describe("where the keyboard goes after a remove or a move", () => {
  const three = [pick("CA-1"), pick("CA-2"), pick("CA-3")];
  it("lands on the pick now in the removed one's place, else the one before it, else the add box", () => {
    // Middle row removed: CA-3 moved up into its index.
    expect(afterRemove([three[0], three[2]], 1)).toBe("ticket:CA-3");
    // Last row removed: the one before it.
    expect(afterRemove([three[0], three[1]], 2)).toBe("ticket:CA-2");
    expect(afterRemove([], 0)).toBeNull();
  });

  it("follows a moved row to the same button, the other one at the end of the list, else the row", () => {
    expect(afterMove("down", 1, 3)).toBe("down");
    expect(afterMove("up", 1, 3)).toBe("up");
    // Moved down to the last place: its down is off, so the up takes it.
    expect(afterMove("down", 2, 3)).toBe("up");
    expect(afterMove("up", 0, 3)).toBe("down");
    expect(afterMove("up", 0, 1)).toBe("row");
  });

  it("marks the move buttons the focus follows", () => {
    const html = renderToStaticMarkup(<PlanMyWeekView week="2026-W42" picks={three} kept={false} tickets={[]} onChange={noop} onKeep={noop} onClose={noop} onPropose={noop} />);
    expect(html.match(/data-plan-move="up"/g)).toHaveLength(3);
    expect(html.match(/data-plan-move="down"/g)).toHaveLength(3);
  });
});

describe("adding a ticket", () => {
  const t = (key: string, title: string, category: "todo" | "done" = "todo") => ({ item: { connectionId: "c", externalId: key, key }, title, status: { id: "1", name: "x", category } }) as unknown as WorkItem;
  const tickets = [t("CA-1", "Fix the checkout total"), t("CA-2", "Subject line variants"), t("CA-3", "Old thing", "done")];
  it("finds a ticket by key or words, never one that is Done", () => {
    const key = (words: string, taken: Parameters<typeof findTicket>[2] = []) => {
      const f = findTicket(words, tickets, taken);
      return "ticket" in f ? f.ticket.item.key : f;
    };
    expect(key("ca-2")).toBe("CA-2");
    expect(key("CA-2 subject")).toBe("CA-2");
    expect(key("checkout")).toBe("CA-1");
    expect(key("old thing")).toEqual({ reason: "none" });
    expect(key("  ")).toEqual({ reason: "none" });
  });

  it("tells a ticket that is in the plan already from one that does not match", () => {
    expect(findTicket("CA-2", tickets, [ticketPick(tickets[1])])).toEqual({ reason: "taken", key: "CA-2" });
    expect(findTicket("subject", tickets, [ticketPick(tickets[1])])).toEqual({ reason: "taken", key: "CA-2" });
    expect(findTicket("CA-99", tickets, [ticketPick(tickets[1])])).toEqual({ reason: "none" });
    // The same key on another connection is another ticket, so it can still be added.
    const other = { ...tickets[1], item: { ...tickets[1].item, connectionId: "d" } } as WorkItem;
    const found = findTicket("CA-2", [other], [ticketPick(tickets[1])]);
    expect("ticket" in found && found.ticket.item.connectionId).toBe("d");
  });
});

describe("the This week list", () => {
  const items = [pick("CA-1"), pick("CA-2", { id: "ws:w2", kind: "workstream", workstreamId: "w2" })];
  it("lists the kept items as links, ticking the ones that are done", () => {
    const html = renderToStaticMarkup(<ThisWeekView week="2026-W42" items={items} done={new Set(["ws:w2"])} onOpen={noop} onEdit={noop} />);
    expect(html).toContain('data-this-week="2026-W42"');
    expect(html).toContain("This week");
    expect(html).toMatch(/data-this-week-item="ticket:CA-1"[^>]*><span aria-hidden="true" class="text-ws-ink3">○/);
    expect(html).toMatch(/data-this-week-item="ws:w2" data-done="true"[^>]*><span aria-hidden="true" class="text-ws-done">✓/);
    expect(html).toContain('aria-label="Done: CA-2 Something"');
    expect(html).toContain('aria-label="CA-1 Something"');
  });
});

describe("Start my day links to the plan", () => {
  it("has a Plan my week button when given the action", () => {
    const day = { lines: [], empty: true };
    expect(renderToStaticMarkup(<StartMyDayView day={day} onDone={noop} onSent={noop} onPlan={noop} />)).toContain("data-day-plan");
    expect(renderToStaticMarkup(<StartMyDayView day={day} onDone={noop} onSent={noop} />)).not.toContain("data-day-plan");
  });
});

describe("the stored plan", () => {
  it("is kept per ISO week in the prefs, survives a reload, and replaces that week's earlier plan", () => {
    const now = new Date("2026-10-13T09:00:00Z");
    usePrefs.getState().keepWeekPlan([pick("CA-1"), pick("CA-2")], now);
    usePrefs.getState().keepWeekPlan([pick("CA-3")], new Date("2026-10-14T09:00:00Z"));
    usePrefs.getState().keepWeekPlan([pick("CA-4")], new Date("2026-10-20T09:00:00Z"));
    expect(Object.keys(usePrefs.getState().weekPlans)).toEqual(["2026-W42", "2026-W43"]);
    const stored = loadPrefs().weekPlans;
    expect(stored[isoWeek(now)].items.map((p) => p.id)).toEqual(["ticket:CA-3"]);
    expect(stored["2026-W43"].items.map((p) => p.id)).toEqual(["ticket:CA-4"]);
  });
  it("writes nothing to Jira: keeping touches only the prefs", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    await useWorkspace.getState().init(backend);
    const before = Object.keys(useWorkspace.getState().proposals).length;
    usePrefs.getState().keepWeekPlan([pick("CA-1")]);
    expect(Object.keys(useWorkspace.getState().proposals)).toHaveLength(before);
  });
});

describe("the card across a week boundary", () => {
  // PipHome keys the card by the ISO week of its clock, so the card remounts when the week turns and takes the new week's kept plan.
  it("is keyed by the week, which turns only at the boundary", () => {
    const sunday = new Date(2026, 9, 18, 23, 59).getTime();
    const monday = new Date(2026, 9, 19, 0, 1).getTime();
    expect(isoWeek(new Date(sunday))).toBe("2026-W42");
    expect(isoWeek(new Date(monday))).toBe("2026-W43");
    expect(isoWeek(new Date(sunday - 3 * 86_400_000))).toBe(isoWeek(new Date(sunday)));
  });
  it("a card mounted after the boundary is the new week's: its title and Keep target the week of the clock it got", () => {
    const card = (now: number) => renderToStaticMarkup(<PlanMyWeek key={isoWeek(new Date(now))} needs={[]} withers={{}} now={now} />);
    expect(card(new Date(2026, 9, 18, 23, 59).getTime())).toContain("2026-W42");
    expect(card(new Date(2026, 9, 19, 0, 1).getTime())).toContain("2026-W43");
  });
});

describe("the palette", () => {
  const actions = () => ({ planMyWeek: vi.fn(), showWorkstreamStatus: vi.fn(), startMyDay: vi.fn() }) as unknown as CommandActions & { planMyWeek: ReturnType<typeof vi.fn>; showWorkstreamStatus: ReturnType<typeof vi.fn> };
  const ctx = { project: null, view: null, unreadActivity: 0, agents: true };

  it("finds Plan my week, and runs it", () => {
    const a = actions();
    const found = rankCommands(buildCommands([], [], a, ctx), "plan my week");
    expect(found[0].label).toBe("Plan my week");
    found[0].run();
    expect(a.planMyWeek).toHaveBeenCalled();
  });

  it("filters the workstream list by status: 'waiting on reporter' finds its entry, which narrows the list", () => {
    const a = actions();
    const found = rankCommands(buildCommands([], [], a, ctx), "show workstreams waiting on reporter");
    expect(found[0].label).toBe("Show workstreams waiting on reporter");
    found[0].run();
    expect(a.showWorkstreamStatus).toHaveBeenCalledWith("waiting");
    expect(rankCommands(buildCommands([], [], a, ctx), "show workstreams").map((c) => c.id).filter((id) => id.startsWith("workstreams:status:"))).toHaveLength(7);
  });

  it("offers 'Show all workstreams' only while narrowed", () => {
    const a = actions();
    expect(buildCommands([], [], a, ctx).some((c) => c.id === "workstreams:status:all")).toBe(false);
    const narrowed = buildCommands([], [], a, { ...ctx, statusFilter: "quiet" });
    narrowed.find((c) => c.id === "workstreams:status:all")!.run();
    expect(a.showWorkstreamStatus).toHaveBeenCalledWith(null);
  });

  it("has neither without Agents", () => {
    expect(buildCommands([], [], actions(), { ...ctx, agents: false }).some((c) => c.id === "app:plan-my-week" || c.id.startsWith("workstreams:status:"))).toBe(false);
  });
});

describe("the workstream list's status", () => {
  let open: WorkstreamView[];
  beforeEach(async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    await useWorkspace.getState().init(backend);
    await backend.workstreamsOpen(itemRef("CA-401"));
    await backend.workstreamsOpen(itemRef("CA-402"));
    open = await backend.workstreamsList();
    open[1] = { ...open[1], workstream: { ...open[1].workstream, heldReason: "person" } };
  });
  afterEach(() => useWorkstreams.getState().dispose());
  const html = (over: Partial<Parameters<typeof WorkstreamList>[0]> = {}) => renderToStaticMarkup(<WorkstreamList list={open} closed={[]} showClosed={false} selected={null} onSelect={noop} onShowClosed={noop} {...over} />);

  it("gives each row one status word as a pill, and a held-by-you one says so", () => {
    const out = html();
    const rows = out.split('data-workstream-row="').slice(2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/data-status="idle"[^>]*>Idle</);
    expect(rows[1]).toMatch(/data-status="held"[^>]*>Held by you</);
    expect(rows.every((r) => (r.match(/data-status=/g) ?? []).length === 1)).toBe(true);
  });

  it("lists only the workstreams in the filtered state, and says how to show them all", () => {
    const only = html({ statusFilter: "held" });
    expect(only).toContain('data-status-filter="held"');
    expect(only).toContain("Showing Held: 1");
    expect(only).toContain("Show all");
    expect([...only.matchAll(/data-workstream-row="([^"]+)" role="option"/g)].map((m) => m[1])).toEqual(["general", open[1].workstream.id]);
    expect(html({ statusFilter: "waiting" })).toContain("No workstream is waiting on the reporter.");
  });
});
