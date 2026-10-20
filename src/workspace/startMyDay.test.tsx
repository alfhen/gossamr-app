import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import type { StartMyDay } from "../lib/startMyDay";
import type { Intent, Proposal } from "../types";
import { useWorkspace } from "../workspaceStore";
import { DetailLine, GITHUB_NOT_LISTED, JiraSentView, SENT_EMPTY, SentRow } from "./JiraSentView";
import { jiraSent } from "../lib/jiraSent";
import { DAY_EMPTY, DayLineView, UNCLEAR_NEXT, StartMyDayView, doneForNow, runDayAction, showStartMyDay } from "./StartMyDay";
import { useWorkView } from "./workViewStore";
import { usePrefs } from "./prefs";
import { loadTabs, useTabs } from "./tabsStore";
import { useWorkstreams } from "./workstreamsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

let backend: MockBackend;
beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  vi.stubGlobal("requestAnimationFrame", () => 0);
  useTabs.setState(loadTabs());
  usePrefs.setState({ clarityLearning: {} });
  backend = new MockBackend({ runs: { seed: "empty", prSurfaceMs: null }, wsManage: true });
  backend.supervisor.dispose();
  await useWorkspace.getState().init(backend);
  useWorkstreams.getState().init(backend);
});
afterEach(() => {
  useWorkstreams.getState().dispose();
  usePrefs.setState({ clarityLearning: {} });
  useWorkView.getState().reset();
  vi.unstubAllGlobals();
});

const entry = (key: string, text: string, label: string, action: StartMyDay["lines"][number]["entries"][number]["action"]) => ({ key, text, label, action });

