import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { useClaude } from "../claudeStore";
import type { PauseReason, WatchState, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { useToasts } from "./toasts";
import { DecisionShownContext, decisionShown } from "./decisionShown";
import { CLOSE_HINT, CLOSE_RUNS_NOTE, CloseConfirm, MORE_HINT, NextStepLine, PAUSE_HINT, PausedBanner, StopConfirm, WorkstreamControlsView, controlActions, pauseFocusTarget, tabWithin, type ControlActions } from "./WorkstreamControls";
import { useWorkstreams } from "./workstreamsStore";
import { NO_PULL_VIEW, pullViewOrGithub } from "./StepRail";
import { usePullView } from "./pullViewStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

const sample = await new MockBackend({ runs: { seed: "empty" } }).workstreamsOpen(itemRef("CA-401"));
/** The workstream's view with `over` laid on its workstream. */
const viewOf = (over: Partial<WorkstreamView["workstream"]> = {}): WorkstreamView => ({ workstream: { ...sample, ...over }, stage: "intake", runs: [], labels: [] });
const pausedView = (reason: PauseReason) => viewOf({ pausedReason: reason });
const noop = (): ControlActions => ({ onPause: vi.fn(), onResume: vi.fn(), onStop: vi.fn() });
const render = (view: WorkstreamView, confirmingStop = false) => renderToStaticMarkup(<WorkstreamControlsView view={view} actions={noop()} confirmingStop={confirmingStop} onConfirmStop={vi.fn()} />);

describe("a decision open in the Agents pane", () => {
  const withProvider = (view: WorkstreamView, kind: "paused" | "draft" | null) => {
    const need = kind ? ({ key: `${kind}:x`, kind, workstreamId: view.workstream.id, target: { type: "workstream" } } as never) : null;
    return renderToStaticMarkup(
      <DecisionShownContext.Provider value={decisionShown(need)}>
        <WorkstreamControlsView view={view} actions={noop()} confirmingStop={false} onConfirmStop={vi.fn()} />
      </DecisionShownContext.Provider>,
    );
  };

  it("leaves the paused banner off the rail, since the pane shows it", () => {
    const paused = pausedView("ceiling");
    expect(withProvider(paused, null)).toContain("data-paused-banner");
    expect(withProvider(paused, "paused")).not.toContain("data-paused-banner");
    // Another kind of need open leaves it where it is.
    expect(withProvider(paused, "draft")).toContain("data-paused-banner");
  });

  it("works out what the pane shows: a draft need's draft", () => {
    const view = viewOf();
    const draftNeed = { key: "draft:d1", kind: "draft", workstreamId: view.workstream.id, target: { type: "draft", id: "d1" } } as never;
    expect([...decisionShown(draftNeed).drafts]).toEqual(["d1"]);
    expect(decisionShown(null)).toMatchObject({ need: null });
    expect(decisionShown(undefined).drafts.size).toBe(0);
  });
});

describe("the next-step line", () => {
  it("shows the sentence with data-next-step, and leaves the line out when nothing is given", () => {
    const view = viewOf();
    const withLine = renderToStaticMarkup(<WorkstreamControlsView view={view} actions={noop()} confirmingStop={false} onConfirmStop={vi.fn()} next={{ kind: "running", text: "Next: when R5 (Build) finishes, Pip is woken to decide what comes next.", need: null }} />);
    expect(withLine).toContain('data-next-step="running"');
    expect(withLine).toContain("Next: when R5 (Build) finishes, Pip is woken to decide what comes next.");
    expect(withLine).not.toContain("data-next-step-need");
    expect(render(view)).not.toContain("data-next-step");
  });

  it("is a link to the need while it waits on the person", () => {
    const need = { key: "run:r1" } as never;
    const html = renderToStaticMarkup(<NextStepLine next={{ kind: "waiting", text: "Next: waiting on you. R5 wants to run a command.", need }} />);
    expect(html).toContain('data-next-step="waiting"');
    expect(html).toMatch(/<button[^>]*data-next-step-need="run:r1"[^>]*>Next: waiting on you\. R5 wants to run a command\.<\/button>/);
  });
});

describe("the workstream's controls", () => {
  it("draws Pause, Close… and ⋯ as buttons with a border, not as text (G30)", () => {
    const html = renderToStaticMarkup(<WorkstreamControlsView view={viewOf()} actions={{ ...noop(), onClose: vi.fn() }} confirmingStop={false} onConfirmStop={vi.fn()} confirmingClose={false} onConfirmClose={vi.fn()} />);
    for (const hook of ["data-ws-pause", "data-close-workstream", "data-popover-trigger"]) {
      for (const tag of html.match(new RegExp(`<button[^>]*${hook}[^>]*>`, "g")) ?? []) {
        expect(tag).toContain("border-ws-sep2");
        expect(tag).not.toContain("border-transparent");
      }
    }
    expect(html.match(/<button[^>]*data-popover-trigger[^>]*>/g)).toHaveLength(1);
  });

  it("has no Manage switch, rules or budget lines", () => {
    const html = render(viewOf());
    for (const gone of ["Manage this workstream", "data-mode-line", "data-budget", "Automatic steps", "automatic steps", "role=\"switch\""]) expect(html).not.toContain(gone);
  });

  it("shows Close beside Pause, not only behind the menu, and asks before closing", () => {
    const at = (view: WorkstreamView, closing = false, actions: ControlActions = { ...noop(), onClose: vi.fn() }) =>
      renderToStaticMarkup(<WorkstreamControlsView view={view} actions={actions} confirmingStop={false} onConfirmStop={vi.fn()} confirmingClose={closing} onConfirmClose={vi.fn()} />);
    const idle = at(viewOf());
    expect(idle).toContain("data-close-workstream");
    expect(idle.indexOf(">Pause</button>")).toBeLessThan(idle.indexOf("data-close-workstream"));
    expect(idle).not.toContain('aria-label="Close this workstream"');
    // Paused, there is no Pause, but Close stays.
    expect(at(pausedView("person"))).toContain("data-close-workstream");
    const asking = at(viewOf(), true);
    expect(asking).toContain('aria-label="Close this workstream"');
    expect(asking).toContain("Its conversation goes back to General; its agents and drafts are kept in General.");
    // What Close does to an agent still running or queued is said too (G24).
    expect(asking).toContain(CLOSE_RUNS_NOTE);
    expect(CLOSE_RUNS_NOTE).toBe("Agents already running carry on; one still queued does not start while it is closed.");
    // Where a workstream can't be closed from (no handler), there is no button.
    expect(render(viewOf())).not.toContain("data-close-workstream");
    // Nor where it could ask but has nothing to close with: neither the button nor its question.
    expect(at(viewOf(), false, noop())).not.toContain("data-close-workstream");
    expect(at(viewOf(), true, noop())).not.toContain('aria-label="Close this workstream"');
    expect(renderToStaticMarkup(<CloseConfirm onClose={vi.fn()} onKeep={vi.fn()} />)).toContain("Keep");
  });

  it("describes the Close confirm by its question and detail, and keeps Tab between its two buttons (G13)", () => {
    const html = renderToStaticMarkup(<CloseConfirm onClose={vi.fn()} onKeep={vi.fn()} />);
    const [, q, d] = /aria-describedby="(\S+) (\S+)"/.exec(html)!;
    expect(html).toContain(`<span id="${q}">Close it?</span>`);
    expect(html).toContain(`<span id="${d}">Its conversation goes back to General; its agents and drafts are kept in General. ${CLOSE_RUNS_NOTE}</span>`);
    // Keep, which has the keyboard, is described by them too, so it is read with the question (G34).
    expect(html).toMatch(new RegExp(`<button[^>]*aria-describedby="${q} ${d}"[^>]*>Keep</button>`));
    expect(tabWithin({ key: "Tab", shiftKey: false }, 1, 2)).toBe(0);
    expect(tabWithin({ key: "Tab", shiftKey: false }, 0, 2)).toBe(1);
    expect(tabWithin({ key: "Tab", shiftKey: true }, 0, 2)).toBe(1);
    expect(tabWithin({ key: "Enter", shiftKey: false }, 0, 2)).toBe(-1);
  });

  it("keeps the paused banner out of the live regions, so Pause's toast is the one announcement (G10)", () => {
    const html = render(pausedView("person"));
    expect(html).toMatch(/<div role="group" aria-label="Why this workstream is paused" data-paused-banner=/);
    for (const m of html.matchAll(/<(\w+)[^>]*role="status"[^>]*>(.*?)<\/\1>/g)) expect(m[2]).not.toContain("<button");
    expect(html).toContain("data-ws-resume");
  });

  it("puts the keyboard on Resume after Pause and on Pause after Resume, and on Close when neither is there (G9)", () => {
    const el = (name: string) => ({ name }) as unknown as HTMLElement;
    const root = (found: Record<string, HTMLElement>) => ({ querySelector: (sel: string) => found[sel] ?? null }) as unknown as Pick<ParentNode, "querySelector">;
    const resume = el("resume");
    const pause = el("pause");
    const close = el("close");
    const both = root({ "[data-ws-resume]": resume, "[data-ws-pause]": pause, "[data-close-workstream]": close });
    expect(pauseFocusTarget(both, "pause")).toBe(resume);
    expect(pauseFocusTarget(both, "resume")).toBe(pause);
    expect(pauseFocusTarget(root({ "[data-close-workstream]": close }), "pause")).toBe(close);
    expect(pauseFocusTarget(root({}), "resume")).toBeNull();
  });

  it("offers Pause while not paused, and for either reason a banner in its words with Resume instead", () => {
    const free = render(viewOf());
    expect(free).toContain(">Pause</button>");
    expect(free).not.toContain("data-paused-banner");
    expect(free).not.toContain("Resume");
    for (const reason of ["person", "ceiling"] as const) {
      const html = render(pausedView(reason));
      expect(html).toContain(`data-paused-banner="${reason}"`);
      expect(html).toContain("Pip isn&#x27;t woken until you resume it.");
      expect(html).toContain(">Resume</button>");
      expect(html).not.toContain(">Pause</button>");
    }
    expect(render(pausedView("ceiling"))).toContain("Paused: Pip was woken too often today");
    expect(renderToStaticMarkup(<PausedBanner view={viewOf()} actions={{ onResume: vi.fn() }} />)).toBe("");
  });

  it("gives Pause, Close… and the ⋯ menu a short hint, as a title and a description (G24)", () => {
    const html = render(viewOf({}), false);
    const withClose = renderToStaticMarkup(<WorkstreamControlsView view={viewOf({})} actions={{ ...noop(), onClose: vi.fn() }} confirmingStop={false} onConfirmStop={vi.fn()} onConfirmClose={vi.fn()} />);
    for (const hint of [PAUSE_HINT, MORE_HINT]) {
      const escaped = hint.replace(/'/g, "&#x27;");
      expect(html).toContain(`title="${escaped}" aria-description="${escaped}"`);
    }
    expect(withClose).toContain(`title="${CLOSE_HINT}" aria-description="${CLOSE_HINT}"`);
    expect(PAUSE_HINT).toBe("Pip isn't woken; its agents carry on");
  });

  it("asks before Stop, which sits behind a menu so the pane's own Stop stays the one button of that name", () => {
    expect(render(viewOf())).not.toMatch(/>(Yes, )?[Ss]top<\/button>/);
    expect(render(viewOf())).toContain('aria-label="More for this workstream"');
    expect(render(viewOf(), true)).toContain('aria-label="Stop this workstream"');
    const confirm = renderToStaticMarkup(<StopConfirm onStop={vi.fn()} onKeep={vi.fn()} />);
    expect(confirm).toContain(">Yes, stop</button>");
    expect(confirm).toContain(">Keep going</button>");
  });
});

describe("the controls call the person's own commands", () => {
  let backend: MockBackend;
  let id: string;

  beforeEach(async () => {
    vi.stubGlobal("localStorage", memory());
    backend = new MockBackend({ runs: { seed: "empty" } });
    await useWorkspace.getState().init(backend);
    useWorkstreams.getState().init(backend);
    id = (await backend.workstreamsOpen(itemRef("CA-401"))).id;
  });

  afterEach(() => {
    useWorkstreams.getState().dispose();
    useClaude.setState({ byTicket: {} });
    vi.unstubAllGlobals();
  });

  it("Pause, Resume and Stop each call their backend method, and the list follows", async () => {
    const calls = {
      pause: vi.spyOn(backend, "workstreamsPause"),
      resume: vi.spyOn(backend, "workstreamsResume"),
      stop: vi.spyOn(backend, "workstreamsStop"),
    };
    const a = controlActions(id);
    const shown = () => useWorkstreams.getState().list.find((v) => v.workstream.id === id)?.workstream;

    void a.onPause();
    await vi.waitFor(() => expect(shown()?.pausedReason).toBe("person"));
    expect(calls.pause).toHaveBeenCalledWith(id);
    void a.onResume();
    await vi.waitFor(() => expect(shown()?.pausedReason).toBeNull());
    expect(calls.resume).toHaveBeenCalledWith(id);
    a.onStop();
    await vi.waitFor(() => expect(calls.stop).toHaveBeenCalledWith(id));
    await vi.waitFor(() => expect(shown()?.pausedReason).toBe("person"));
    expect(Object.values(calls).every((c) => c.mock.calls.every(([first]) => first === id))).toBe(true);
  });
});

describe("the Review step's PR view with no GitHub connection (D17)", () => {
  const openUrl = vi.fn(() => Promise.resolve());
  const watching = (connectionId: string): WatchState => ({ connectionId, mode: "selected", needsChoice: false, catalogSize: null, watches: [] });
  beforeEach(() => {
    openUrl.mockClear();
    useToasts.getState().clear();
    useWorkspace.setState({ backend: { openUrl } as never, proposals: {}, watch: [] });
  });
  afterEach(() => {
    useToasts.getState().clear();
    usePullView.setState({ target: null, opener: null });
    useWorkspace.setState({ backend: null, watch: [] });
  });

  it("says so in a note and opens the pull request on GitHub, rather than doing nothing", () => {
    pullViewOrGithub("acme/storefront", 519);
    expect(usePullView.getState().target).toBeNull();
    expect(useToasts.getState().toasts.map((t) => [t.text, t.tone])).toEqual([[NO_PULL_VIEW, "info"]]);
    expect(NO_PULL_VIEW).toBe("Connect GitHub to see this pull request in Gossamr. Opened it on GitHub instead.");
    expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/storefront/pull/519");
  });

  it("with a code host watched, opens the in-app view and nothing else", () => {
    useWorkspace.setState({ watch: [watching("github:ada")] });
    pullViewOrGithub("acme/storefront", 519);
    expect(usePullView.getState().target).toEqual({ connectionId: "github:ada", repo: "acme/storefront", number: 519, proposalId: null });
    expect(useToasts.getState().toasts).toEqual([]);
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe("focus after Close workstream (G5)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("goes to the Agents heading once the close went through, and not when it failed", async () => {
    const row = { focus: vi.fn() };
    const body = {};
    vi.stubGlobal("document", { body, activeElement: body, querySelector: (sel: string) => (sel === "[data-agents-home] h1" ? row : null) });
    vi.stubGlobal("requestAnimationFrame", (run: () => void) => void run());
    const close = vi.spyOn(useWorkstreams.getState(), "close");
    close.mockResolvedValueOnce(false);
    controlActions("w1").onClose?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(row.focus).not.toHaveBeenCalled();
    close.mockResolvedValueOnce(true);
    controlActions("w1").onClose?.();
    await vi.waitFor(() => expect(row.focus).toHaveBeenCalledTimes(1));
    close.mockRestore();
  });
});

describe("the offer to bring a ticket's runs and drafts here (G17)", () => {
  it("says what sits under General in one line with a button, and shows nothing without them or when closed", () => {
    const offered = { ...viewOf(), adoptable: { runs: ["r1", "r2"], drafts: ["d1"] } };
    const html = render(offered);
    expect(html).toContain("data-adopt-notice=");
    expect(html).toContain("2 runs and 1 draft on CA-401 are under General.");
    expect(html).toMatch(/<button[^>]*data-adopt[^>]*>Bring them here<\/button>/);
    expect(render({ ...viewOf(), adoptable: { runs: ["r1"], drafts: [] } })).toContain("1 run on CA-401 is under General.");
    expect(render(viewOf())).not.toContain("data-adopt-notice");
    expect(render({ ...viewOf(), adoptable: { runs: [], drafts: [] } })).not.toContain("data-adopt-notice");
  });
});
