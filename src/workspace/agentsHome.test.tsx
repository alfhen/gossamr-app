import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import type { Run, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { ClosedWorkstreams, DayAndWeek, DayScroll, NeedsTop, WorkstreamHeadExtras, WorkstreamTools, fadeScroll, hasMoreBelow, rowTitle } from "./AgentsHome";
import { AgentsScreen, type AgentsActions } from "./AgentsView";
import { NO_FILTERS } from "./agentsLogic";
import { loadPrefs, usePrefs } from "./prefs";
import { useRuns } from "./runsStore";
import { loadTabs, useTabs } from "./tabsStore";
import { currentNeeds } from "./useNeeds";
import { WorkstreamSheet } from "./WorkstreamSheet";
import { useWorkView } from "./workViewStore";
import { useWorkstreams } from "./workstreamsStore";

vi.mock("./useNow", () => ({ useNow: () => Date.parse("2026-09-30T12:00:00Z"), useToday: () => "2026-09-30" }));

const NOW = Date.parse("2026-09-30T12:00:00Z");
const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};
const noop = () => undefined;

/** Server rendering reads a store's initial state, so what a render should see is put into both. */
function seed<S extends object>(store: { getInitialState(): S; setState(patch: Partial<S>): void }, patch: Partial<S>) {
  Object.assign(store.getInitialState(), patch);
  store.setState(patch);
}

const view = (id: string, key: string | null, over: Partial<WorkstreamView["workstream"]> = {}): WorkstreamView =>
  ({
    workstream: { id, itemKey: key, title: key ? `${key} Checkout` : "Loose ends", connectionId: "mock", closedAt: null, createdAt: "2026-09-29T10:00:00Z", heldReason: null, mode: "advise", notes: null, ...over },
    stage: "intake",
    runs: [],
    labels: [],
    budget: { autoTurns: { used: 0, limit: 6 }, wakes: { used: 0, limit: 12 }, level: "ok" },
  }) as unknown as WorkstreamView;

beforeEach(() => {
  vi.stubGlobal("localStorage", memory());
  useTabs.setState(loadTabs());
});
afterEach(() => {
  seed(useRuns, { runs: [] as Run[] });
  seed(useWorkstreams, { list: [], closed: [] });
  useWorkView.getState().reset();
  vi.unstubAllGlobals();
});

describe("the Agents view's default", () => {
  it("groups by workstream, and starts on Agents, for a profile with nothing stored", () => {
    expect(loadPrefs()).toMatchObject({ agentsGroup: "workstream", startOnAgents: true });
  });

  it("starts everyone on Workstream once: the grouping the old default stored does not carry over, the one chosen since does", () => {
    localStorage.setItem("gossamr-prefs", JSON.stringify({ agentsGroup: "state" }));
    expect(loadPrefs().agentsGroup).toBe("workstream");
    localStorage.setItem("gossamr-prefs", JSON.stringify({ agentsGroupBy: "state" }));
    expect(loadPrefs().agentsGroup).toBe("state");
    usePrefs.getState().setAgentsGroup("workstream");
    expect(JSON.parse(localStorage.getItem("gossamr-prefs")!)).toMatchObject({ agentsGroupBy: "workstream" });
  });

  it("keeps a 'Start on Pip home' that was turned off turned off", () => {
    localStorage.setItem("gossamr-prefs", JSON.stringify({ startOnPipHome: false }));
    expect(loadPrefs().startOnAgents).toBe(false);
    localStorage.setItem("gossamr-prefs", JSON.stringify({ startOnAgents: true, startOnPipHome: false }));
    expect(loadPrefs().startOnAgents).toBe(true);
  });
});

