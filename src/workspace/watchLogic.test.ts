import { describe, expect, it } from "vitest";
import { containerRef } from "../backend/mockConnector";
import type { CatalogEntry, Footprint, Stray, WatchRow, WatchState, WorkContainer } from "../types";
import { activityHint, choiceChanges, count, graceDaysLeft, graceLine, matchesQuery, mergeEntries, newStrays, nounFor, railSplit, settingsRows, strayText, suggestionChips, suggestedIds, ticketKeyOf, toggled } from "./watchLogic";

const fp = (key: string, over: Partial<Footprint> = {}): Footprint => ({ container: containerRef(key), key, name: key, assigned: 0, reported: 0, watching: 0, commented: null, mentioned: null, lastTouch: null, ...over });
const container = (key: string): WorkContainer => ({ ref: containerRef(key), key, name: `${key} project`, workflow: { statuses: [], transitions: { kind: "any" } } });
const row = (key: string, over: Partial<WatchRow> = {}): WatchRow => ({ container: containerRef(key), depth: "involved", pinned: false, source: "manual", addedAt: "2026-09-01T00:00:00Z", unwatchedAt: null, inaccessible: false, key, name: `${key} project`, cachedItems: 0, ...over });
const state = (mode: WatchState["mode"], watches: WatchRow[]): WatchState => ({ connectionId: "mock", mode, needsChoice: false, catalogSize: 13, watches });

describe("the choice", () => {
  it("toggles one id without touching the original", () => {
    const a = new Set(["A"]);
    expect([...toggled(a, "B")]).toEqual(["A", "B"]);
    expect([...toggled(a, "A")]).toEqual([]);
    expect([...a]).toEqual(["A"]);
  });

  it("starts from the suggested set", () => {
    expect([...suggestedIds([fp("WEB"), fp("CA")])]).toEqual(["WEB", "CA"]);
  });

  it("saves suggested containers first, pinned up to the limit, marked by where they came from", () => {
    const changes = choiceChanges(["P07", "CA", "P08", "WEB"], [fp("WEB"), fp("CA"), fp("SUP")], 3);
    expect(changes.map((c) => c.containerId)).toEqual(["WEB", "CA", "P07", "P08"]);
    expect(changes.map((c) => c.pinned)).toEqual([true, true, true, false]);
    expect(changes.map((c) => c.source)).toEqual(["footprint", "footprint", "manual", "manual"]);
    expect(changes.every((c) => c.watched === true)).toBe(true);
  });

  it("describes the activity behind a suggestion and says nothing when there is none", () => {
    expect(activityHint(fp("WEB", { assigned: 3, reported: 1, commented: 4 }))).toBe("3 assigned · 1 reported · 4 commented");
    expect(activityHint(fp("WEB"))).toBeNull();
  });

  it("merges pages without repeating a container", () => {
    const e = (k: string) => ({ ref: containerRef(k) }) as CatalogEntry;
    expect(mergeEntries([e("A"), e("B")], [e("B"), e("C")]).map((x) => x.ref.externalId)).toEqual(["A", "B", "C"]);
  });

  it("names a connection's containers without hard-coding a tracker", () => {
    expect(nounFor("jira")).toMatchObject({ one: "project", many: "projects", domain: "work" });
    expect(nounFor("github")).toMatchObject({ one: "repository", many: "repositories", domain: "code" });
    expect(nounFor("something-else")).toMatchObject({ one: "container", many: "containers" });
    expect(count(1, nounFor("jira"))).toBe("1 project");
    expect(count(12, nounFor("jira"))).toBe("12 projects");
  });
});

describe("the grace period", () => {
  const at = new Date("2026-09-30T12:00:00Z");
  it("counts whole days left of fourteen", () => {
    expect(graceDaysLeft("2026-09-30T11:00:00Z", at)).toBe(14);
    expect(graceDaysLeft("2026-09-27T12:00:00Z", at)).toBe(11);
    expect(graceDaysLeft("2026-09-16T12:00:00Z", at)).toBe(0);
    expect(graceDaysLeft("2026-08-01T12:00:00Z", at)).toBe(0);
  });

  it("says when it will be removed", () => {
    expect(graceLine(11)).toBe("Unwatched, removed from sync in 11 days");
    expect(graceLine(1)).toBe("Unwatched, removed from sync in 1 day");
    expect(graceLine(0)).toBe("Unwatched, removed from sync today");
  });
});

