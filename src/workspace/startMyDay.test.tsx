import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import type { StartMyDay } from "../lib/startMyDay";
import type { Intent, Proposal } from "../types";
import { useWorkspace } from "../workspaceStore";
import { JiraSentView, SentRow } from "./JiraSentView";
import { jiraSent } from "../lib/jiraSent";
import { DAY_EMPTY, DayLineView, StartMyDayView, doneForNow, runDayAction, showStartMyDay } from "./StartMyDay";
import { usePipHome } from "./pipHomeStore";
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
  usePrefs.setState({ startMyDayDoneOn: null, clarityLearning: {} });
  backend = new MockBackend({ runs: { seed: "empty", prSurfaceMs: null }, wsManage: true });
  backend.supervisor.dispose();
  await useWorkspace.getState().init(backend);
  useWorkstreams.getState().init(backend);
});
afterEach(() => {
  useWorkstreams.getState().dispose();
  usePrefs.setState({ startMyDayDoneOn: null, clarityLearning: {} });
  usePipHome.getState().reset();
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

  it("is a labelled region with a heading, each line a titled list whose entries have a button saying what it does", () => {
    const html = renderToStaticMarkup(<StartMyDayView day={day} onDone={() => {}} onSent={() => {}} />);
    expect(html).toMatch(/<section data-start-my-day="true"[^>]*aria-labelledby="start-my-day"/);
    expect(html).toMatch(/<h2 id="start-my-day"[^>]*>Start my day<\/h2>/);
    expect(html).toContain("2 waiting on the reporter");
    expect(html).toContain('aria-label="Draft a nudge: CA-408 · waiting 3 days"');
    expect(html).toContain("and 2 more");
    expect(html).toMatch(/<button[^>]*data-day-done[^>]*>Done for now<\/button>/);
    expect(html).toMatch(/<button[^>]*data-day-sent[^>]*>What Jira saw from me<\/button>/);
    expect(html).toContain("Once a day: what needs you, what is stuck and what may be unclear. Nothing is posted.");
    expect(html).toMatch(/<button[^>]*data-day-done[^>]*title="Hides Start my day until tomorrow/);
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

  it("says what a quiet day looks like instead of an empty box", () => {
    const html = renderToStaticMarkup(<StartMyDayView day={{ lines: [], empty: true }} onDone={() => {}} onSent={() => {}} />);
    expect(html).toContain(DAY_EMPTY);
    expect(html).not.toContain("data-day-line");
  });

  it("Done for now keeps it away for the rest of today, in the prefs, and the palette brings it back", () => {
    const at = new Date(2026, 9, 13, 8, 0);
    doneForNow(at);
    expect(usePrefs.getState().startMyDayDoneOn).toBe("2026-10-13");
    expect(JSON.parse(localStorage.getItem("gossamr-prefs")!).startMyDayDoneOn).toBe("2026-10-13");
    usePipHome.setState({ deciding: "draft:x" });
    showStartMyDay();
    expect(usePrefs.getState().startMyDayDoneOn).toBeNull();
    expect(usePipHome.getState().deciding).toBeNull();
    expect(useTabs.getState().route).toBe("pip");
  });

  it("opens the right thing: a need's decision, a workstream, a ticket's peek", async () => {
    const id = (await backend.workstreamsOpen(itemRef("CA-408"))).id;
    await useWorkstreams.getState().refresh();
    runDayAction({ type: "workstream", id });
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState().selected).toBe(id);
    runDayAction({ type: "ticket", key: "CA-402" });
    expect(useTabs.getState().selected).toBe("mock:CA-402");
    runDayAction({ type: "need", need: { key: "draft:p1", workstreamId: id } as never });
    expect(usePipHome.getState()).toMatchObject({ deciding: "draft:p1", selected: id });
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
    expect(html).toContain("from Pip, on CA-401");
  });

  it("keeps the rest behind a Show all that is closed to begin with", () => {
    const html = renderToStaticMarkup(<SentRow entry={sent()} onTicket={() => {}} onWorkstream={() => {}} />);
    expect(html).toMatch(/aria-expanded="false"[^>]*>Show all</);
    expect(html).not.toContain("data-sent-detail");
    expect(html).not.toContain("Second paragraph.");
  });
});

describe("What Jira saw from me: the way back", () => {
  it("has a back link to Pip home in its header", () => {
    const html = renderToStaticMarkup(<JiraSentView />);
    expect(html).toMatch(/<button[^>]*data-sent-back[^>]*>← Pip home<\/button>/);
  });
});
