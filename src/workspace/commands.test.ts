import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { containerRef } from "../backend/mockConnector";
import { buildCommands, rankCommands, ticketCommands, type CommandActions } from "./commands";
import { BUILT_IN_VIEWS } from "./filters";

const containers = await new MockBackend().cacheContainers();
const items = await new MockBackend().cacheSearch({ type: "and", filters: [] });

const actions = () => {
  const a = Object.fromEntries(
    ["goToProject", "openSavedView", "setView", "addFilter", "clearFilters", "setTheme", "openSettings", "openActivity", "newTab", "togglePip", "jumpToItem"].map((k) => [k, vi.fn()]),
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
