import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import type { Run, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { ClosedWorkstreams, WorkstreamHeadExtras, WorkstreamTools, rowTitle } from "./AgentsHome";
import { AgentsScreen, type AgentsActions } from "./AgentsView";
import { NO_FILTERS } from "./agentsLogic";
import { loadPrefs, usePrefs } from "./prefs";
import { useRuns } from "./runsStore";
import { loadTabs, useTabs } from "./tabsStore";
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
    workstream: { id, itemKey: key, title: key ? `${key} Checkout` : "Loose ends", connectionId: "mock", closedAt: null, createdAt: "2026-09-29T10:00:00Z", pausedReason: null, notes: null, ...over },
    stage: "intake",
    runs: [],
    labels: [],
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
  it("groups by workstream for a profile with nothing stored", () => {
    expect(loadPrefs()).toMatchObject({ agentsGroup: "workstream" });
  });

  it("starts everyone on Workstream once: the grouping the old default stored does not carry over, the one chosen since does", () => {
    localStorage.setItem("gossamr-prefs", JSON.stringify({ agentsGroup: "state" }));
    expect(loadPrefs().agentsGroup).toBe("workstream");
    localStorage.setItem("gossamr-prefs", JSON.stringify({ agentsGroupBy: "state" }));
    expect(loadPrefs().agentsGroup).toBe("state");
    usePrefs.getState().setAgentsGroup("workstream");
    expect(JSON.parse(localStorage.getItem("gossamr-prefs")!)).toMatchObject({ agentsGroupBy: "workstream" });
  });

  it("reads a profile that still stores keys no longer used", () => {
    localStorage.setItem("gossamr-prefs", JSON.stringify({ startOnAgents: false, startOnPipHome: false, agentsIntroSeen: true, agentsView: "list", agentsGroupBy: "state" }));
    expect(loadPrefs()).toMatchObject({ agentsGroup: "state" });
    expect(loadPrefs()).not.toHaveProperty("agentsView");
    usePrefs.getState().setAgentsGroup("workstream");
    expect(JSON.parse(localStorage.getItem("gossamr-prefs")!)).not.toHaveProperty("agentsView");
  });
});

