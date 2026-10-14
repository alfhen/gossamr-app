import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MockBackend } from "../backend/mock";
import type { Proposal, Run, WorkstreamView } from "../types";
import { pipHomeHints } from "./footerHints";
import { HINTS, keyHint } from "./keyMap";
import { entryLabel, timelineDrafts, timelineRuns } from "./Timeline";
import { ENTRY_FOCUS, anchoredScrollTop, followsEnd, nearBottom, firstShowing, readingAnchor, revealEntry, stepIndex, timelineKeyAction, timelineStop, upToTimeline } from "./timelineKeys";
import { usePipHome } from "./pipHomeStore";
import { useTabs } from "./tabsStore";
import { TimelineFilterBar, TimelineScopeToggle, showTimeline } from "./TimelineFilterBar";

const press = (key: string, mods: { shiftKey?: boolean; metaKey?: boolean } = {}) => ({ key, ...mods });

describe("the timeline's keys", () => {
  it("j and k (and the arrows) move from an entry's stop, whatever the entry is", () => {
    for (const kind of ["said", "pip", "run", "draft", "audit"]) {
      expect(timelineKeyAction(press("j"), true, kind)).toEqual({ type: "move", by: 1 });
      expect(timelineKeyAction(press("ArrowDown"), true, kind)).toEqual({ type: "move", by: 1 });
      expect(timelineKeyAction(press("k"), true, kind)).toEqual({ type: "move", by: -1 });
      expect(timelineKeyAction(press("ArrowUp"), true, kind)).toEqual({ type: "move", by: -1 });
    }
  });

  it("Enter and o open a line; a run's row opens itself on Enter, and a draft's card takes both", () => {
    for (const kind of ["said", "pip", "audit"]) {
      expect(timelineKeyAction(press("Enter"), true, kind)).toEqual({ type: "open" });
      expect(timelineKeyAction(press("o"), true, kind)).toEqual({ type: "open" });
    }
    expect(timelineKeyAction(press("Enter"), true, "run")).toBeNull();
    expect(timelineKeyAction(press("o"), true, "run")).toEqual({ type: "open" });
    expect(timelineKeyAction(press("Enter"), true, "draft")).toBeNull();
    expect(timelineKeyAction(press("o"), true, "draft")).toBeNull();
  });

  it("opens the Pip pane's run card on Enter too, since the card has no Enter of its own", () => {
    expect(timelineKeyAction(press("Enter"), true, "run", false)).toEqual({ type: "open" });
    expect(timelineKeyAction(press("o"), true, "run", false)).toEqual({ type: "open" });
    // A draft's card keeps its own keys there too.
    expect(timelineKeyAction(press("Enter"), true, "draft", false)).toBeNull();
  });

  it("leaves a key pressed inside an entry (a button, a field) or with a modifier, and every other key, alone", () => {
    expect(timelineKeyAction(press("j"), false, "audit")).toBeNull();
    expect(timelineKeyAction(press("j", { shiftKey: true }), true, "audit")).toBeNull();
    expect(timelineKeyAction(press("o", { metaKey: true }), true, "audit")).toBeNull();
    for (const k of ["a", "d", "s", "e", "x", "Escape"]) expect(timelineKeyAction(press(k), true, "audit")).toBeNull();
  });

  it("steps within the list: from none j starts at the top and k at the bottom; at either end it stays", () => {
    expect(stepIndex(-1, 4, 1)).toBe(0);
    expect(stepIndex(-1, 4, -1)).toBe(3);
    expect(stepIndex(1, 4, 1)).toBe(2);
    expect(stepIndex(3, 4, 1)).toBe(3);
    expect(stepIndex(0, 4, -1)).toBe(0);
    expect(stepIndex(-1, 0, 1)).toBe(-1);
  });

  it("stands on a draft's card or a run's row, else on the entry itself", () => {
    const card = { id: "card" };
    const entry = (kind: string, inner: unknown) => ({ getAttribute: (n: string) => (n === "data-kind" ? kind : null), querySelector: vi.fn(() => inner) });
    expect(timelineStop(entry("draft", card) as never)).toBe(card);
    expect(timelineStop(entry("run", card) as never)).toBe(card);
    const audit = entry("audit", card);
    expect(timelineStop(audit as never)).toBe(audit);
    const bare = entry("draft", null);
    expect(timelineStop(bare as never)).toBe(bare);
  });

  it("ArrowUp from the empty input goes to the newest entry; never with text typed or no timeline", () => {
    const focus = vi.fn();
    const last = { getAttribute: () => "audit", querySelector: () => null, focus };
    const root = { querySelectorAll: () => [{ getAttribute: () => "audit", querySelector: () => null, focus: vi.fn() }, last] };
    const ev = { key: "ArrowUp", preventDefault: vi.fn() };
    expect(upToTimeline(ev, "", root)).toBe(true);
    expect(focus).toHaveBeenCalled();
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(upToTimeline({ key: "ArrowUp", preventDefault: vi.fn() }, "typing", root)).toBe(false);
    expect(upToTimeline({ key: "ArrowUp", preventDefault: vi.fn() }, "", { querySelectorAll: () => [] })).toBe(false);
    expect(upToTimeline({ key: "k", preventDefault: vi.fn() }, "", root)).toBe(false);
  });

  it("names its keys in the footer from the one model", () => {
    expect(keyHint("timeline")).toBe("j k move through the timeline · ↵ o open");
    const hints = pipHomeHints(false, true);
    expect(hints.find((h) => h.id === "timeline")?.keys).toEqual(["j", "k"]);
    expect(hints.find((h) => h.id === "open")?.keys).toEqual(["↵", "o"]);
    expect(pipHomeHints().some((h) => h.id === "timeline")).toBe(false);
    expect(HINTS.timeline).toHaveLength(2);
  });
});

