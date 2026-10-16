import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { containerRef } from "../backend/mockConnector";
import { SUGGESTED_TICKETS, START_WORKSTREAM, noStartableTicket, namesCommand, agentTicketChoices, askToPlanCommands, buildCommands, agentCommands, startWorkstreamCommands, timelineCommands, workstreamCommands, keyCommand, newTicketIntent, projectChoices, pullCommand, rankCommands, searchOrder, ticketCommands, unwatchCommands, watchCommands, withAskPip, type CommandActions } from "./commands";
import { BUILT_IN_VIEWS } from "./filters";
import type { WorkItem } from "../types";

const containers = await new MockBackend().cacheContainers();
const items = await new MockBackend().cacheSearch({ type: "and", filters: [] });

const actions = () => {
  const a = Object.fromEntries(
    ["goToProject", "openSavedView", "setView", "addFilter", "clearFilters", "setTheme", "openSettings", "manageProjects", "watch", "openTicket", "openActivity", "openDrafts", "newTab", "newTicket", "chooseWorkstream", "togglePip", "startAgent", "startAgentOn", "showNeedsYou", "openAgentSafety", "startWorkstream", "closeWorkstream", "jumpToItem", "askPip", "openPipHome", "openAgents", "openWorkstream", "askPipToPlan", "startWorkstreamOn", "showTimeline", "startMyDay", "openJiraSent", "giveBackClarity"].map((k) => [k, vi.fn()]),
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
  const ctx = { project: null, view: "list" as const, unreadActivity: 0, github: false, agents: true, needsYou: 0, ticket: null, onPipHome: false, onAgents: false };
  const commands = [...buildCommands(containers, BUILT_IN_VIEWS, a, ctx), ...timelineCommands({ filter: "all", scope: "workstream", shown: false }, a)];
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
    expect(order("runs")[0]).toBe("Timeline: Runs");
    expect(order("runs").indexOf("Runs of the nightly sync fail")).toBeGreaterThan(order("runs").indexOf("Timeline: Runs"));
    const timeline = order("timeline");
    expect(timeline[0]).toMatch(/^Timeline/);
    expect(timeline.indexOf("Timeline of agents is blank")).toBeGreaterThan(timeline.lastIndexOf("Timeline: Every workstream"));
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
  const labels = (agents: boolean) => buildCommands([], [], noop, { ...ctx, agents }).map((c) => c.label);

  it("offers the agent entries only when Agents is on", () => {
    expect(labels(false).some((l) => /agent/i.test(l))).toBe(false);
    expect(labels(true)).toEqual(expect.arrayContaining(["Start an agent…", "Show what needs me", "Stop all agents…", "Agent safety and settings"]));
  });

  it("runs each entry", () => {
    const a = actions();
    const found = buildCommands([], [], a, { ...ctx, agents: true, needsYou: 2 });
    const named = (label: string) => found.find((c) => c.label === label)!;
    named("Start an agent…").run();
    named("Show what needs me").run();
    named("Agent safety and settings").run();
    expect(a.startAgent).toHaveBeenCalled();
    expect(a.showNeedsYou).toHaveBeenCalled();
    expect(a.openAgentSafety).toHaveBeenCalled();
    expect(named("Show what needs me").hint).toBe("2 waiting");
    expect(named("Start an agent…").stay).toBeFalsy();
  });

  it("lists Start a workstream on the peeked ticket only with a ticket and Agents on", () => {
    const ticket = { key: "CA-401", workstream: false };
    const find = (c: Parameters<typeof buildCommands>[3]) => buildCommands([], [], noop, c).filter((x) => x.id === "workstream:start");
    expect(find({ ...ctx, agents: true })).toEqual([]);
    expect(find({ ...ctx, agents: true, ticket: null })).toEqual([]);
    expect(find({ ...ctx, agents: false, ticket })).toEqual([]);
    expect(find({ ...ctx, agents: true, ticket }).map((c) => c.label)).toEqual(["Start a workstream on CA-401"]);
    expect(find({ ...ctx, agents: true, ticket: { ...ticket, workstream: true } }).map((c) => c.label)).toEqual(["Open the workstream on CA-401"]);
    const a = actions();
    const [entry] = rankCommands(buildCommands([], [], a, { ...ctx, agents: true, ticket }), "start a workstream");
    expect(entry.label).toBe("Start a workstream on CA-401");
    entry.run();
    expect(a.startWorkstream).toHaveBeenCalled();
  });

  it("offers to close the peeked ticket's workstream only when it has one, and asks first", () => {
    const ticket = { key: "CA-401", workstream: true };
    const find = (c: Parameters<typeof buildCommands>[3]) => buildCommands([], [], noop, c).filter((x) => x.id === "workstream:close");
    expect(find({ ...ctx, agents: true, ticket: { ...ticket, workstream: false } })).toEqual([]);
    expect(find({ ...ctx, agents: false, ticket })).toEqual([]);
    expect(find({ ...ctx, agents: true, ticket }).map((c) => [c.label, c.hint])).toEqual([["Close the workstream on CA-401…", "asks first"]]);
    const a = actions();
    const [entry] = rankCommands(buildCommands([], [], a, { ...ctx, agents: true, ticket }), "close the workstream");
    expect(entry.id).toBe("workstream:close");
    entry.run();
    expect(a.closeWorkstream).toHaveBeenCalled();
  });

  it("finds start an agent by its plain words", () => {
    const found = rankCommands(buildCommands([], [], noop, { ...ctx, agents: true }), "run claude").map((c) => c.label);
    expect(found).toContain("Start an agent…");
  });

  it("offers Investigate for a ticket only when the query asks for it", () => {
    const run = vi.fn();
    expect(agentCommands(items, "welcome", run)).toEqual([]);
    const some = agentCommands(items, "investigate welcome", run);
    expect(some.length).toBeGreaterThan(0);
    expect(some[0].label).toMatch(/^Investigate [A-Z]+-\d+ {2}/);
    some[0].run();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].title.toLowerCase()).toContain("welcome");
    expect(run.mock.calls[0][1]).toBe("investigate");
  });

  it("offers the other kinds when the query starts with their word, and not for the same word in a title", () => {
    const run = vi.fn();
    for (const [verb, kind, label] of [["triage", "triage", "Triage"], ["plan", "plan", "Plan"], ["build", "build", "Build"], ["review", "review", "Review the PR on"], ["verify", "verify", "Verify"]] as const) {
      const found = agentCommands(items, `${verb} welcome`, run);
      expect(found[0].label.startsWith(`${label} `)).toBe(true);
      found[0].run();
      expect(run).toHaveBeenLastCalledWith(expect.anything(), kind);
    }
    expect(agentCommands(items, "welcome review", run)).toEqual([]);
    expect(agentCommands(items, "welcome plan", run)).toEqual([]);
    expect(agentCommands(items, "make a plan for welcome", run)).toEqual([]);
  });

  it("lists the latest tickets for a bare Investigate, and finds a key", () => {
    expect(agentCommands(items, "investigate", () => {}, 3)).toHaveLength(3);
    const key = items[0].item.key;
    expect(agentCommands(items, `agent ${key}`, () => {})[0].label).toContain(key);
  });

  it("picks a ticket for a new agent: the matches, or the latest, and no ticket as a way out", () => {
    const pick = vi.fn();
    const latest = agentTicketChoices(items, "", pick);
    expect(latest.map((c) => c.id)).toContain("agent:none");
    expect(latest.length).toBe(9);
    latest.find((c) => c.id === "agent:none")!.run();
    expect(pick).toHaveBeenCalledWith(null);
    const key = items[3].item.key;
    const found = agentTicketChoices(items, key, pick);
    expect(found[0].hint).toBe(key);
    found[0].run();
    expect(pick).toHaveBeenLastCalledWith(items[3]);
    expect(found.map((c) => c.id)).not.toContain("agent:none");
    expect(agentTicketChoices(items, "no ticket", pick).map((c) => c.id)).toContain("agent:none");
    expect(latest.find((c) => c.id === "agent:none")?.label).toBe("Investigate something (no ticket)");
    expect(agentTicketChoices(items, "investigate", pick).map((c) => c.id)).toContain("agent:none");
  });
});

