import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { containerRef } from "../backend/mockConnector";
import { agentTicketChoices, buildCommands, agentCommands, keyCommand, newTicketIntent, projectChoices, pullCommand, rankCommands, ticketCommands, unwatchCommands, watchCommands, withAskPip, type CommandActions } from "./commands";
import { BUILT_IN_VIEWS } from "./filters";

const containers = await new MockBackend().cacheContainers();
const items = await new MockBackend().cacheSearch({ type: "and", filters: [] });

const actions = () => {
  const a = Object.fromEntries(
    ["goToProject", "openSavedView", "setView", "addFilter", "clearFilters", "setTheme", "openSettings", "manageProjects", "watch", "openTicket", "openActivity", "openDrafts", "newTab", "newTicket", "togglePip", "startAgent", "startAgentOn", "showAgentsNeedingMe", "openAgentSafety", "jumpToItem", "askPip"].map((k) => [k, vi.fn()]),
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
    expect(find("needs me")).toContain("Filter: Needs me");
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
    const ctx = { project: containerRef("CA"), view: "board" as const, unreadActivity: 22, pendingDrafts: 3 };
    const live = buildCommands(containers, BUILT_IN_VIEWS, a, ctx);
    const hint = (id: string) => live.find((c) => c.id === id)?.hint;
    expect(hint("app:activity")).toBe("22 new");
    expect(hint("app:drafts")).toBe("3 pending");
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
    const labels = (github: boolean) => buildCommands([], [], noop, { project: null, view: null, unreadActivity: 0, pendingDrafts: 0, github }).map((c) => c.label);
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
  const ctx = { project: null, view: null, unreadActivity: 0, pendingDrafts: 0 };
  const labels = (agents: boolean) => buildCommands([], [], noop, { ...ctx, agents }).map((c) => c.label);

  it("offers the agent entries only when Agents is on", () => {
    expect(labels(false).some((l) => /agent/i.test(l))).toBe(false);
    expect(labels(true)).toEqual(expect.arrayContaining(["Start an agent…", "Show agents that need me", "Stop all agents…", "Agent safety and settings"]));
  });

  it("runs each entry", () => {
    const a = actions();
    const found = buildCommands([], [], a, { ...ctx, agents: true, agentsNeedingMe: 2 });
    const named = (label: string) => found.find((c) => c.label === label)!;
    named("Start an agent…").run();
    named("Show agents that need me").run();
    named("Agent safety and settings").run();
    expect(a.startAgent).toHaveBeenCalled();
    expect(a.showAgentsNeedingMe).toHaveBeenCalled();
    expect(a.openAgentSafety).toHaveBeenCalled();
    expect(named("Show agents that need me").hint).toBe("2 waiting");
    expect(named("Start an agent…").stay).toBeFalsy();
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
    for (const [verb, kind, label] of [["triage", "triage", "Triage"], ["build", "build", "Build"], ["review", "review", "Review the PR on"], ["verify", "verify", "Verify"]] as const) {
      const found = agentCommands(items, `${verb} welcome`, run);
      expect(found[0].label.startsWith(`${label} `)).toBe(true);
      found[0].run();
      expect(run).toHaveBeenLastCalledWith(expect.anything(), kind);
    }
    expect(agentCommands(items, "welcome review", run)).toEqual([]);
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
  });
});
