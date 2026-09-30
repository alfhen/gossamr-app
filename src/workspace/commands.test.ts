import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { containerRef } from "../backend/mockConnector";
import { buildCommands, newTicketIntent, projectChoices, rankCommands, ticketCommands, withAskPip, type CommandActions } from "./commands";
import { BUILT_IN_VIEWS } from "./filters";

const containers = await new MockBackend().cacheContainers();
const items = await new MockBackend().cacheSearch({ type: "and", filters: [] });

const actions = () => {
  const a = Object.fromEntries(
    ["goToProject", "openSavedView", "setView", "addFilter", "clearFilters", "setTheme", "openSettings", "openActivity", "openDrafts", "newTab", "newTicket", "togglePip", "jumpToItem", "askPip"].map((k) => [k, vi.fn()]),
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