describe("a workstream in the Agents list", () => {
  const actions = (): AgentsActions =>
    ({ select: noop, open: noop, attach: noop, draftComment: noop, buildFromPlan: noop, resume: noop, filter: noop, clearFilters: noop, setView: noop, setGroup: noop, toggleEarlier: noop, setIntro: noop, dismissIntro: noop, checkEnvironment: noop, retry: noop, fix: noop, retryLaunch: noop, copied: noop, stopAll: noop, startAgent: noop, openSafety: noop, openWorkstream: vi.fn() }) as AgentsActions;
  const screen = (workstreams: WorkstreamView[], runs: Run[] = [], over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <AgentsScreen runs={runs} status="ready" error={null} environment={{ claude: "ok", version: "2.1.286" }} filters={NO_FILTERS} selectedId={null} earlierOpen={false} introShown={false} view="cards" stopping={false} opened={new Set()} now={NOW} ticketTitle={() => null} on={actions()} workstreams={workstreams} {...over} />,
    );

  it("is a group even with no agent yet, with its ticket key, its stage and a button that opens it", () => {
    const html = screen([view("ws-1", "CA-401")]);
    expect(html).toContain('data-workstream-group="ws-1"');
    expect(html).toMatch(/<h3[^>]*><b[^>]*>CA-401<\/b><span[^>]*>Checkout<\/span><\/h3>/);
    expect(html).toContain("No agents on this workstream yet.");
    expect(html).toMatch(/<button[^>]*data-workstream-open="ws-1"[^>]*aria-label="Open workstream CA-401 Checkout"[^>]*>Open<\/button>/);
    expect(html).not.toContain("No agents yet");
  });

  it("marks the one whose detail is open", () => {
    expect(screen([view("ws-1", "CA-401"), view("ws-2", "CA-402")], [], { openWorkstream: "ws-2" }).match(/aria-current="true"/g)).toHaveLength(1);
  });

  it("is not listed with a filter on, which hides the groups that have no agent to match it", () => {
    const html = screen([view("ws-1", "CA-401")], [], { filters: { ...NO_FILTERS, repo: "acme/none" } });
    expect(html).not.toContain('data-workstream-group="ws-1"');
  });

  it("drops the ticket's key from the title it starts", () => {
    expect(rowTitle({ itemKey: "CA-401", title: "CA-401 Fix login" })).toBe("Fix login");
    expect(rowTitle({ itemKey: "CA-401", title: "Fix login" })).toBe("Fix login");
    expect(rowTitle({ itemKey: null, title: "Loose ends" })).toBe("Loose ends");
  });

  it("offers to start a workstream and to show the closed ones, from the toolbar", () => {
    const html = renderToStaticMarkup(<WorkstreamTools showClosed={false} onShowClosed={noop} />);
    expect(html).toMatch(/data-start-workstream[^>]*>Start a workstream…</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Show closed</);
    expect(renderToStaticMarkup(<WorkstreamTools showClosed onShowClosed={noop} />)).toMatch(/aria-pressed="true"[^>]*>Hide closed</);
  });
});

describe("closed workstreams", () => {
  const open = [view("ws-1", "CA-401")];
  const closed = [view("ws-9", "CA-401", { closedAt: "2026-09-20T10:00:00Z" }), view("ws-8", "CA-500", { closedAt: "2026-09-20T10:00:00Z" })];

  it("are read-only, each with a Reopen", () => {
    const html = renderToStaticMarkup(<ClosedWorkstreams closed={[closed[1]]} open={open} />);
    expect(html).toContain('data-closed-workstream="ws-8"');
    expect(html).toMatch(/<button[^>]*data-reopen-workstream="ws-8"[^>]*aria-label="Reopen CA-500"[^>]*>Reopen<\/button>/);
    expect(html).not.toContain("aria-disabled");
  });

  it("disable Reopen, with the reason showing, while the ticket has another open workstream", () => {
    const html = renderToStaticMarkup(<ClosedWorkstreams closed={[closed[0]]} open={open} />);
    expect(html).toMatch(/data-reopen-workstream="ws-9"[^>]*aria-disabled="true"/);
    expect(html).toContain("CA-401 already has an open workstream");
  });

  it("say so when there are none", () => {
    expect(renderToStaticMarkup(<ClosedWorkstreams closed={[]} open={open} />)).toContain("No closed workstreams.");
  });
});

