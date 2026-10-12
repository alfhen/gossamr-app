import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { useClaude } from "../claudeStore";
import { workstreamConversation } from "../lib/conversations";
import { TURN_HELP, budgetView, heldText } from "../lib/workstreamHold";
import { AUTOSTART_DEFAULTS, HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_PERSON, HELD_QUOTA, HELD_RESTART, TRIPWIRE, TRIPWIRES, WORKSTREAM_RULES, type WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { HOLD_ALL_HINT, buildCommands, isHoldAllKey, rankCommands, type CommandActions } from "./commands";
import { useToasts } from "./toasts";
import { AutomaticStepsPanel, StopConfirm, WorkstreamControlsView, choiceValue, controlActions, ruleChoice, type ControlActions } from "./WorkstreamControls";
import { holdAllVisible, useWorkstreams } from "./workstreamsStore";
import { EscalationCardView, EscalationSent, FIX_ROUND_HELP, NO_REVIEW_DRAFT, POST_AS_IS_HELP, TAKE_OVER_HELP, TAKEN_OVER, escalationActions, escalationShown, fixRoundSent } from "./EscalationCard";
import { ESCALATION_GONE } from "../backend/mockWorkstreams";
import type { Escalation } from "../types";
import type { WatchState } from "../types";
import type { StepChip } from "./pipHomeLogic";
import { NO_PULL_VIEW, autoNote, pullViewOrGithub } from "./StepRail";
import { usePullView } from "./pullViewStore";

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
      const view = viewOf({ heldReason: reason });
      const html = render(view);
      expect(html).toContain(`data-held-banner="${reason}"`);
      expect(html).toContain(heldText(reason, null, view.budget)!.replace(/'/g, "&#x27;"));
      expect(html).toContain(">Resume</button>");
      expect(html).not.toContain(">Hold</button>");
    }
    expect(render(viewOf({ heldReason: HELD_BUDGET }))).toContain("Held: automatic turns used up. Resume, or write to Pip, to give it 11 more");
    expect(render(viewOf({ heldReason: HELD_RESTART }))).toContain("Held after a restart");
  });

  it("says nothing of a budget with plenty left, warns in amber from 80% and says when it is spent", () => {
    expect(render(viewOf({ spent: { autoTurns: 7, wakes: 7, tokens: 0 } }))).not.toContain("data-budget");
    const amber = render(viewOf({ spent: { autoTurns: 9, wakes: 9, tokens: 0 } }));
    expect(amber).toContain('data-budget="amber"');
    expect(amber).toContain("9 of 11 automatic turns used");
    expect(render(viewOf({ spent: { autoTurns: 1, wakes: 10, tokens: 0 } }))).toContain("10 of 12 wakes used");
    // A workstream's own limit counts, and its banner says what to do once spent; the line isn't said twice.
    const own = viewOf({ budget: { autoTurns: 2, wakes: null, tokens: null }, spent: { autoTurns: 2, wakes: 2, tokens: 0 }, heldReason: HELD_BUDGET });
    expect(own.budget.level).toBe("spent");
    expect(render(own)).not.toContain("data-budget");
    expect(render(own)).toContain("Held: automatic turns used up. Resume, or write to Pip, to give it 2 more");
    expect(render(own)).toContain("data-turn-help");
    // Held because the wakes ran out: a message to Pip would not lift it, so only Resume is offered.
    const wakes = render(viewOf({ spent: { autoTurns: 1, wakes: 12, tokens: 0 }, heldReason: HELD_BUDGET }));
    expect(wakes).toContain("Held: wakes used up. Resume to give it 12 more");
    expect(wakes).not.toContain("write to Pip");
    // Spent, but held for something else: the line says so.
    expect(render({ ...own, workstream: { ...own.workstream, heldReason: HELD_PERSON } })).toContain('data-budget="spent"');
  });

  it("shows the automatic steps left up front in Manage, from the default of 11 or the workstream's own limit", () => {
    const fresh = render(viewOf({ mode: "manage" }));
    expect(fresh).toContain("11 of 11 automatic steps left");
    expect(fresh).toContain('data-steps-left="11"');
    expect(render(viewOf({ mode: "manage", spent: { autoTurns: 4, wakes: 4, tokens: 0 } }))).toContain("7 of 11 automatic steps left");
    expect(render(viewOf({ mode: "manage", budget: { autoTurns: 6, wakes: null, tokens: null }, spent: { autoTurns: 1, wakes: 1, tokens: 0 } }))).toContain("5 of 6 automatic steps left");
    expect(render(viewOf({ mode: "manage", spent: { autoTurns: 11, wakes: 11, tokens: 0 }, heldReason: HELD_BUDGET }))).toContain("0 of 11 automatic steps left");
    // Advise runs no automatic steps, so there is nothing to count.
    expect(render(viewOf({ mode: "advise" }))).not.toContain("automatic steps left");
  });

  it("defines an automatic turn wherever the budget is shown", () => {
    const amber = render(viewOf({ spent: { autoTurns: 9, wakes: 9, tokens: 0 } }));
    const help = TURN_HELP.replace(/'/g, "&#x27;");
    expect(amber).toMatch(new RegExp(`data-budget="amber" title="${help}"`));
    expect(amber).toContain("<summary");
    expect(amber).toContain(help);
    expect(render(viewOf())).not.toContain("data-turn-help");
  });

  it("says for a tripwire that took Manage away that automatic steps are paused and Resume turns them back on, and marks Manage paused", () => {
    const paused = render(viewOf({ heldReason: `${TRIPWIRE}basis_drift`, drifted: ["description"], resumeMode: "manage", mode: "advise" }));
    expect(paused).toContain("Held: the ticket&#x27;s description changed in Jira. Automatic steps are paused. Resume turns them back on.");
    expect(paused).toContain("data-manage-paused");
    expect(paused).toMatch(/role="switch" aria-checked="false"/);
    // A screen reader hears that Manage is paused, not only that it is off.
    const described = /aria-describedby="([^"]+)"/.exec(paused)![1];
    expect(paused).toMatch(new RegExp(`id="${described}" data-manage-paused[^>]*>paused<span class="sr-only"> until Resume</span>`));
    // Manage switched back on during the hold: Resume starts the automatic steps again, so the banner can't say it stays off.
    const switchedOn = render(viewOf({ heldReason: `${TRIPWIRE}basis_drift`, drifted: ["description"], resumeMode: null, mode: "manage" }));
    expect(switchedOn).toContain("Automatic steps are paused. Resume turns them back on.");
    expect(switchedOn).not.toContain("Manage stays off");
    const advised = render(viewOf({ heldReason: `${TRIPWIRE}marker`, mode: "advise" }));
    expect(advised).toContain("Resume only lifts the hold; Manage stays off.");
    expect(advised).not.toContain("data-manage-paused");
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

describe("a review that still blocks after the fix rounds", () => {
  const escalation: Escalation = { reviewRun: "r-rev", buildRun: "r-b", reviewLabel: "R5", buildLabel: "R4", rounds: 2, reviewDraft: "p-review", at: "2026-10-01T10:00:00Z" };
  const card = (e: Escalation = escalation, busy = false) => renderToStaticMarkup(<EscalationCardView escalation={e} busy={busy} onFixRound={vi.fn()} onTakeOver={vi.fn()} onPost={vi.fn()} />);
  const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map(([, attrs, text]) => ({ text: text.replace(/&#x27;/g, "'"), disabled: /\bdisabled=""/.test(attrs), title: /title="([^"]*)"/.exec(attrs)?.[1]?.replace(/&#x27;/g, "'") ?? null }));

  it("asks what next and offers the person's three choices, in order, each saying what it does", () => {
    const html = card();
    expect(html).toContain('role="group" aria-label="Review still blocks"');
    expect(html).toContain("R5 still blocks after 2 fix rounds. What next?");
    expect(buttons(html).map((b) => [b.text, b.disabled])).toEqual([
      ["Run another fix round", false],
      ["I'll take it from here", false],
      ["Post the review as is", false],
    ]);
    for (const help of [FIX_ROUND_HELP, TAKE_OVER_HELP, POST_AS_IS_HELP]) expect(html).toContain(help.replace(/'/g, "&#x27;"));
    // Every button says what it does to a screen reader too.
    expect(html.match(/aria-describedby="escalation-r-rev-\d"/g)).toHaveLength(3);
  });

  it("can't post a review that has no draft waiting, and waits while a choice is on its way", () => {
    expect(buttons(card({ ...escalation, reviewDraft: null }))[2]).toEqual({ text: "Post the review as is", disabled: true, title: NO_REVIEW_DRAFT });
    expect(buttons(card(escalation, true)).every((b) => b.disabled)).toBe(true);
  });

  it("confirms the choice in a status line that can take the keyboard", () => {
    const html = renderToStaticMarkup(<EscalationSent text={fixRoundSent("R4")} />);
    expect(html).toMatch(/<p[^>]*tabindex="-1"[^>]*role="status"[^>]*data-escalation-sent=/);
    expect(html).toContain("Fix round sent to R4.");
    expect(TAKEN_OVER).toBe("Over to you: this workstream is on Advise now.");
  });

  it("says Over to you only while it is true, and a newer escalation brings the card back", () => {
    const took = { review: "r-rev", text: TAKEN_OVER, tookOver: true };
    const sent = { review: "r-rev", text: fixRoundSent("R4"), tookOver: false };
    expect(escalationShown(escalation, null, "manage")).toBe("card");
    expect(escalationShown(null, took, "advise")).toBe("sent");
    // Manage on again after taking it over: no false "on Advise now", and the same review's card doesn't come back.
    expect(escalationShown(null, took, "manage")).toBeNull();
    // Were it offered again, the card shows rather than the old confirmation.
    expect(escalationShown(escalation, took, "manage")).toBe("card");
    expect(escalationShown(null, sent, "manage")).toBe("sent");
    expect(escalationShown(escalation, sent, "manage")).toBe("sent");
    expect(escalationShown({ ...escalation, reviewRun: "r-newer" }, sent, "manage")).toBe("card");
  });

  it("shows under the workstream's controls only while there is one", () => {
    const view = viewOf({ mode: "manage" });
    expect(render(view)).not.toContain("data-escalation");
    expect(render({ ...view, escalation })).toContain('data-escalation="r-rev"');
  });

  it("each choice calls only the person's own command, and a refusal is said in a toast", async () => {
    vi.stubGlobal("localStorage", memory());
    const backend = new MockBackend({ runs: { seed: "empty" } });
    await useWorkspace.getState().init(backend);
    useWorkstreams.getState().init(backend);
    const id = (await backend.workstreamsOpen(itemRef("CA-401"))).id;
    const calls = { fix: vi.spyOn(backend, "workstreamsFixRound"), take: vi.spyOn(backend, "workstreamsTakeOver"), mode: vi.spyOn(backend, "workstreamsSetMode") };
    const pushed = vi.spyOn(useToasts.getState(), "push");
    const a = escalationActions(id, escalation);
    expect(await a.onFixRound()).toBe(false);
    expect(await a.onTakeOver()).toBe(false);
    expect(calls.fix.mock.calls).toEqual([["r-rev"]]);
    expect(calls.take.mock.calls).toEqual([[id, "r-rev"]]);
    expect(calls.mode).not.toHaveBeenCalled();
    expect(pushed.mock.calls.map(([text]) => text)).toEqual([`Couldn't send another fix round. ${ESCALATION_GONE}`, `Couldn't take the workstream over. ${ESCALATION_GONE}`]);
    useWorkstreams.getState().dispose();
    vi.unstubAllGlobals();
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
    // With an Undo that frees both again.
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/^Held 2 workstreams\./), "info", expect.objectContaining({ label: "Undo" }), expect.objectContaining({ keep: true }));
    const held = useWorkstreams.getState().list.filter((v) => [id, other].includes(v.workstream.id)).map((v) => v.workstream.heldReason);
    expect(held).toEqual([HELD_ALL, HELD_ALL]);
    expect(await useWorkstreams.getState().holdAll()).toBe(0);
    expect(push).toHaveBeenLastCalledWith("Every open workstream is held already.", "info");
    await useWorkstreams.getState().resume(other);
    expect(await useWorkstreams.getState().holdAll()).toBe(1);
    expect(push).toHaveBeenLastCalledWith(expect.stringMatching(/^Held 1 workstream\. Its agents carry on/), "info", expect.objectContaining({ label: "Undo" }), expect.objectContaining({ keep: true }));
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
    const on = buildCommands([], [], actions, { project: null, view: null, unreadActivity: 0, agents: true });
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

describe("a step a rule started, while the workstream is held or in Advise", () => {
  it("says a queued run waits for Resume while held and for Manage while in Advise, and how a started one started", () => {
    const chip = (state: "queued" | "working") => ({ auto: true, newest: { state } }) as StepChip;
    expect(autoNote(chip("queued"), { heldReason: "tripwire:basis_drift", mode: "advise" })).toBe("waits for Resume");
    expect(autoNote(chip("queued"), { heldReason: null, mode: "advise" })).toBe("waits for Manage");
    expect(autoNote(chip("queued"), { heldReason: null, mode: "manage" })).toBe("started automatically");
    // A run that already started says how it started, held or not.
    expect(autoNote(chip("working"), { heldReason: "person", mode: "advise" })).toBe("started automatically");
    expect(autoNote({ ...chip("queued"), auto: false }, { heldReason: "person", mode: "advise" })).toBeNull();
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