describe("the filter bar", () => {
  it("presses the filter shown and names each, with counts when given", () => {
    const html = renderToStaticMarkup(createElement(TimelineFilterBar, { value: "runs", onChange: () => {}, counts: { all: 7, runs: 2, drafts: 3, decisions: 1 } }));
    expect(html).toContain('aria-label="Timeline filter"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-filter="runs"/);
    expect((html.match(/aria-pressed="false"/g) ?? []).length).toBe(3);
    for (const label of ["All", "Runs", "Drafts", "Decisions"]) expect(html).toMatch(new RegExp(`>${label} <span data-filter-count`));
    expect(html).toContain(">2<");
  });

  it("names the pane's filter its own, so it never reads as the main timeline's", () => {
    const html = renderToStaticMarkup(createElement(TimelineFilterBar, { value: "all", onChange: () => {}, label: "Filter" }));
    expect(html).toContain('aria-label="Filter"');
    expect(html).not.toContain("Timeline filter");
  });

  it("presses the scope shown, with Runs as with any filter: no scope is another screen", () => {
    const html = renderToStaticMarkup(createElement(TimelineScopeToggle, { value: "workstream", onChange: () => {} }));
    expect(html).toContain('aria-label="Timeline scope"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-scope="workstream"[^>]*>This workstream</);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-scope="every"[^>]*>Every workstream</);
    expect(html).not.toContain("Agents screen");
  });
});

describe("what a conversation's timeline holds", () => {
  const backend = new MockBackend();
  const runs = backend.runs.list();
  const view = (id: string, runIds: string[]): WorkstreamView => ({ workstream: { id, itemKey: "CA-401" }, runs: runIds }) as unknown as WorkstreamView;

  it("a workstream's own runs; in General, those in no workstream", () => {
    const own = { ...runs[0], id: "own", spec: { ...runs[0].spec, workstream: "ws-1" } } as Run;
    const linked = { ...runs[0], id: "linked", spec: { ...runs[0].spec, workstream: null } } as Run;
    const free = { ...runs[0], id: "free", spec: { ...runs[0].spec, workstream: null } } as Run;
    const other = { ...runs[0], id: "other", spec: { ...runs[0].spec, workstream: "ws-2" } } as Run;
    const all = [own, linked, free, other];
    expect(timelineRuns(all, view("ws-1", ["linked"])).map((r) => r.id)).toEqual(["own", "linked"]);
    expect(timelineRuns(all, null).map((r) => r.id)).toEqual(["linked", "free"]);
  });

  it("a workstream's drafts as its conversation shows them; in General, those in no workstream, Pip's answers here, and every one waiting", () => {
    const p = (id: string, state: Proposal["state"]["type"], origin: Proposal["origin"]) => ({ id, state: { type: state }, origin, intent: { type: "comment" } }) as unknown as Proposal;
    const loose = p("loose", "applied", { type: "board" });
    const mine = p("mine", "applied", { type: "chat", requestId: "q1", workstream: "ws-1" });
    const waiting = p("waiting", "pending", { type: "run", runId: "r1", shortId: null, workstream: "ws-1" });
    const elsewhere = p("elsewhere", "skipped", { type: "run", runId: "r1", shortId: null, workstream: "ws-1" });
    const all = [loose, mine, waiting, elsewhere];
    expect(timelineDrafts(all, true, new Set())).toEqual(all);
    expect(timelineDrafts(all, false, new Set(["q1"])).map((x) => x.id)).toEqual(["loose", "mine", "waiting"]);
    expect(timelineDrafts(all, false, new Set()).map((x) => x.id)).toEqual(["loose", "waiting"]);
  });
});

describe("showing a filter in a scope", () => {
  it("goes to Pip home's timeline with both, Runs in every workstream included", () => {
    usePipHome.getState().reset();
    useTabs.getState().setRoute("workspace");
    showTimeline("drafts", "every");
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState()).toMatchObject({ timelineFilter: "drafts", timelineScope: "every" });
    useTabs.getState().setRoute("workspace");
    showTimeline("runs");
    // Runs in every workstream stays on Pip home's timeline; it no longer redirects to the Agents screen.
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState()).toMatchObject({ timelineFilter: "runs", timelineScope: "every" });
    showTimeline("decisions");
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState()).toMatchObject({ timelineFilter: "decisions", timelineScope: "every" });
    showTimeline("runs", "workstream");
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState()).toMatchObject({ timelineFilter: "runs", timelineScope: "workstream" });
  });
});