describe("what a workstream's heading says of where it stands", () => {
  it("is one status word as a pill, described by its hint as text for a screen reader, with no extra tab stop", () => {
    const html = renderToStaticMarkup(<WorkstreamHeadExtras view={view("ws-1", "CA-401")} />);
    expect(html).toMatch(/<span data-status="idle"[^>]*aria-describedby="([^"]+)"[^>]*>Idle<\/span>/);
    const id = /<span data-status="[^"]+"[^>]*aria-describedby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${id}" data-status-hint="true" class="sr-only"`);
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain("data-needs-you-badge");
  });

  it("says a held-by-you workstream is held by you", () => {
    expect(renderToStaticMarkup(<WorkstreamHeadExtras view={view("ws-1", "CA-401", { heldReason: "person" })} />)).toMatch(/data-status="held"[^>]*>Held by you</);
  });
});

describe("the day region's room, and its fade", () => {
  it("shows a 'more below' cue only when a scroller is cut off by more than a few pixels", () => {
    expect(hasMoreBelow({ scrollHeight: 444, scrollTop: 0, clientHeight: 301 })).toBe(true);
    expect(hasMoreBelow({ scrollHeight: 444, scrollTop: 143, clientHeight: 301 })).toBe(false);
    expect(hasMoreBelow({ scrollHeight: 303, scrollTop: 0, clientHeight: 301 })).toBe(false);
  });

  it("scrolls most of a page, and jumps instead of gliding when the person asked for less motion", () => {
    expect(fadeScroll(200, false)).toEqual({ top: 160, behavior: "smooth" });
    expect(fadeScroll(200, true)).toEqual({ top: 160, behavior: "auto" });
  });

  it("gives Plan my week nearly half the window, so its three picks show, and Start my day a third", () => {
    expect(renderToStaticMarkup(<DayScroll label="Plan my week" tall>x</DayScroll>)).toContain("max-h-[min(45vh,26rem)]");
    const start = renderToStaticMarkup(<DayScroll label="Start my day">x</DayScroll>);
    expect(start).toContain("max-h-[30vh]");
    expect(start).not.toContain("45vh");
  });
});

describe("the Needs you strip", () => {
  it("is one region named Needs you whose count is the one count, and is not a second list of workstreams", () => {
    const html = renderToStaticMarkup(<NeedsTop />);
    expect(html).toContain("data-agents-strip");
    expect(html.match(/aria-label="Needs you"/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`data-needs-you-count[^>]*>${currentNeeds().length}<`));
    expect(html).not.toContain('aria-label="Your workstreams"');
  });

  it("puts the decision pane in the same place, closed until a need is opened", () => {
    expect(renderToStaticMarkup(<NeedsTop />)).not.toContain("data-needs-pane");
  });
});

describe("Start my day and Plan my week", () => {
  it("are away until asked for, and the plan takes the card's place while it is open", () => {
    expect(renderToStaticMarkup(<DayAndWeek />)).not.toContain("data-start-my-day");
    seed(useWorkView, { dayOpen: true });
    expect(renderToStaticMarkup(<DayAndWeek />)).toContain("data-start-my-day");
    seed(useWorkView, { planOpen: true });
    const plan = renderToStaticMarkup(<DayAndWeek />);
    expect(plan).toContain("data-plan-my-week");
    expect(plan).not.toContain("data-start-my-day");
  });
});

describe("a workstream's detail", () => {
  beforeEach(async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    await useWorkspace.getState().init(backend);
    await backend.workstreamsOpen(itemRef("CA-401"));
    const list = await backend.workstreamsList();
    seed(useWorkstreams, { list });
  });

  it("is a sheet over the view with the workstream's steps, controls and a way to ask Pip, and says which workstream it is", () => {
    const [{ workstream }] = useWorkstreams.getState().list;
    const html = renderToStaticMarkup(<WorkstreamSheet id={workstream.id} />);
    expect(html).toContain('id="workstream-sheet"');
    expect(html).toContain('aria-label="Workstream CA-401"');
    expect(html).toContain("data-step-rail");
    expect(html).toContain("data-workstream-controls");
    expect(html).toMatch(/data-workstream-pip[^>]*>Ask Pip about this</);
    expect(html).toMatch(/data-workstream-ticket[^>]*>Open CA-401</);
    // The agent sheet keeps its own id: a workstream's detail under a run's sheet is two sheets, not two of one id.
    expect(html).not.toContain('id="agent-sheet"');
  });

  it("is nothing for a workstream that is not open", () => {
    expect(renderToStaticMarkup(<WorkstreamSheet id="gone" />)).toBe("");
  });
});
