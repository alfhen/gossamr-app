import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { isoWeek, ticketPick, type PlanItem } from "../lib/planMyWeek";
import type { WorkItem, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { buildCommands, rankCommands, type CommandActions } from "./commands";
import { PLAN_EMPTY, PlanMyWeek, PlanMyWeekView, afterMove, afterRemove, ThisWeekView, findTicket, rowStep, CHOICES } from "./PlanMyWeek";
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

  it("says the plan is kept only once it is: before, what keeping does", () => {
    expect(view([pick("CA-1")])).toContain("Keep this plan to see it as This week on Pip home; it stays on this device.");
    expect(view([pick("CA-1")])).not.toContain("Kept on this device");
    expect(view([pick("CA-1")], { kept: true })).toContain("Kept on this device for the week of 12 Oct");
  });

  it("keeps Keep this plan in sight when the card scrolls: its row is sticky at the bottom (G21)", () => {
    expect(view([pick("CA-1")])).toMatch(/data-plan-keep-row="true" class="[^"]*\bsticky bottom-0\b[^"]*"/);
  });

  it("lists each pick in order with its one-line because, and says nothing goes to Jira", () => {
    const html = view([pick("CA-1"), pick("CA-2", { because: "2 things need you here: Draft comment." })]);
    expect(html).toContain("Plan my week");
    expect(html).toContain("week of 12 Oct");
    expect(html).not.toContain("2026-W42");
    expect(html.indexOf("CA-1 Something")).toBeLessThan(html.indexOf("CA-2 Something"));
    expect(html).toContain("Because assigned to you for 4 days, no workstream yet.");
    expect(html).toContain("Because 2 things need you here: Draft comment.");
    expect(html).toContain("Nothing is written to Jira.");
    expect(html).toContain("Keep this plan");
    expect(html).toContain('aria-label="Remove CA-1 Something"');
  });

  it("says Delete removes a row", () => {
    expect(view([pick("CA-1")])).toContain("Alt+ArrowDown Delete");
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

  it("shows several matches to choose from instead of picking one: the person's own first, at most five, taken ones left out", () => {
    const ME = { connectionId: "c", accountId: "me" };
    const mine = (x: WorkItem) => ({ ...x, assignee: ME }) as WorkItem;
    const stock = [t("CA-10", "Stock sync"), mine(t("CA-11", "Restock alert")), t("CA-12", "Stock levels"), t("CA-13", "Old stock", "done")];
    const found = findTicket("stock", stock, [], [ME]);
    expect("choices" in found && found.choices.map((x) => x.item.key)).toEqual(["CA-11", "CA-10", "CA-12"]);
    const taken = [ticketPick(stock[0])];
    expect("choices" in findTicket("stock", stock, taken, [ME]) && (findTicket("stock", stock, taken, [ME]) as { choices: WorkItem[] }).choices.map((x) => x.item.key)).toEqual(["CA-11", "CA-12"]);
    // One left after the taken ones is that ticket, outright.
    expect(findTicket("stock", stock, [ticketPick(stock[0]), ticketPick(stock[1])], [ME])).toEqual({ ticket: stock[2] });
    expect(findTicket("stock", stock, stock.slice(0, 3).map(ticketPick), [ME])).toEqual({ reason: "taken", key: "CA-10" });
    // A key is never a list.
    expect(findTicket("CA-10", stock, [], [ME])).toEqual({ ticket: stock[0] });
    const many = Array.from({ length: 8 }, (_, n) => t(`CA-${20 + n}`, `Stock item ${n}`));
    expect((findTicket("stock", many, []) as { choices: WorkItem[] }).choices).toHaveLength(CHOICES);
    expect(CHOICES).toBe(5);
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

describe("moving between the plan's rows", () => {
  const ev = (key: string, over: Partial<Parameters<typeof rowStep>[0]> = {}) => ({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over });
  it("steps on with ArrowDown or j and back with ArrowUp or k, and leaves modified keys and others alone", () => {
    expect([ev("ArrowDown"), ev("j")].map(rowStep)).toEqual([1, 1]);
    expect([ev("ArrowUp"), ev("k")].map(rowStep)).toEqual([-1, -1]);
    expect(rowStep(ev("ArrowDown", { altKey: true }))).toBe(0);
    expect(rowStep(ev("j", { metaKey: true }))).toBe(0);
    expect(rowStep(ev("ArrowUp", { shiftKey: true }))).toBe(0);
    expect(rowStep(ev("Enter"))).toBe(0);
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

  it("marks a closed-not-done item apart from a done one: a muted mark, a title, its own words", () => {
    const html = renderToStaticMarkup(<ThisWeekView week="2026-W42" items={items} done={new Set()} closed={new Set(["ws:w2"])} onOpen={noop} onEdit={noop} />);
    expect(html).toMatch(/data-this-week-item="ws:w2" data-closed="true" title="[^"]*isn&#x27;t Done in Jira[^"]*"/);
    expect(html).toMatch(/data-closed="true"[^>]*><span aria-hidden="true" class="text-ws-ink3">⊘/);
    expect(html).not.toContain("✓");
    expect(html).toContain('aria-label="Closed, not done: CA-2 Something"');
    expect(html).toContain("closed, not done");
    expect(html).not.toContain("data-done");
  });

  it("says a reopened item's workstream is closed and offers to start one again, only when it can (G16)", () => {
    const html = renderToStaticMarkup(<ThisWeekView week="2026-W42" items={items} done={new Set()} stopped={new Set(["ws:w2"])} onOpen={noop} onEdit={noop} onStart={noop} />);
    expect(html).toContain("data-this-week-stopped");
    expect(html).toContain("workstream closed");
    expect(html).toContain('aria-label="Start a workstream on CA-2 Something"');
    expect(html.match(/data-this-week-stopped/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<ThisWeekView week="2026-W42" items={items} done={new Set()} stopped={new Set(["ws:w2"])} onOpen={noop} onEdit={noop} />)).not.toContain("data-this-week-start");
    expect(renderToStaticMarkup(<ThisWeekView week="2026-W42" items={items} done={new Set()} onOpen={noop} onEdit={noop} onStart={noop} />)).not.toContain("data-this-week-stopped");
  });

  it("does not offer Start again for a workstream without a ticket: there is nothing to start it on", () => {
    const ticketless: PlanItem[] = [{ id: "ws:w5", kind: "workstream", workstreamId: "w5", ticketKey: null, title: "Spike on caching", because: "x.", reopened: true }];
    const html = renderToStaticMarkup(<ThisWeekView week="2026-W42" items={ticketless} done={new Set()} stopped={new Set(["ws:w5"])} onOpen={noop} onEdit={noop} onStart={noop} />);
    expect(html).toContain("workstream closed");
    expect(html).not.toContain("data-this-week-start");
  });

  it("lets a closed title wrap in a readable colour, and caps the section so Workstreams keeps room (G22)", () => {
    const html = renderToStaticMarkup(<ThisWeekView week="2026-W42" items={items} done={new Set()} closed={new Set(["ws:w2"])} onOpen={noop} onEdit={noop} />);
    const closedTitle = /<button[^>]*aria-label="Closed, not done: CA-2 Something"[^>]*>/.exec(html)![0];
    expect(closedTitle).not.toContain("truncate");
    expect(closedTitle).not.toContain("opacity-70");
    expect(closedTitle).toContain("text-ws-ink2");
    expect(html).toContain("max-h-[25%]");
  });

  it("offers Reopen on a done or closed item, and only when it can be reopened", () => {
    const some = <ThisWeekView week="2026-W42" items={items} done={new Set(["ticket:CA-1"])} closed={new Set(["ws:w2"])} onOpen={noop} onEdit={noop} onReopen={noop} />;
    const html = renderToStaticMarkup(some);
    expect(html.match(/data-this-week-reopen/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Reopen CA-1 Something"');
    expect(renderToStaticMarkup(<ThisWeekView week="2026-W42" items={items} done={new Set(["ticket:CA-1"])} onOpen={noop} onEdit={noop} />)).not.toContain("data-this-week-reopen");
    expect(renderToStaticMarkup(<ThisWeekView week="2026-W42" items={items} done={new Set()} onOpen={noop} onEdit={noop} onReopen={noop} />)).not.toContain("data-this-week-reopen");
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
  it("keeps a reopened item reopened across a reload, and no other", () => {
    const now = new Date("2026-10-13T09:00:00Z");
    usePrefs.getState().keepWeekPlan([pick("CA-1"), pick("CA-2")], now);
    usePrefs.getState().reopenWeekPlanItem("2026-W42", "ticket:CA-1");
    const items = loadPrefs().weekPlans["2026-W42"].items;
    expect(items.map((p) => [p.id, p.reopened ?? false])).toEqual([["ticket:CA-1", true], ["ticket:CA-2", false]]);
    usePrefs.getState().reopenWeekPlanItem("2026-W42", "nope");
    expect(usePrefs.getState().weekPlans["2026-W42"].items).toHaveLength(2);
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
    expect(card(new Date(2026, 9, 18, 23, 59).getTime())).toContain("week of 12 Oct");
    expect(card(new Date(2026, 9, 19, 0, 1).getTime())).toContain("week of 19 Oct");
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

  it("keeps the open workstream listed, dimmed and said so, when the filter leaves it out, and counts only the matching", () => {
    const idle = open[0].workstream.id;
    const out = html({ statusFilter: "held", selected: idle });
    expect([...out.matchAll(/data-workstream-row="([^"]+)"/g)].map((m) => m[1])).toEqual(["general", idle, open[1].workstream.id]);
    expect(out).toContain("Showing Held: 1");
    expect(out).toMatch(new RegExp(`data-workstream-row="${idle}"[^>]*data-filtered-out`));
    expect(out).toContain("opacity-60");
    expect(out).toContain("Shown because it is open; not Held");
    expect(out.match(/data-filter-shown/g)).toHaveLength(1);
    // Nothing matches: the empty line still says so, with the open one still shown.
    const none = html({ statusFilter: "waiting", selected: idle });
    expect(none).toContain("No workstream is waiting on the reporter.");
    expect(none).toContain("Showing Waiting on reporter: 0");
    expect(none).toContain("data-filter-shown");
    // Without a filter, or with the open one in it, no note.
    expect(html({ selected: idle })).not.toContain("data-filter-shown");
    expect(html({ statusFilter: "held", selected: open[1].workstream.id })).not.toContain("data-filter-shown");
  });

  it("says an idle workstream may be unclear while its notice stands, and not once Looks fine taught the gaps away", () => {
    const thin = [{ ...open[0], clarity: { gaps: ["short" as const] } }, open[1]];
    const detail = /data-status-detail[^>]*>· may be unclear</;
    expect(html({ list: thin })).toMatch(detail);
    expect(html({ list: thin })).not.toContain('data-status="needs-you"');
    expect(html({ list: thin, learning: { CA: { short: 3 } } })).not.toMatch(detail);
    expect(html({ list: thin, learning: { WEB: { short: 3 } } })).toMatch(detail);
  });
});