describe("the Start my day card", () => {
  const day: StartMyDay = {
    empty: false,
    lines: [
      { kind: "reporter", title: "2 waiting on the reporter", count: 2, more: 0, entries: [entry("reporter:w1", "CA-408 · waiting 3 days", "Draft a nudge", { type: "nudge", id: "w1" }), entry("reporter:w2", "CA-409 · waiting since today", "Open workstream", { type: "workstream", id: "w2" })] },
      { kind: "approve", title: "5 to approve", count: 5, more: 2, entries: [entry("a1", "CA-401 · Draft comment", "Open", { type: "workstream", id: "w1" })] },
    ],
  };

  it("is a heading and titled lists whose entries have a button saying what it does, not a second region inside the Agents view's own (G28)", () => {
    const html = renderToStaticMarkup(<StartMyDayView day={day} onDone={() => {}} onSent={() => {}} />);
    expect(html).toMatch(/<div data-start-my-day="true"/);
    expect(html).not.toMatch(/<section data-start-my-day|data-start-my-day[^>]*aria-labelledby/);
    expect(html).toMatch(/<h2 id="start-my-day"[^>]*>Start my day<\/h2>/);
    expect(html).toContain("2 waiting on the reporter");
    expect(html).toContain('aria-label="Draft a nudge: CA-408 · waiting 3 days"');
    expect(html).toContain("and 2 more");
    expect(html).toMatch(/<button[^>]*data-day-done[^>]*>Done for now<\/button>/);
    expect(html).toMatch(/<button[^>]*data-day-sent[^>]*>What Jira saw from me<\/button>/);
    expect(html).toContain("What needs you, what is stuck and what may be unclear. Nothing is posted.");
    expect(html).toMatch(/<button[^>]*data-day-done[^>]*title="Hides Start my day\./);
    // It only shows; the card has no button that posts, approves or sends anything.
    expect(html).not.toMatch(/Post comment|Approve|Send/);
  });

  it("turns 'and N more' into a button that lists the rest in place, when the line holds them", () => {
    const more = (n: number) => entry(`x${n}`, `CA-${n} · Draft comment`, "Open", { type: "workstream", id: `w${n}` });
    const line = { kind: "approve" as const, title: "5 to approve", count: 5, more: 2, entries: [more(1), more(2), more(3)], rest: [more(4), more(5)] };
    const html = renderToStaticMarkup(<DayLineView line={line} />);
    expect(html).toMatch(/<button[^>]*data-day-more[^>]*aria-expanded="false"[^>]*>Show 2 more<\/button>/);
    expect(html).not.toContain("CA-4 ");
    const open = renderToStaticMarkup(<DayLineView line={line} initiallyOpen />);
    expect(open.match(/data-day-entry=/g)).toHaveLength(5);
    expect(open).toMatch(/aria-expanded="true"[^>]*>Show fewer</);
  });

  it("collapses a long unclear list to its count and a More button that lists them all, and leaves a short one open (G19)", () => {
    const unclear = (n: number) => entry(`u${n}`, `CA-${n} may be unclear: it has a very short description.`, "Open workstream", { type: "workstream", id: `w${n}` });
    const long = { kind: "unclear" as const, title: "5 tickets may be unclear", count: 5, more: 2, entries: [unclear(1), unclear(2), unclear(3)], rest: [unclear(4), unclear(5)] };
    const closed = renderToStaticMarkup(<DayLineView line={long} />);
    expect(closed).toContain("5 tickets may be unclear");
    expect(closed).not.toContain("data-day-entry=");
    expect(closed).toMatch(/<button[^>]*data-day-more[^>]*aria-expanded="false"[^>]*>More<\/button>/);
    const open = renderToStaticMarkup(<DayLineView line={long} initiallyOpen />);
    expect(open.match(/data-day-entry=/g)).toHaveLength(5);
    expect(open).toMatch(/aria-expanded="true"[^>]*>Show fewer</);
    // The collapsed line says what to do next, so the growing count is not the end of it (G27); open, the entries are the next step.
    expect(closed).toContain(`data-day-next`);
    expect(closed).toContain(UNCLEAR_NEXT);
    expect(open).not.toContain("data-day-next");
    const short = { kind: "unclear" as const, title: "2 tickets may be unclear", count: 2, more: 0, entries: [unclear(1), unclear(2)], rest: [] };
    const html = renderToStaticMarkup(<DayLineView line={short} />);
    expect(html.match(/data-day-entry=/g)).toHaveLength(2);
    expect(html).not.toContain("data-day-more");
  });

  it("names what each More button expands, starting with the words it shows (G28)", () => {
    const more = (n: number) => entry(`x${n}`, `CA-${n} · Draft comment`, "Open", { type: "workstream", id: `w${n}` });
    const approve = { kind: "approve" as const, title: "5 to approve", count: 5, more: 2, entries: [more(1), more(2), more(3)], rest: [more(4), more(5)] };
    expect(renderToStaticMarkup(<DayLineView line={approve} />)).toContain('aria-label="Show 2 more: 5 to approve"');
    expect(renderToStaticMarkup(<DayLineView line={approve} initiallyOpen />)).toContain('aria-label="Show fewer: 5 to approve"');
    const unclear = { kind: "unclear" as const, title: "5 tickets may be unclear", count: 5, more: 2, entries: [more(1), more(2), more(3)], rest: [more(4), more(5)] };
    expect(renderToStaticMarkup(<DayLineView line={unclear} />)).toContain('aria-label="More: 5 tickets may be unclear"');
  });

  it("says what a quiet day looks like instead of an empty box", () => {
    const html = renderToStaticMarkup(<StartMyDayView day={{ lines: [], empty: true }} onDone={() => {}} onSent={() => {}} />);
    expect(html).toContain(DAY_EMPTY);
    expect(html).not.toContain("data-day-line");
  });

  it("is away until asked for: the palette opens it and Done for now puts it away again", () => {
    expect(useWorkView.getState().dayOpen).toBe(false);
    useWorkView.setState({ deciding: "draft:x" });
    showStartMyDay();
    expect(useWorkView.getState().dayOpen).toBe(true);
    doneForNow();
    expect(useWorkView.getState().dayOpen).toBe(false);
    showStartMyDay();
    expect(useWorkView.getState().dayOpen).toBe(true);
    expect(useWorkView.getState().deciding).toBeNull();
    expect(useTabs.getState().route).toBe("agents");
  });

  it("opens the right thing: a need's decision, a workstream, a ticket's peek", async () => {
    const id = (await backend.workstreamsOpen(itemRef("CA-408"))).id;
    await useWorkstreams.getState().refresh();
    runDayAction({ type: "workstream", id });
    expect(useTabs.getState().route).toBe("agents");
    expect(useWorkView.getState().selected).toBe(id);
    runDayAction({ type: "ticket", key: "CA-402" });
    expect(useTabs.getState().selected).toBe("mock:CA-402");
    runDayAction({ type: "need", need: { key: "draft:p1", workstreamId: id } as never });
    expect(useWorkView.getState()).toMatchObject({ deciding: "draft:p1", selected: id });
  });
});

describe("a row of What Jira saw from me", () => {
  const sent = () => {
    const p = { id: "c1", createdAt: "2026-10-13T08:00:00Z", updatedAt: "2026-10-13T09:00:00Z", origin: { type: "chat", requestId: "r", workstream: "w1" }, createdBy: "pip", intent: { type: "comment", item: itemRef("CA-401"), body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "First line.", marks: [] }] }, { type: "paragraph", content: [{ type: "text", text: "Second paragraph.", marks: [] }] }] } } as Intent, label: null, basis: null, state: { type: "applied" }, revisions: [{ at: "2026-10-13T08:30:00Z", note: "Edited", intent: {} as Intent }], created: [], error: null, run: null } as unknown as Proposal;
    return jiraSent({ proposals: [p], events: {}, workstreams: [{ workstream: { id: "w1", itemKey: "CA-401", title: "CA-401 Welcome", closedAt: null }, labels: [], runs: [] } as never] })[0];
  };

  it("shows the ticket, what was posted, the workstream it came from and that the person edited Pip's draft", () => {
    const html = renderToStaticMarkup(<SentRow entry={sent()} onTicket={() => {}} onWorkstream={() => {}} />);
    expect(html).toContain('data-sent-entry="c1"');
    expect(html).toMatch(/data-sent-ticket[^>]*>CA-401</);
    expect(html).toMatch(/data-sent-label[^>]*>Comment</);
    expect(html).toMatch(/data-sent-summary[^>]*>First line\./);
    expect(html).toContain('data-sent-edited="yes"');
    expect(html).toContain("Pip drafted it; you edited it before approving");
    expect(html).toMatch(/data-sent-workstream="w1"[^>]*>CA-401</);
    expect(html).toContain("Made from Pip, in the workstream");
  });

  it("reads as two sentences, and its two CA-401 buttons have names of their own (G12)", () => {
    const html = renderToStaticMarkup(<SentRow entry={sent()} onTicket={() => {}} onWorkstream={() => {}} />);
    expect(html).not.toContain("·");
    expect(html).toContain("before approving.</span>");
    expect(html).toMatch(/Made from Pip, in the workstream <button[^>]*>CA-401<\/button>\.<\/span>/);
    expect(html).toMatch(/data-sent-ticket="true" aria-label="Open CA-401 in Gossamr"/);
    expect(html).toMatch(/data-sent-workstream="w1" aria-label="Open the workstream CA-401"/);
  });

  it("keeps the whole text behind a Show the posted text that is closed to begin with, under a second line of its own (G25)", () => {
    const html = renderToStaticMarkup(<SentRow entry={sent()} onTicket={() => {}} onWorkstream={() => {}} />);
    expect(html).toMatch(/aria-expanded="false"[^>]*>Show the posted text</);
    expect(html).not.toContain("data-sent-detail");
    expect(html).toMatch(/data-sent-second[^>]*>Second paragraph\./);
  });

  it("shows no second line for an entry that has none", () => {
    expect(renderToStaticMarkup(<SentRow entry={{ ...sent(), second: undefined }} onTicket={() => {}} onWorkstream={() => {}} />)).not.toContain("data-sent-second");
  });
});

