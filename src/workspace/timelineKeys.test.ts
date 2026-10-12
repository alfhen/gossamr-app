import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MockBackend } from "../backend/mock";
import type { Proposal, Run, WorkstreamView } from "../types";
import { pipHomeHints } from "./footerHints";
import { HINTS, keyHint } from "./keyMap";
import { timelineDrafts, timelineRuns } from "./Timeline";
import { followsEnd, nearBottom, stepIndex, timelineKeyAction, timelineStop, upToTimeline } from "./timelineKeys";
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

  it("presses the scope shown, and says Every workstream with Runs is the Agents screen", () => {
    const html = renderToStaticMarkup(createElement(TimelineScopeToggle, { value: "workstream", filter: "runs", onChange: () => {} }));
    expect(html).toContain('aria-label="Timeline scope"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-scope="workstream"[^>]*>This workstream</);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-scope="every"[^>]*title="Runs in every workstream: the Agents screen"[^>]*>Every workstream</);
    const all = renderToStaticMarkup(createElement(TimelineScopeToggle, { value: "every", filter: "all", onChange: () => {} }));
    expect(all).not.toContain("Agents screen");
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
  it("goes to Pip home's timeline with both, and to the Agents screen for Runs in every workstream", () => {
    usePipHome.getState().reset();
    useTabs.getState().setRoute("workspace");
    showTimeline("drafts", "every");
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState()).toMatchObject({ timelineFilter: "drafts", timelineScope: "every" });
    showTimeline("runs");
    expect(useTabs.getState().route).toBe("agents");
    // Pip home keeps what it showed, and the scope: leaving Agents by another filter stays in every workstream.
    expect(usePipHome.getState()).toMatchObject({ timelineFilter: "drafts", timelineScope: "every" });
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
