import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { containerRef } from "../backend/mockConnector";
import { namesCommand, askToPlanCommands, buildCommands, workstreamCommands, keyCommand, newTicketIntent, projectChoices, pullCommand, rankCommands, searchOrder, ticketCommands, unwatchCommands, watchCommands, withAskPip, type CommandActions } from "./commands";
import { BUILT_IN_VIEWS } from "./filters";
import type { WorkItem } from "../types";

const containers = await new MockBackend().cacheContainers();
const items = await new MockBackend().cacheSearch({ type: "and", filters: [] });

const actions = () => {
  const a = Object.fromEntries(
    ["goToProject", "openSavedView", "setView", "addFilter", "clearFilters", "setTheme", "openSettings", "manageProjects", "watch", "openTicket", "openActivity", "openDrafts", "newTab", "newTicket", "togglePip", "showNeedsYou", "openAgentSafety", "startWorkstream", "closeWorkstream", "jumpToItem", "askPip", "openAgents", "openWorkstream", "askPipToPlan", "startWorkstreamOn", "openJiraSent"].map((k) => [k, vi.fn()]),
  );
  return a as unknown as CommandActions & Record<keyof CommandActions, ReturnType<typeof vi.fn>>;
};

describe("palette commands", () => {
  const a = actions();
  const commands = buildCommands(containers, BUILT_IN_VIEWS, a);
  const find = (q: string) => rankCommands(commands, q).map((c) => c.label);

  it("lists everything for an empty query", () => {
    expect(rankCommands(commands, "  ")).toHaveLength(commands.length);
  });

  it("finds projects by name or key", () => {
    expect(find("devops")[0]).toBe("DevOps");
    expect(find("web")).toContain("Webshop");
  });

  it("finds the four filters by their plain words", () => {
    expect(find("assigned to me")).toContain("Filter: Assigned to me");
    expect(find("stale")).toContain("Filter: Stale");
    expect(find("blocked")).toContain("Filter: Blocked");
    expect(find("your turn")).toContain("Filter: Your turn");
    // Its old name still finds it.
    expect(find("needs me")).toContain("Filter: Your turn");
  });

  it("switches view, theme and settings", () => {
    rankCommands(commands, "show map")[0].run();
    rankCommands(commands, "theme dark")[0].run();
    rankCommands(commands, "settings")[0].run();
    expect(a.setView).toHaveBeenCalledWith("map");
    expect(a.setTheme).toHaveBeenCalledWith("dark");
    expect(a.openSettings).toHaveBeenCalled();
  });

  it("sets a project and a filter", () => {
    rankCommands(commands, "webshop")[0].run();
    rankCommands(commands, "filter blocked")[0].run();
    expect(a.goToProject).toHaveBeenCalledWith(containerRef("WEB"));
    expect(a.addFilter).toHaveBeenCalledWith({ type: "blocked" });
  });

  it("matches nothing for gibberish", () => {
    expect(find("zzzqq")).toEqual([]);
  });
});

describe("a command word outranks tickets", () => {
  const a = actions();
  const ctx = { project: null, view: "list" as const, unreadActivity: 0, github: false, needsYou: 0, ticket: null, onAgents: false };
  const commands = buildCommands(containers, BUILT_IN_VIEWS, a, ctx);
  const ticket = (key: string, title: string): WorkItem => ({ ...items[0], title, item: { ...items[0].item, key, externalId: key } });
  const tickets = [ticket("CA-900", "Runs of the nightly sync fail"), ticket("CA-901", "Timeline of agents is blank"), ticket("CA-902", "Retry failed payment")];
  const order = (q: string) => {
    const o = searchOrder(ticketCommands(tickets, q, vi.fn()), rankCommands(commands, q), q);
    return [...o.head, ...o.tickets, ...o.commands].map((c) => c.label);
  };

  it("names a command by a word of its title or keywords, whole or begun", () => {
    const open = commands.find((c) => c.label === "Open Agents")!;
    for (const q of ["runn", "agents", "oper", "stop all", "open agents"]) expect(namesCommand(open, q), q).toBe(true);
    expect(namesCommand(open, "payment")).toBe(false);
    expect(namesCommand(open, "ents")).toBe(false);
    expect(namesCommand(open, "  ")).toBe(false);
  });

  it("puts the commands a command word names above the tickets it also matches", () => {
    // "running" is a keyword of Open Agents: it comes before the ticket whose title has "runs" nowhere near it, and "agents" before the ticket that says it.
    expect(order("running")[0]).toBe("Open Agents");
    const agents = order("agents");
    expect(agents.indexOf("Open Agents")).toBeLessThan(agents.indexOf("Timeline of agents is blank"));
  });

  it("keeps fuzzy ticket search, and a ticket key typed first", () => {
    expect(order("nightly")[0]).toBe("Runs of the nightly sync fail");
    expect(order("retry fail")[0]).toBe("Retry failed payment");
    expect(order("ca-901")[0]).toBe("Timeline of agents is blank");
  });
});