describe("a workstream in the Agents list", () => {
  const actions = (): AgentsActions =>
    ({ select: noop, open: noop, attach: noop, draftComment: noop, buildFromPlan: noop, resume: noop, filter: noop, clearFilters: noop, setGroup: noop, toggleEarlier: noop, setIntro: noop, dismissIntro: noop, retry: noop, fix: noop, retryLaunch: noop, copied: noop, stopAll: noop, askPip: noop, openSafety: noop, openWorkstream: vi.fn() }) as AgentsActions;
  const screen = (workstreams: WorkstreamView[], runs: Run[] = [], over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <AgentsScreen runs={runs} status="ready" error={null} filters={NO_FILTERS} selectedId={null} earlierOpen={false} introShown={false} stopping={false} opened={new Set()} now={NOW} ticketTitle={() => null} on={actions()} workstreams={workstreams} {...over} />,
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

  it("offers to show the closed ones, from the toolbar, and no way to start a workstream", () => {
    const html = renderToStaticMarkup(<WorkstreamTools showClosed={false} onShowClosed={noop} />);
    expect(html).not.toContain("Start a workstream");
    expect(html).toMatch(/aria-pressed="false"[^>]*>Show closed</);
    expect(renderToStaticMarkup(<WorkstreamTools showClosed onShowClosed={noop} />)).toMatch(/aria-pressed="true"[^>]*>Hide closed</);
  });
});

describe("what needs you, in the Agents list and its detail", () => {
  const actions = (): AgentsActions => ({ select: noop, open: noop, attach: noop, draftComment: noop, buildFromPlan: noop, resume: noop, filter: noop, clearFilters: noop, setGroup: noop, toggleEarlier: noop, setIntro: noop, dismissIntro: noop, retry: noop, fix: noop, retryLaunch: noop, copied: noop, stopAll: noop, askPip: noop, openSafety: noop, openWorkstream: vi.fn() }) as AgentsActions;
  const screen = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <AgentsScreen runs={[]} status="ready" error={null} filters={NO_FILTERS} selectedId={null} earlierOpen={false} introShown={false} stopping={false} opened={new Set()} now={NOW} ticketTitle={() => null} on={actions()} {...over} />,
    );
  afterEach(() => seed(useWorkView, { deciding: null, batch: null }));
  const held = view("ws-1", "CA-401", { pausedReason: "ceiling" });
  const calm = view("ws-2", "CA-402");

  it("marks the workstream that holds a need with a badge and an accent, and leaves the others plain", () => {
    seed(useWorkstreams, { list: [held, calm] });
    const html = screen({ workstreams: [held, calm] });
    expect(html.match(/data-has-needs/g)).toHaveLength(1);
    expect(html).toMatch(/data-workstream-group="ws-1" data-has-needs/);
    expect(html.match(/data-needs-you-badge/g)).toHaveLength(1);
  });

  it("gives No workstream a badge and an Open button when it holds a need, which opens its detail", () => {
    const loose = { id: "r-loose", state: "needsAnswer", spec: { workstream: null, repo: "acme/web", role: "plan", brief: "Plan it." }, queuedAt: "2026-09-30T11:00:00Z", lastProgressAt: "2026-09-30T11:30:00Z", needs: "Which one?" } as unknown as Run;
    seed(useRuns, { runs: [loose] });
    const html = screen({ runs: [loose], needsYou: 1 });
    expect(html).toMatch(/data-workstream-group="none" data-has-needs/);
    expect(html).toMatch(/data-workstream-open="general"[^>]*aria-label="Open No workstream"/);
    expect(html).toMatch(/data-needs-you-badge/);
  });

  it("is the same count on the Needs you chip as the rail badge says, and the chip is a toggle that is on with the filter", () => {
    seed(useWorkstreams, { list: [held, calm] });
    const off = screen({ workstreams: [held, calm], needsYou: 1 });
    expect(off).toMatch(/data-chip="needs" aria-pressed="false"[^>]*>Needs you<span data-chip-count[^>]*>1</);
    expect(off).toMatch(/data-chip="all" aria-pressed="true"/);
    const on = screen({ workstreams: [held, calm], needsYou: 1, filters: { ...NO_FILTERS, needs: true } });
    expect(on).toMatch(/data-chip="needs" aria-pressed="true"/);
    expect(on).toMatch(/data-chip="all" aria-pressed="false"/);
  });

  it("shows the decision at the top of the detail, under Needs you, above the steps", () => {
    seed(useWorkstreams, { list: [held] });
    seed(useWorkView, { deciding: "paused:ws-1" });
    const html = renderToStaticMarkup(<WorkstreamSheet id="ws-1" />);
    const at = (needle: string) => html.indexOf(needle);
    expect(at("data-workstream-needs=")).toBeGreaterThan(-1);
    expect(at("data-workstream-needs=")).toBeLessThan(at("data-step-rail"));
    expect(html).toContain('data-needs-pane="paused:ws-1"');
    expect(at('data-needs-pane="paused:ws-1"')).toBeLessThan(at("data-step-rail"));
  });

  it("opens No workstream's detail, with its needs on top and nothing about a workstream", () => {
    const loose = { id: "r-loose", state: "needsAnswer", spec: { workstream: null, repo: "acme/web", role: "plan", brief: "Plan it." }, queuedAt: "2026-09-30T11:00:00Z", lastProgressAt: "2026-09-30T11:30:00Z", needs: "Which one?" } as unknown as Run;
    seed(useRuns, { runs: [loose] });
    seed(useWorkView, { deciding: "run:r-loose" });
    const html = renderToStaticMarkup(<WorkstreamSheet id="general" />);
    expect(html).toContain('aria-label="No workstream"');
    expect(html).toContain('data-workstream-needs="general"');
    expect(html).not.toContain("data-step-rail");
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

  it("says a paused workstream is paused", () => {
    const paused = view("ws-1", "CA-401", { pausedReason: "person" });
    seed(useWorkstreams, { list: [paused] });
    expect(renderToStaticMarkup(<WorkstreamHeadExtras view={paused} />)).toMatch(/data-status="paused"[^>]*>Paused/);
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
