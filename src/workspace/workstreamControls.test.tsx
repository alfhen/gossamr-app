import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { useClaude } from "../claudeStore";
import { workstreamConversation } from "../lib/conversations";
import { budgetView, heldText } from "../lib/workstreamHold";
import { AUTOSTART_DEFAULTS, HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_PERSON, HELD_QUOTA, HELD_RESTART, TRIPWIRE, TRIPWIRES, WORKSTREAM_RULES, type WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { HOLD_ALL_HINT, buildCommands, isHoldAllKey, rankCommands, type CommandActions } from "./commands";
import { useToasts } from "./toasts";
import { AutomaticStepsPanel, StopConfirm, WorkstreamControlsView, choiceValue, controlActions, ruleChoice, type ControlActions } from "./WorkstreamControls";
import { holdAllVisible, useWorkstreams } from "./workstreamsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

const sample = await new MockBackend({ runs: { seed: "empty" } }).workstreamsOpen(itemRef("CA-401"));
/** The workstream's view with `over` laid on its workstream, and its budget worked out from what it then has. */
const viewOf = (over: Partial<WorkstreamView["workstream"]> = {}): WorkstreamView => {
  const workstream = { ...sample, ...over };
  return { workstream, stage: "intake", runs: [], labels: [], budget: budgetView(workstream) };
};
const noop = (): ControlActions => ({ onManage: vi.fn(), onHold: vi.fn(), onResume: vi.fn(), onStop: vi.fn(), onRule: vi.fn() });
const render = (view: WorkstreamView, confirmingStop = false) =>
  renderToStaticMarkup(<WorkstreamControlsView view={view} globals={AUTOSTART_DEFAULTS} actions={noop()} confirmingStop={confirmingStop} onConfirmStop={vi.fn()} />);

describe("the workstream's controls", () => {
  it("shows the Manage switch as the workstream's mode", () => {
    expect(render(viewOf({ mode: "advise" }))).toMatch(/role="switch" aria-checked="false"[^>]*aria-label="Manage this workstream"/);
    expect(render(viewOf({ mode: "manage" }))).toMatch(/role="switch" aria-checked="true"[^>]*aria-label="Manage this workstream"/);
  });

  it("offers Hold while not held, and for every held reason a banner in its words with Resume instead", () => {
    const free = render(viewOf());
    expect(free).toContain(">Hold</button>");
    expect(free).not.toContain("data-held-banner");
    expect(free).not.toContain("Resume");
    const reasons = [HELD_RESTART, HELD_PERSON, HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_QUOTA, ...TRIPWIRES.map((t) => `${TRIPWIRE}${t}`)];
    for (const reason of reasons) {
      const html = render(viewOf({ heldReason: reason }));
      expect(html).toContain(`data-held-banner="${reason}"`);
      expect(html).toContain(heldText(reason)!.replace(/'/g, "&#x27;"));
      expect(html).toContain(">Resume</button>");
      expect(html).not.toContain(">Hold</button>");
    }
    expect(render(viewOf({ heldReason: HELD_BUDGET }))).toContain("Budget used up. Say carry on to continue");
    expect(render(viewOf({ heldReason: HELD_RESTART }))).toContain("Held after a restart");
  });

  it("says nothing of a budget with plenty left, warns in amber from 80% and says when it is spent", () => {
    expect(render(viewOf({ spent: { autoTurns: 4, wakes: 4, tokens: 0 } }))).not.toContain("data-budget");
    const amber = render(viewOf({ spent: { autoTurns: 5, wakes: 5, tokens: 0 } }));
    expect(amber).toContain('data-budget="amber"');
    expect(amber).toContain("5 of 6 automatic turns used");
    expect(render(viewOf({ spent: { autoTurns: 1, wakes: 10, tokens: 0 } }))).toContain("10 of 12 wakes used");
    // A workstream's own limit counts, and its banner says what to do once spent; the line isn't said twice.
    const own = viewOf({ budget: { autoTurns: 2, wakes: null, tokens: null }, spent: { autoTurns: 2, wakes: 2, tokens: 0 }, heldReason: HELD_BUDGET });
    expect(own.budget.level).toBe("spent");
    expect(render(own)).not.toContain("data-budget");
    expect(render(own)).toContain("Budget used up. Say carry on to continue");
    // Spent, but held for something else: the line says so.
    expect(render({ ...own, workstream: { ...own.workstream, heldReason: HELD_PERSON } })).toContain('data-budget="spent"');
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

describe("the automatic steps", () => {
  it("reads each rule's tri-state: the workstream's own switch, or as in Settings", () => {
    expect(ruleChoice({ triage_plan: false, fix_round: true }, "triage_plan")).toBe("off");
    expect(ruleChoice({ triage_plan: false, fix_round: true }, "fix_round")).toBe("on");
    expect(ruleChoice({ triage_plan: false }, "plan_build")).toBe("inherit");
    expect([choiceValue("on"), choiceValue("off"), choiceValue("inherit")]).toEqual([true, false, null]);
  });

  it("lists the six rules, each with on, off and as in Settings, saying what Settings has", () => {
    const html = renderToStaticMarkup(<AutomaticStepsPanel rules={{ triage_plan: false, review_verify: true }} globals={AUTOSTART_DEFAULTS} onRule={vi.fn()} />);
    expect([...html.matchAll(/data-rule="([a-z_]+)" data-choice="([a-z]+)"/g)].map(([, rule, choice]) => [rule, choice])).toEqual([
      ["investigate_triage", "inherit"],
      ["triage_plan", "off"],
      ["plan_build", "inherit"],
      ["build_review", "inherit"],
      ["fix_round", "inherit"],
      ["review_verify", "on"],
    ]);
    expect(html.match(/role="radiogroup"/g)).toHaveLength(WORKSTREAM_RULES.length);
    expect(html).toContain('aria-label="Triage → Plan"');
    expect(html).toContain('role="radio" aria-checked="true"');
    // Verify is off in Settings by default; the rest are on.
    expect(html.match(/As in Settings \(on\)/g)).toHaveLength(5);
    expect(html.match(/As in Settings \(off\)/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<AutomaticStepsPanel rules={{}} globals={null} onRule={vi.fn()} />)).not.toContain("As in Settings (");
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

  it("Manage, Hold, Resume, Stop and a rule each call their backend method, and the list follows", async () => {
    const calls = {
      mode: vi.spyOn(backend, "workstreamsSetMode"),
      hold: vi.spyOn(backend, "workstreamsHold"),
      resume: vi.spyOn(backend, "workstreamsResume"),
      stop: vi.spyOn(backend, "workstreamsStop"),
      rule: vi.spyOn(backend, "workstreamsSetRule"),
    };
    const a = controlActions(id);
    const shown = () => useWorkstreams.getState().list.find((v) => v.workstream.id === id)?.workstream;

    a.onManage(true);
    await vi.waitFor(() => expect(shown()?.mode).toBe("manage"));
    expect(calls.mode).toHaveBeenCalledWith(id, "manage");
    a.onHold();
    await vi.waitFor(() => expect(shown()?.heldReason).toBe(HELD_PERSON));
    expect(calls.hold).toHaveBeenCalledWith(id);
    a.onResume();
    await vi.waitFor(() => expect(shown()?.heldReason).toBeNull());
    expect(calls.resume).toHaveBeenCalledWith(id);
    a.onRule("triage_plan", false);
    await vi.waitFor(() => expect(shown()?.rules).toEqual({ triage_plan: false }));
    a.onRule("triage_plan", null);
    await vi.waitFor(() => expect(shown()?.rules).toEqual({}));
    expect(calls.rule.mock.calls).toEqual([
      [id, "triage_plan", false],
      [id, "triage_plan", null],
    ]);
    a.onManage(false);
    await vi.waitFor(() => expect(shown()?.mode).toBe("advise"));
    a.onStop();
    await vi.waitFor(() => expect(calls.stop).toHaveBeenCalledWith(id));
    await vi.waitFor(() => expect(shown()?.heldReason).toBe(HELD_PERSON));
    expect(Object.values(calls).every((c) => c.mock.calls.every(([first]) => first === id))).toBe(true);
  });

  it("reads what Settings has when the steps are opened", async () => {
    expect(useWorkstreams.getState().globals).toBeNull();
    controlActions(id).onSteps?.();
    await vi.waitFor(() => expect(useWorkstreams.getState().globals).toEqual(AUTOSTART_DEFAULTS));
  });

  it("Hold all holds every open workstream and says how many", async () => {
    const other = (await backend.workstreamsOpen(itemRef("CA-402"))).id;
    const push = vi.spyOn(useToasts.getState(), "push");
    expect(await useWorkstreams.getState().holdAll()).toBe(2);
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/^Held 2 workstreams\./), "info");
    const held = useWorkstreams.getState().list.filter((v) => [id, other].includes(v.workstream.id)).map((v) => v.workstream.heldReason);
    expect(held).toEqual([HELD_ALL, HELD_ALL]);
    expect(await useWorkstreams.getState().holdAll()).toBe(0);
    expect(push).toHaveBeenLastCalledWith("Every open workstream is held already.", "info");
    await useWorkstreams.getState().resume(other);
    expect(await useWorkstreams.getState().holdAll()).toBe(1);
    expect(push).toHaveBeenLastCalledWith(expect.stringMatching(/^Held 1 workstream\. Its agents carry on/), "info");
  });
});

describe("Hold all", () => {
  const conv = (status: string) => ({ turns: [{ status }] });

  it("shows while a workstream is managed and not held, or Pip answers in a workstream's conversation", () => {
    expect(holdAllVisible([], {})).toBe(false);
    expect(holdAllVisible([viewOf({ mode: "advise" })], {})).toBe(false);
    expect(holdAllVisible([viewOf({ mode: "manage" })], {})).toBe(true);
    expect(holdAllVisible([viewOf({ mode: "manage", heldReason: HELD_PERSON })], {})).toBe(false);
    expect(holdAllVisible([viewOf({ mode: "manage", closedAt: "2026-10-01T00:00:00Z" })], {})).toBe(false);
    expect(holdAllVisible([], { [workstreamConversation("ws-1")]: conv("running") })).toBe(true);
    expect(holdAllVisible([], { [workstreamConversation("ws-1")]: conv("done") })).toBe(false);
    // Pip answering in General is nothing a hold stops.
    expect(holdAllVisible([], { general: conv("running") })).toBe(false);
  });

  it("is Cmd/Ctrl+Shift+Period, and only that", () => {
    const key = (over: Partial<KeyboardEvent>) => ({ key: ">", code: "Period", metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, ...over });
    expect(isHoldAllKey(key({ metaKey: true }))).toBe(true);
    expect(isHoldAllKey(key({ ctrlKey: true }))).toBe(true);
    expect(isHoldAllKey(key({ ctrlKey: true, code: "", key: "." }))).toBe(true);
    expect(isHoldAllKey(key({}))).toBe(false);
    expect(isHoldAllKey(key({ metaKey: true, shiftKey: false, key: "." }))).toBe(false);
    expect(isHoldAllKey(key({ metaKey: true, altKey: true }))).toBe(false);
    expect(isHoldAllKey(key({ metaKey: true, code: "KeyK", key: "K" }))).toBe(false);
    // Cmd+J, Cmd+K and the rest keep theirs.
    for (const k of ["j", "k"]) expect(isHoldAllKey({ key: k, code: `Key${k.toUpperCase()}`, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(false);
  });

  it("is a palette command with its shortcut beside it, while agents are on", () => {
    const actions = new Proxy({}, { get: (t: Record<string, unknown>, k: string) => (t[k] ??= vi.fn()) }) as unknown as CommandActions;
    const on = buildCommands([], [], actions, { project: null, view: null, unreadActivity: 0, pendingDrafts: 0, agents: true });
    const hold = rankCommands(on, "hold all")[0];
    expect(hold).toMatchObject({ id: "workstream:hold-all", label: "Hold all workstreams", hint: HOLD_ALL_HINT });
    expect(HOLD_ALL_HINT).toBe("⌘⇧.");
    hold.run();
    expect(actions.holdAllWorkstreams).toHaveBeenCalled();
    // No other command shows the same shortcut.
    expect(on.filter((c) => c.hint === HOLD_ALL_HINT)).toHaveLength(1);
    expect(buildCommands([], [], actions).some((c) => c.id === "workstream:hold-all")).toBe(false);
  });
});