describe("ticket jump", () => {
  it("puts an exact key first", () => {
    const [first] = ticketCommands(items, "devops-471", vi.fn());
    expect(first.hint).toBe("DEVOPS-471");
  });

  it("finds by title text and runs with the item", () => {
    const jump = vi.fn();
    const found = ticketCommands(items, "retry failed payment", jump);
    expect(found[0].hint).toBe("DEVOPS-471");
    found[0].run();
    expect(jump).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/Retry failed payment/) }));
  });

  it("offers no tickets before anything is typed", () => {
    expect(ticketCommands(items, "", vi.fn())).toEqual([]);
  });
});

describe("palette extras", () => {
  const a = actions();
  const commands = buildCommands(containers, BUILT_IN_VIEWS, a);

  it("gives every entry an icon and keeps each group together when nothing is typed", () => {
    expect(commands.every((c) => c.icon)).toBe(true);
    const groups = commands.map((c) => c.group);
    expect(new Set(groups).size).toBe(groups.filter((g, i) => g !== groups[i - 1]).length);
  });

  it("shows live counts beside Activity and Drafts, and marks what is current", () => {
    const ctx = { project: containerRef("CA"), view: "board" as const, unreadActivity: 22 };
    const live = buildCommands(containers, BUILT_IN_VIEWS, a, ctx);
    const hint = (id: string) => live.find((c) => c.id === id)?.hint;
    expect(hint("app:activity")).toBe("22 new");
    // Drafts are counted once, in Needs you, so Open drafts carries no number of its own.
    expect(hint("app:drafts")).toBeUndefined();
    expect(hint("project:CA")).toBe("current");
    expect(hint("mode:board")).toBe("current");
    expect(hint("mode:list")).toBeUndefined();
    expect(hint("project:all")).toBeUndefined();
    expect(buildCommands(containers, [], a).find((c) => c.id === "app:drafts")?.hint).toBeUndefined();
  });

  it("starts the new-ticket prompt without closing the palette", () => {
    const entry = commands.find((c) => c.id === "create:ticket")!;
    expect(entry.stay).toBe(true);
    entry.run();
    expect(a.newTicket).toHaveBeenCalled();
  });

  it("ends any non-empty query with Ask Pip, and offers only that when nothing matches", () => {
    const ask = vi.fn();
    const matched = withAskPip(rankCommands(commands, "devops"), "devops", ask);
    expect(matched[0].label).toBe("DevOps");
    expect(matched[matched.length - 1]).toMatchObject({ id: "ask:pip", group: "Ask Pip", label: "Ask Pip: “devops”" });
    const none = withAskPip(rankCommands(commands, "zzzqq"), " zzzqq ", ask);
    expect(none.map((c) => c.id)).toEqual(["ask:pip"]);
    none[0].run();
    expect(ask).toHaveBeenCalledWith("zzzqq");
  });

  it("leaves the list alone for an empty query", () => {
    expect(withAskPip(commands, "  ", vi.fn())).toEqual(commands);
  });

  it("puts the project on screen first in the new-ticket prompt", () => {
    const pick = vi.fn();
    const all = projectChoices(containers, "", containerRef("WEB"), pick);
    expect(all[0].hint).toBe("WEB");
    expect(all).toHaveLength(containers.length);
    expect(all.every((c) => c.stay)).toBe(true);
    expect(projectChoices(containers, "dev", null, pick).map((c) => c.hint)).toEqual(["DEVOPS"]);
    all[0].run();
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ key: "WEB" }));
  });

  it("drafts a plain task in the chosen project with the title trimmed", () => {
    expect(newTicketIntent(containerRef("CA"), "  Rotate keys ")).toEqual({
      type: "create",
      container: containerRef("CA"),
      fields: { title: "Rotate keys", body: { blocks: [] }, kind: "task", assignee: null, parent: null, priority: null, labels: [] },
      link: null,
    });
  });
});