describe("Pip home in the palette", () => {
  const ctx = { project: null, view: null, unreadActivity: 0 };
  const view = (id: string, key: string | null, closed = false) =>
    ({ workstream: { id, itemKey: key, title: key ? `${key} Refund rounding` : "Look into the logs", closedAt: closed ? "2026-10-01T00:00:00Z" : null }, stage: "intake", runs: [], labels: [] }) as unknown as Parameters<typeof workstreamCommands>[0][number];

  it("offers 'Open Pip home' only while Agents are on", () => {
    const a = actions();
    expect(buildCommands(containers, BUILT_IN_VIEWS, a, ctx).some((c) => c.id === "app:pip-home")).toBe(false);
    const on = buildCommands(containers, BUILT_IN_VIEWS, a, { ...ctx, agents: true });
    const home = on.find((c) => c.id === "app:pip-home")!;
    expect(home).toMatchObject({ group: "Go to", label: "Open Pip home", hint: "⌘0" });
    expect(rankCommands(on, "pip home")[0].id).toBe("app:pip-home");
    home.run();
    expect(a.openPipHome).toHaveBeenCalled();
  });

  it("finds Open Agents as the operations view (what is running, capacity, Stop all), not as the runs timeline", () => {
    const on = buildCommands(containers, BUILT_IN_VIEWS, actions(), { ...ctx, agents: true });
    for (const q of ["capacity", "running", "operations"]) expect(rankCommands(on, q)[0]?.id).toBe("app:agents");
    expect(on.find((c) => c.id === "app:agents")!.keywords).not.toContain("timeline");
  });

  it("offers 'Open Agents' first for 'agents', ahead of Stop all, and not while on Agents", () => {
    const a = actions();
    const on = buildCommands(containers, BUILT_IN_VIEWS, a, { ...ctx, agents: true });
    expect(rankCommands(on, "agents")[0].id).toBe("app:agents");
    expect(on.some((c) => c.id === "app:agents")).toBe(true);
    rankCommands(on, "agents")[0].run();
    expect(a.openAgents).toHaveBeenCalled();
    expect(buildCommands(containers, BUILT_IN_VIEWS, a, { ...ctx, agents: true, onAgents: true }).some((c) => c.id === "app:agents")).toBe(false);
    expect(buildCommands(containers, BUILT_IN_VIEWS, a, ctx).some((c) => c.id === "app:agents")).toBe(false);
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

  it("on Pip home, leaves out 'Open Pip home' and calls ⌘J what it does there", () => {
    const on = buildCommands(containers, BUILT_IN_VIEWS, actions(), { ...ctx, agents: true, onPipHome: true });
    expect(on.some((c) => c.id === "app:pip-home")).toBe(false);
    expect(on.find((c) => c.id === "app:pip")?.label).toBe("Go to Pip's composer");
    expect(buildCommands(containers, BUILT_IN_VIEWS, actions(), { ...ctx, agents: true }).find((c) => c.id === "app:pip")?.label).toBe("Toggle Pip");
  });

  it("says why the workstream step has nothing for a key: Done, taken, or not loaded", () => {
    const ca401 = items.find((i) => i.item.key === "CA-401")!;
    const done = { ...ca401, item: { ...ca401.item, key: "CA-9" }, status: { ...ca401.status, category: "done" as const } };
    const open = [{ ...view("w1", "CA-401"), workstream: { ...view("w1", "CA-401").workstream, connectionId: ca401.item.connectionId } }] as Parameters<typeof noStartableTicket>[2];
    expect(noStartableTicket([...items, done], "ca-9", [])).toBe("CA-9 is Done in Jira.");
    expect(noStartableTicket(items, "ca-401", open)).toBe("CA-401 has a workstream already.");
    expect(noStartableTicket(items, "ca-377", [])).toBe("No open ticket CA-377 here. It may be Done, already have a workstream, or not be loaded.");
    expect(noStartableTicket(items, "zzz nothing", [])).toBe("No ticket without a workstream matches “zzz nothing”.");
    expect(noStartableTicket(items, "  ", [])).toBe("Every open ticket has a workstream already.");
  });

  it("starts a workstream on a ticket the query names, with no ticket peeked, and never one whose workstream is open", () => {
    const a = actions();
    const ca401 = items.find((i) => i.item.key === "CA-401")!;
    const found = startWorkstreamCommands(items, "start a workstream on ca-401", [], a);
    expect(found[0]).toMatchObject({ id: "workstream:start:mock:CA-401", group: "Workstreams", label: "Start a workstream on CA-401" });
    found[0].run();
    expect(a.startWorkstreamOn).toHaveBeenCalledWith(ca401);
    expect(startWorkstreamCommands(items, "workstream ca-401", [], a)[0]?.label).toBe("Start a workstream on CA-401");
    // Open already: the palette offers to open it instead (workstreamCommands).
    const open = [{ ...view("w1", "CA-401"), workstream: { ...view("w1", "CA-401").workstream, connectionId: ca401.item.connectionId } }] as Parameters<typeof workstreamCommands>[0];
    expect(startWorkstreamCommands(items, "workstream ca-401", open, a).some((c) => c.label === "Start a workstream on CA-401")).toBe(false);
    expect(startWorkstreamCommands(items, "ca-401", [], a)).toEqual([]);
    expect(startWorkstreamCommands(items, "start a workstream on ca-401", [], a)).toHaveLength(1);
  });

  it("never offers to start a workstream on a Done ticket, typed by key or by its words", () => {
    const a = actions();
    const ca401 = items.find((i) => i.item.key === "CA-401")!;
    const done = { ...ca401, item: { ...ca401.item, key: "CA-9" }, title: "Archive the old welcome flow", status: { ...ca401.status, category: "done" as const } };
    expect(startWorkstreamCommands([...items, done], "start a workstream on ca-9", [], a)).toEqual([]);
    expect(startWorkstreamCommands([...items, done], "workstream archive the old welcome", [], a).some((c) => c.label === "Start a workstream on CA-9")).toBe(false);
    // So the step has nothing to offer, and says why.
    expect(noStartableTicket([...items, done], "ca-9", [])).toBe("CA-9 is Done in Jira.");
  });

  it("asked for a workstream with no ticket yet, offers the person's open tickets first, then the newest open ones, never one with an open workstream", () => {
    const a = actions();
    const me = { connectionId: "mock", accountId: "me" };
    const at = (key: string, updated: string, over: Partial<WorkItem> = {}): WorkItem => ({ ...items[0], item: { ...items[0].item, key, externalId: key }, title: key, updated, assignee: null, ...over });
    const done = { ...items[0].status, category: "done" as const };
    const pool = [
      at("T-1", "2026-09-01T00:00:00Z"),
      at("T-2", "2026-09-05T00:00:00Z"),
      at("T-3", "2026-08-01T00:00:00Z", { assignee: me }),
      at("T-4", "2026-09-09T00:00:00Z", { status: done }),
      at("T-5", "2026-09-07T00:00:00Z"),
      at("T-6", "2026-09-06T00:00:00Z"),
      at("T-7", "2026-09-08T00:00:00Z"),
      at("T-8", "2026-09-04T00:00:00Z"),
    ];
    const open = [{ ...view("w1", "T-7"), workstream: { ...view("w1", "T-7").workstream, connectionId: pool[6].item.connectionId } }] as Parameters<typeof workstreamCommands>[0];
    // "start a workstream" alone asks the same question as "start a workstream on ".
    for (const query of ["start a workstream on ", "start a workstream on", "workstream on", "start a workstream", "workstream"]) {
      const found = startWorkstreamCommands(pool, query, open, a, 3, [me]);
      // Mine first; then open ones, newest first; the done one and the one with a workstream left out; five at most.
      expect(found.map((c) => c.label)).toEqual(["Start a workstream on T-3", "Start a workstream on T-5", "Start a workstream on T-6", "Start a workstream on T-2", "Start a workstream on T-8"]);
      expect(found).toHaveLength(SUGGESTED_TICKETS);
    }
    startWorkstreamCommands(pool, START_WORKSTREAM, open, a, 3, [me])[0].run();
    expect(a.startWorkstreamOn).toHaveBeenCalledWith(pool[2]);
    // Words after it narrow as before; no workstream words offer nothing.
    expect(startWorkstreamCommands(pool, `${START_WORKSTREAM}T-2`, open, a, 3, [me]).map((c) => c.label)).toEqual(["Start a workstream on T-2"]);
    expect(startWorkstreamCommands(pool, "on", open, a, 3, [me])).toEqual([]);
  });

  it("keeps the peek's workstream entry as it was", () => {
    const on = buildCommands(containers, BUILT_IN_VIEWS, actions(), { ...ctx, agents: true, ticket: { key: "CA-401", workstream: false } });
    expect(on.find((c) => c.id === "workstream:start")?.label).toBe("Start a workstream on CA-401");
  });
});

describe("timeline commands", () => {
  it("offers each filter and each scope, keeping the other as it is", () => {
    const a = actions();
    const found = timelineCommands({ filter: "drafts", scope: "workstream", shown: true }, a);
    expect(found.map((c) => c.label)).toEqual(["Timeline: All", "Timeline: Runs", "Timeline: Drafts", "Timeline: Decisions", "Timeline: This workstream", "Timeline: Every workstream"]);
    expect(found.every((c) => c.group === "Workstreams" && !!c.icon)).toBe(true);
    found.find((c) => c.label === "Timeline: Decisions")!.run();
    expect(a.showTimeline).toHaveBeenLastCalledWith("decisions", "workstream");
    found.find((c) => c.label === "Timeline: Every workstream")!.run();
    expect(a.showTimeline).toHaveBeenLastCalledWith("drafts", "every");
  });

  it("marks what the timeline on screen shows as current, and sends no combination to another screen", () => {
    const hints = (state: Parameters<typeof timelineCommands>[0]) => Object.fromEntries(timelineCommands(state, actions()).map((c) => [c.id, c.hint]));
    expect(hints({ filter: "drafts", scope: "workstream", shown: true })).toMatchObject({ "timeline:filter:drafts": "current", "timeline:scope:workstream": "current", "timeline:filter:runs": undefined, "timeline:scope:every": undefined });
    // Runs in every workstream is a timeline like the rest: no hint sends it to Agents.
    expect(hints({ filter: "all", scope: "every", shown: true })["timeline:filter:runs"]).toBeUndefined();
    expect(hints({ filter: "runs", scope: "workstream", shown: true })["timeline:scope:every"]).toBeUndefined();
    // With Runs and Every workstream on screen, both are current.
    expect(hints({ filter: "runs", scope: "every", shown: true })).toMatchObject({ "timeline:filter:runs": "current", "timeline:scope:every": "current" });
    // Off screen, nothing is current.
    expect(Object.values(hints({ filter: "all", scope: "workstream", shown: false })).filter((h) => h === "current")).toEqual([]);
  });

  it("finds them by the filter's and the scope's plain words", () => {
    const found = (q: string) => rankCommands(timelineCommands({ filter: "all", scope: "workstream", shown: false }, actions()), q).map((c) => c.id);
    expect(found("decisions")[0]).toBe("timeline:filter:decisions");
    expect(found("timeline runs")[0]).toBe("timeline:filter:runs");
    expect(found("every workstream")[0]).toBe("timeline:scope:every");
    expect(found("this workstream")[0]).toBe("timeline:scope:workstream");
  });
});

describe("the habits in the palette", () => {
  const ctx = { project: null, view: null, unreadActivity: 0 };

  it("offers 'Start my day' while Agents are on, and finds it by what it is for", () => {
    const a = actions();
    expect(buildCommands(containers, BUILT_IN_VIEWS, a, ctx).some((c) => c.id === "app:start-my-day")).toBe(false);
    const on = buildCommands(containers, BUILT_IN_VIEWS, a, { ...ctx, agents: true });
    const start = on.find((c) => c.id === "app:start-my-day")!;
    expect(start).toMatchObject({ group: "Go to", label: "Start my day" });
    expect(rankCommands(on, "start my day")[0].id).toBe("app:start-my-day");
    expect(rankCommands(on, "morning")[0].id).toBe("app:start-my-day");
    start.run();
    expect(a.startMyDay).toHaveBeenCalled();
  });

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

  it("offers giving back what Looks fine learned only once it learned something, with how many projects", () => {
    const a = actions();
    expect(buildCommands(containers, BUILT_IN_VIEWS, a, ctx).some((c) => c.id === "clarity:reset")).toBe(false);
    expect(buildCommands(containers, BUILT_IN_VIEWS, a, { ...ctx, clarityLearned: 0 }).some((c) => c.id === "clarity:reset")).toBe(false);
    const one = buildCommands(containers, BUILT_IN_VIEWS, a, { ...ctx, clarityLearned: 1 }).find((c) => c.id === "clarity:reset")!;
    expect(one).toMatchObject({ group: "App", label: "Give back what Looks fine learned", hint: "1 project" });
    const two = buildCommands(containers, BUILT_IN_VIEWS, a, { ...ctx, clarityLearned: 2 }).find((c) => c.id === "clarity:reset")!;
    expect(two.hint).toBe("2 projects");
    two.run();
    expect(a.giveBackClarity).toHaveBeenCalled();
  });
});

describe("Start a workstream… in the palette (G14)", () => {
  it("is found by 'start', asks for the ticket in the palette itself, and Start an agent says how it differs", () => {
    const a = actions();
    const found = buildCommands([], [], a, { project: null, view: null, unreadActivity: 0, agents: true });
    const entry = found.find((c) => c.label === "Start a workstream…")!;
    expect(entry.group).toBe("Workstreams");
    expect(entry.hint).toBe("starts no agent and posts nothing");
    expect(entry.stay).toBe(true);
    expect(rankCommands(found, "start").map((c) => c.label)).toEqual(expect.arrayContaining(["Start a workstream…", "Start an agent…"]));
    entry.run();
    expect(a.chooseWorkstream).toHaveBeenCalled();
    expect(found.find((c) => c.label === "Start an agent…")!.hint).toContain("runs Claude");
    expect(buildCommands([], [], a, { project: null, view: null, unreadActivity: 0, agents: false }).some((c) => c.label === "Start a workstream…")).toBe(false);
  });
});