describe("What Jira saw from me: the way back", () => {
  it("has a back link to Agents in its header", () => {
    const html = renderToStaticMarkup(<JiraSentView />);
    expect(html).toMatch(/<button[^>]*data-sent-back[^>]*>← Agents<\/button>/);
  });

  it("says in its header and its empty note that GitHub reviews are not listed, and where they show (G2)", () => {
    const html = renderToStaticMarkup(<JiraSentView />).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
    expect(html).toContain("GitHub reviews Gossamr posted are not listed here");
    expect(GITHUB_NOT_LISTED).toContain("You posted an agent's GitHub review");
    expect(SENT_EMPTY).not.toContain(GITHUB_NOT_LISTED);
    expect(html.split(GITHUB_NOT_LISTED).length).toBe(2);
  });

  it("does not say how long Gossamr has been posting when it has no posts on record (G22)", () => {
    expect(SENT_EMPTY).toMatch(/^No posts to Jira from Gossamr are on record here\./);
    expect(SENT_EMPTY).not.toMatch(/yet|never|today|this week/i);
  });
});

describe("a posted description's lines and the full stop (G13, G10)", () => {
  const entry = () => {
    const p = { id: "d1", createdAt: "2026-10-13T08:00:00Z", updatedAt: "2026-10-13T09:00:00Z", origin: { type: "chat", requestId: "r", workstream: "w1" }, createdBy: "pip", intent: { type: "rewrite", item: itemRef("WEB-101"), title: null, body: { from: { blocks: [] }, to: { blocks: [] }, fromText: "Keep\nOld line", toText: "Keep\nNew line" }, flattened: [] } as unknown as Intent, label: null, basis: null, state: { type: "applied" }, revisions: [], created: [], error: null, run: null } as unknown as Proposal;
    return jiraSent({ proposals: [p], events: {}, workstreams: [{ workstream: { id: "w1", itemKey: "WEB-101", title: "WEB-101 Welcome", closedAt: null }, labels: [], runs: [] } as never] })[0];
  };

  it("hides each diff marker from a screen reader and says Added or Removed in its place, leaving the strings as they are", () => {
    const e = entry();
    expect(e.detail).toContain("+ New line");
    expect(e.detail).toContain("− Old line");
    expect(renderToStaticMarkup(<DetailLine line="+ New line" diff />)).toBe('<span aria-hidden="true">+ </span><span class="sr-only">Added: </span>New line');
    expect(renderToStaticMarkup(<DetailLine line="− Old line" diff />)).toBe('<span aria-hidden="true">− </span><span class="sr-only">Removed: </span>Old line');
    expect(renderToStaticMarkup(<DetailLine line="  Keep" diff />)).toBe('<span aria-hidden="true">  </span>Keep');
    expect(renderToStaticMarkup(<DetailLine line="+ not a diff" diff={false} />)).toBe("+ not a diff");
  });

  it("puts no padding after the workstream's name, so its full stop is not set off by a space", () => {
    const html = renderToStaticMarkup(<SentRow entry={entry()} onTicket={() => {}} onWorkstream={() => {}} />);
    expect(html).toMatch(/<button[^>]*data-sent-workstream="w1"[^>]*class="[^"]*pl-1[^"]*"/);
    expect(html).not.toMatch(/data-sent-workstream="w1"[^>]*class="[^"]*\bpx-1\b/);
    expect(html).toMatch(/WEB-101<\/button>\.<\/span>/);
  });
});