describe("settings rows", () => {
  it("lists watched rows by key, then those in their grace period, newest first", () => {
    const rows = settingsRows(
      state("selected", [row("WEB"), row("OLD", { unwatchedAt: "2026-09-20T00:00:00Z" }), row("CA"), row("NEW", { unwatchedAt: "2026-09-28T00:00:00Z" })]),
      [],
    );
    expect(rows.map((r) => r.key)).toEqual(["CA", "WEB", "NEW", "OLD"]);
  });

  it("lists every watched container in everything mode, including those with no row of their own", () => {
    const rows = settingsRows(state("everything", [row("CA", { pinned: true })]), [container("CA"), container("WEB")], () => 3);
    expect(rows.map((r) => [r.key, r.pinned, r.cachedItems])).toEqual([
      ["CA", true, 0],
      ["WEB", false, 3],
    ]);
  });

  it("does not invent rows in selected mode", () => {
    expect(settingsRows(state("selected", []), [container("CA")])).toEqual([]);
  });

  it("matches on key or name", () => {
    expect(matchesQuery({ key: "WEB", name: "Webshop" }, "shop")).toBe(true);
    expect(matchesQuery({ key: "WEB", name: "Webshop" }, "  ")).toBe(true);
    expect(matchesQuery({ key: "WEB", name: "Webshop" }, "ca")).toBe(false);
  });

  it("suggests the footprint the person doesn't watch yet", () => {
    const chips = suggestionChips([fp("WEB"), fp("CA"), fp("SUP")], new Set(["CA"]), 5);
    expect(chips.map((f) => f.key)).toEqual(["WEB", "SUP"]);
    expect(suggestionChips([fp("A"), fp("B"), fp("C")], new Set(), 2)).toHaveLength(2);
  });
});

describe("rail ordering", () => {
  const all = ["WEB", "CA", "SUP", "DEVOPS"].map(container);
  const keys = (l: WorkContainer[]) => l.map((c) => c.key);

  it("puts pinned containers first as badges and the rest in the menu, each by key", () => {
    const split = railSplit(all, [state("selected", [row("WEB", { pinned: true }), row("CA", { pinned: true }), row("SUP")])], null);
    expect(keys(split.badges)).toEqual(["CA", "WEB"]);
    expect(keys(split.rest)).toEqual(["DEVOPS", "SUP"]);
  });

  it("ignores pins on containers in their grace period", () => {
    const split = railSplit(all, [state("selected", [row("WEB", { pinned: true, unwatchedAt: "2026-09-29T00:00:00Z" }), row("CA", { pinned: true })])], null);
    expect(keys(split.badges)).toEqual(["CA"]);
  });

  it("stands the first few in as badges when nothing is pinned, so the rail is never empty", () => {
    const split = railSplit(all, [state("everything", [])], null, 2);
    expect(keys(split.badges)).toEqual(["CA", "DEVOPS"]);
    expect(keys(split.rest)).toEqual(["SUP", "WEB"]);
  });

  it("always shows the container on screen", () => {
    const split = railSplit(all, [state("selected", [row("CA", { pinned: true })])], containerRef("SUP"));
    expect(keys(split.badges)).toEqual(["CA", "SUP"]);
    expect(keys(split.rest)).toEqual(["DEVOPS", "WEB"]);
  });
});

describe("items assigned elsewhere", () => {
  const stray = (key: string, keys: string[]): Stray => ({ container: containerRef(key), containerName: `${key} project`, keys });

  it("says what was assigned and where", () => {
    expect(strayText(stray("SUP", ["SUP-12"]))).toBe("You were assigned SUP-12 in SUP project, which you're not watching");
    expect(strayText(stray("SUP", ["SUP-12", "SUP-13", "SUP-14"]))).toBe("You were assigned SUP-12 and 2 more in SUP project, which you're not watching");
  });

  it("finds what is new or has grown", () => {
    const before = [stray("SUP", ["SUP-1"]), stray("CA", ["CA-1"])];
    const after = [stray("SUP", ["SUP-1"]), stray("CA", ["CA-1", "CA-2"]), stray("WEB", ["WEB-1"])];
    expect(newStrays(before, after).map((s) => s.container.externalId)).toEqual(["CA", "WEB"]);
  });
});

describe("ticket keys", () => {
  it("reads a key in any case and rejects words", () => {
    expect(ticketKeyOf(" web-101 ")).toBe("WEB-101");
    expect(ticketKeyOf("ABC_2-7")).toBe("ABC_2-7");
    for (const no of ["web", "101", "web-", "swatch images", "web-101 fix"]) expect(ticketKeyOf(no)).toBeNull();
  });
});