describe("watch commands", () => {
  const a = actions();
  const target = { ref: containerRef("SUP"), key: "SUP", name: "Support" };

  it("lists Manage projects in the Projects group and runs it", () => {
    const manage = buildCommands(containers, BUILT_IN_VIEWS, a).find((c) => c.label === "Manage projects")!;
    expect(manage.group).toBe("Projects");
    manage.run();
    expect(a.manageProjects).toHaveBeenCalled();
    expect(rankCommands(buildCommands(containers, BUILT_IN_VIEWS, a), "watch").map((c) => c.label)).toContain("Manage projects");
  });

  it("offers to watch a project the person doesn't, and to unwatch one they do when they ask to stop", () => {
    const [watch] = watchCommands([target], a);
    expect(watch).toMatchObject({ label: "Watch Support", group: "Projects", hint: "SUP · not watched" });
    watch.run();
    expect(a.watch).toHaveBeenCalledWith(target, true);

    const un = rankCommands(unwatchCommands(containers, "unwatch web", a), "unwatch web");
    expect(un.map((c) => c.label)).toEqual(["Unwatch Webshop"]);
    un[0].run();
    expect(a.watch).toHaveBeenLastCalledWith(containers.find((c) => c.key === "WEB"), false);
  });

  it("keeps Unwatch out of ordinary searches", () => {
    expect(unwatchCommands(containers, "web", a)).toEqual([]);
    expect(unwatchCommands(containers, "", a)).toEqual([]);
  });

  it("caps the watch suggestions", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ref: containerRef(`P${i}`), key: `P${i}`, name: `Project ${i}` }));
    expect(watchCommands(many, a)).toHaveLength(5);
  });

  it("opens any ticket key that isn't among the synced items", () => {
    const [open] = keyCommand("sup-99", items, a.openTicket);
    expect(open).toMatchObject({ label: "Open SUP-99", group: "Tickets" });
    open.run();
    expect(a.openTicket).toHaveBeenCalledWith("SUP-99");
  });

  it("leaves a synced key to the ticket results, and words alone", () => {
    const key = items[0].item.key;
    expect(keyCommand(key.toLowerCase(), items, a.openTicket)).toEqual([]);
    expect(keyCommand("swatch", items, a.openTicket)).toEqual([]);
  });
});

describe("GitHub commands", () => {
  const noop = new Proxy({}, { get: () => () => {} }) as CommandActions;

  it("offers to connect, and to manage repositories only once connected", () => {
    const labels = (github: boolean) => buildCommands([], [], noop, { project: null, view: null, unreadActivity: 0, github }).map((c) => c.label);
    expect(labels(false)).toContain("Connect GitHub");
    expect(labels(false)).not.toContain("Manage repositories");
    expect(labels(false).some((l) => l.startsWith("Filter: PR"))).toBe(false);
    expect(labels(true)).toContain("Manage repositories");
    expect(labels(true)).toEqual(expect.arrayContaining(["Filter: Has PR", "Filter: No PR", "Filter: PR open", "Filter: PR merged", "Filter: Checks failing"]));
  });

  it("opens a pull request named by reference or address, and nothing else", () => {
    const opened: unknown[] = [];
    const [cmd] = pullCommand("acme/webshop#208", (r) => opened.push(r));
    expect(cmd.label).toBe("Open PR acme/webshop#208");
    cmd.run();
    expect(opened).toEqual([{ repo: "acme/webshop", number: 208 }]);
    expect(pullCommand("https://github.com/acme/webshop/pull/9", () => {})[0].label).toBe("Open PR acme/webshop#9");
    expect(pullCommand("CA-208", () => {})).toEqual([]);
    expect(pullCommand("https://evil.com/acme/webshop/pull/9", () => {})).toEqual([]);
  });

  it("labels an unwatched repository as one", () => {
    const [c] = watchCommands([{ ref: { connectionId: "github:ada", externalId: "acme/infra" }, key: "acme/infra", name: "infra" }], { watch: () => {} });
    expect(c).toMatchObject({ group: "GitHub", label: "Watch repository acme/infra" });
  });
});