describe("following the timeline's end", () => {
  const el = (scrollTop: number) => ({ scrollTop, scrollHeight: 1000, clientHeight: 400 });
  it("counts within 24px of the end as at it", () => {
    expect(nearBottom(el(600))).toBe(true);
    expect(nearBottom(el(580))).toBe(true);
    expect(nearBottom(el(500))).toBe(false);
  });
  it("follows while at the end, keeps a reader's place, and follows the person's own send", () => {
    const user = { kind: "user" as const };
    const wake = { kind: "wake" as const };
    expect(followsEnd(true, 2, [user, user])).toBe(true);
    expect(followsEnd(false, 2, [user, user])).toBe(false);
    expect(followsEnd(false, 2, [user, user, wake])).toBe(false);
    expect(followsEnd(false, 2, [user, user, {}])).toBe(true);
    expect(followsEnd(false, 0, [user])).toBe(true);
  });
});

describe("an entry's focus ring and reveal", () => {
  it("draws the ring with a solid style and clears the chips row below", () => {
    expect(ENTRY_FOCUS).toContain("focus-visible:outline-solid");
    expect(ENTRY_FOCUS).toContain("scroll-mb-14");
  });

  it("scrolls an entry that took focus itself into view, and leaves a card or button inside it to scroll itself", () => {
    const scrollIntoView = vi.fn();
    const li = { scrollIntoView };
    revealEntry({ target: li, currentTarget: li });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    scrollIntoView.mockClear();
    revealEntry({ target: {}, currentTarget: li });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("keeping the entry being read in place", () => {
  const rows = [
    { key: "a", top: -300, bottom: -20 },
    { key: "b", top: -20, bottom: 180 },
    { key: "c", top: 180, bottom: 400 },
  ];

  it("anchors on the first entry still showing under the scroller's top, with its offset", () => {
    expect(readingAnchor(0, rows)).toEqual({ key: "b", offset: -20 });
    expect(readingAnchor(1000, rows)).toBeNull();
  });

  it("scrolls by however far that entry moved, so a card above collapsing does not carry the reader off", () => {
    const anchor = { key: "b", offset: -20 };
    // The entry above shrank by 150: b now sits at -170, so the scroller moves up by 150 to put it back.
    expect(anchoredScrollTop(500, anchor, -170, 0)).toBe(350);
    // Nothing moved: nothing to do.
    expect(anchoredScrollTop(500, anchor, -20, 0)).toBe(500);
    // Never past the top.
    expect(anchoredScrollTop(10, anchor, -170, 0)).toBe(0);
  });
});

describe("firstShowing", () => {
  const bottoms = [10, 20, 30, 40, 50];
  it("finds the first entry whose bottom is below the top, reading only a few", () => {
    const read = vi.fn((i: number) => bottoms[i]);
    expect(firstShowing(5, read, 25)).toBe(2);
    expect(read.mock.calls.length).toBeLessThan(5);
    expect(firstShowing(5, (i) => bottoms[i], -1)).toBe(0);
    expect(firstShowing(5, (i) => bottoms[i], 50)).toBe(5);
    expect(firstShowing(0, () => 0, 0)).toBe(0);
  });
});

describe("entryLabel", () => {
  const base = { kind: "audit", scopeLabel: undefined, text: "The reporter replied on the ticket" } as const;
  it("tells the reply entry what Enter does, and leaves other entries as their sentence", () => {
    expect(entryLabel({ ...base, target: { type: "comment", ticketKey: "CA-1", id: "c1" } })).toBe("The reporter replied on the ticket. Enter opens the comment");
    expect(entryLabel({ ...base, scopeLabel: "CA-1", target: { type: "comment", ticketKey: "CA-1", id: "c1" } })).toBe("CA-1: The reporter replied on the ticket. Enter opens the comment");
    expect(entryLabel({ ...base, target: null })).toBe("The reporter replied on the ticket");
    expect(entryLabel({ ...base, kind: "said", target: null })).toBeUndefined();
  });
});
