import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MockBackend } from "../backend/mock";
import type { Proposal, Run, WorkstreamView } from "../types";
import { pipHomeHints } from "./footerHints";
import { HINTS, keyHint } from "./keyMap";
import { TimelineFilterBar } from "./TimelineFilterBar";
import { timelineDrafts, timelineRuns } from "./Timeline";
import { stepIndex, timelineKeyAction, timelineStop, upToTimeline } from "./timelineKeys";

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