describe("agent commands", () => {
  const noop = new Proxy({}, { get: () => () => {} }) as CommandActions;
  const ctx = { project: null, view: null, unreadActivity: 0 };
  const labels = () => buildCommands([], [], noop, ctx).map((c) => c.label);

  it("offers the agent entries, and no way to start one: that is Ask Pip", () => {
    expect(labels()).toEqual(expect.arrayContaining(["Show what needs me", "Stop all agents…", "Agent safety and settings"]));
    expect(labels()).not.toContain("Start an agent…");
    expect(labels()).not.toContain("Start a workstream…");
  });

  it("runs each entry", () => {
    const a = actions();
    const found = buildCommands([], [], a, { ...ctx, needsYou: 2 });
    const named = (label: string) => found.find((c) => c.label === label)!;
    named("Show what needs me").run();
    named("Agent safety and settings").run();
    expect(a.showNeedsYou).toHaveBeenCalled();
    expect(a.openAgentSafety).toHaveBeenCalled();
    expect(named("Show what needs me").hint).toBe("2 waiting");
  });

  it("lists Ask Pip about the peeked ticket only with a ticket", () => {
    const ticket = { key: "CA-401", workstream: false };
    const find = (c: Parameters<typeof buildCommands>[3]) => buildCommands([], [], noop, c).filter((x) => x.id === "workstream:start");
    expect(find(ctx)).toEqual([]);
    expect(find({ ...ctx, ticket: null })).toEqual([]);
    expect(find({ ...ctx, ticket }).map((c) => c.label)).toEqual(["Ask Pip about CA-401"]);
    expect(find({ ...ctx, ticket: { ...ticket, workstream: true } }).map((c) => c.label)).toEqual(["Open the workstream on CA-401"]);
    const a = actions();
    const [entry] = rankCommands(buildCommands([], [], a, { ...ctx, ticket }), "ask pip about");
    expect(entry.label).toBe("Ask Pip about CA-401");
    entry.run();
    expect(a.startWorkstream).toHaveBeenCalled();
  });

  it("offers to close the peeked ticket's workstream only when it has one, and asks first", () => {
    const ticket = { key: "CA-401", workstream: true };
    const find = (c: Parameters<typeof buildCommands>[3]) => buildCommands([], [], noop, c).filter((x) => x.id === "workstream:close");
    expect(find({ ...ctx, ticket: { ...ticket, workstream: false } })).toEqual([]);
    expect(find({ ...ctx, ticket }).map((c) => [c.label, c.hint])).toEqual([["Close the workstream on CA-401…", "asks first"]]);
    const a = actions();
    const [entry] = rankCommands(buildCommands([], [], a, { ...ctx, ticket }), "close the workstream");
    expect(entry.id).toBe("workstream:close");
    entry.run();
    expect(a.closeWorkstream).toHaveBeenCalled();
  });

  it("finds the ticket's Ask Pip entry by the words for starting work", () => {
    const found = rankCommands(buildCommands([], [], noop, { ...ctx, ticket: { key: "CA-401", workstream: false } }), "investigate").map((c) => c.label);
    expect(found).toContain("Ask Pip about CA-401");
  });
});

describe("Agents in the palette", () => {
  const ctx = { project: null, view: null, unreadActivity: 0 };
  const view = (id: string, key: string | null, closed = false) =>
    ({ workstream: { id, itemKey: key, title: key ? `${key} Refund rounding` : "Look into the logs", closedAt: closed ? "2026-10-01T00:00:00Z" : null }, stage: "intake", runs: [], labels: [] }) as unknown as Parameters<typeof workstreamCommands>[0][number];

  it("finds Open Agents as the operations view (what is running, capacity, Stop all), not as a timeline", () => {
    const on = buildCommands(containers, BUILT_IN_VIEWS, actions(), ctx);
    for (const q of ["capacity", "running", "operations"]) expect(rankCommands(on, q)[0]?.id).toBe("app:agents");
    expect(on.find((c) => c.id === "app:agents")!.keywords).not.toContain("timeline");
  });

  it("offers 'Open Agents' first for 'agents', ahead of Stop all, and not while on Agents", () => {
    const a = actions();
    const on = buildCommands(containers, BUILT_IN_VIEWS, a, ctx);
    expect(rankCommands(on, "agents")[0].id).toBe("app:agents");
    expect(on.some((c) => c.id === "app:agents")).toBe(true);
    rankCommands(on, "agents")[0].run();
    expect(a.openAgents).toHaveBeenCalled();
    expect(buildCommands(containers, BUILT_IN_VIEWS, a, { ...ctx, onAgents: true }).some((c) => c.id === "app:agents")).toBe(false);
  });

  it("opens an open workstream by its ticket's key, never a closed one", () => {
    const a = actions();
    const list = [view("w1", "CA-401"), view("w2", "CA-402"), view("w3", "CA-4011", true), view("w4", null)];
    const found = workstreamCommands(list, "ca-401", a);
    expect(found.map((c) => c.label)).toEqual(["Open the workstream on CA-401"]);
    found[0].run();
    expect(a.openWorkstream).toHaveBeenCalledWith("w1");
    expect(workstreamCommands(list, "workstream ca-402", a).map((c) => c.id)).toEqual(["workstream:open:w2"]);
    expect(workstreamCommands(list, "logs", a).map((c) => c.label)).toEqual(["Open the workstream on Look into the logs"]);
    expect(workstreamCommands(list, "  ", a)).toEqual([]);
  });

  it("asks Pip to plan the ticket a query starting with 'plan' names", () => {
    const a = actions();
    const ca401 = items.find((i) => i.item.key === "CA-401")!;
    const found = askToPlanCommands(items, "plan ca-401", a);
    expect(found[0]).toMatchObject({ id: expect.stringMatching(/^askplan:/), group: "Ask Pip", label: "Ask Pip to plan CA-401" });
    found[0].run();
    expect(a.askPipToPlan).toHaveBeenCalledWith(ca401);
    expect(askToPlanCommands(items, "ca-401 plan", a)).toEqual([]);
    expect(askToPlanCommands(items, "planet", a)).toEqual([]);
  });

  it("has no Pip home entry, and ⌘J is Toggle Pip everywhere", () => {
    const on = buildCommands(containers, BUILT_IN_VIEWS, actions(), ctx);
    expect(on.some((c) => c.id === "app:pip-home")).toBe(false);
    expect(rankCommands(on, "pip home")[0]?.label ?? "").not.toMatch(/Pip home/);
    expect(on.find((c) => c.id === "app:pip")?.label).toBe("Toggle Pip");
  });

  it("opens a workstream's entry on Agents", () => {
    const [found] = workstreamCommands([view("w1", "CA-401")], "ca-401", actions());
    expect(found.hint).toBe("Agents");
  });

  it("asks Pip about the peeked ticket, or opens its workstream", () => {
    const on = (workstream: boolean) => buildCommands(containers, BUILT_IN_VIEWS, actions(), { ...ctx, ticket: { key: "CA-401", workstream } });
    expect(on(false).find((c) => c.id === "workstream:start")?.label).toBe("Ask Pip about CA-401");
    expect(on(true).find((c) => c.id === "workstream:start")?.label).toBe("Open the workstream on CA-401");
  });
});

describe("the habits in the palette", () => {
  const ctx = { project: null, view: null, unreadActivity: 0 };

  it("offers 'What Jira saw from me' always, and finds it by what it shows", () => {
    const a = actions();
    const all = buildCommands(containers, BUILT_IN_VIEWS, a, ctx);
    const sent = all.find((c) => c.id === "app:jira-sent")!;
    expect(sent).toMatchObject({ group: "Go to", label: "What Jira saw from me" });
    expect(rankCommands(all, "jira saw")[0].id).toBe("app:jira-sent");
    expect(rankCommands(all, "posted")[0].id).toBe("app:jira-sent");
    sent.run();
    expect(a.openJiraSent).toHaveBeenCalled();
  });
});
