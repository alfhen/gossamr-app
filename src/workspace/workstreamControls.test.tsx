import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { useClaude } from "../claudeStore";
import { workstreamConversation } from "../lib/conversations";
import { STEP_HELP, budgetView, heldText } from "../lib/workstreamHold";
import { AUTOSTART_DEFAULTS, HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_PERSON, HELD_QUOTA, HELD_RESTART, TRIPWIRE, TRIPWIRES, WORKSTREAM_RULES, type WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import type { Run } from "../types";
import { HOLD_ALL_HINT, buildCommands, isHoldAllKey, rankCommands, type CommandActions } from "./commands";
import { useToasts } from "./toasts";
import { DecisionShownContext, decisionShown } from "./decisionShown";
import { MODE_LINE, NextStepLine, nextStepOnceKnown } from "./WorkstreamControls";
import { AUTO_STEPS_HELP, AutomaticStepsPanel, CloseConfirm, StopConfirm, WorkstreamControlsView, choiceValue, controlActions, ruleChoice, type ControlActions } from "./WorkstreamControls";
import { holdAllVisible, useWorkstreams } from "./workstreamsStore";
import { CONNECT_TO_POST, DRAFT_OPEN, EscalationCardView, EscalationSent, FIX_ROUND_HELP, NO_REVIEW_DRAFT, POST_AS_IS_HELP, TAKE_OVER_HELP, TAKEN_OVER, draftOpen, escalationActions, escalationShown, fixRoundSent, postingReview } from "./EscalationCard";
import { ESCALATION_GONE } from "../backend/mockWorkstreams";
import type { Escalation, Proposal } from "../types";
import type { WatchState } from "../types";
import type { StepChip } from "./pipHomeLogic";
import { NO_PULL_VIEW, autoNote, pullViewOrGithub } from "./StepRail";
import { usePullView } from "./pullViewStore";
import { EscalationBody } from "./NeedsPane";

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
const noop = (): ControlActions => ({ onManage: vi.fn(), onHold: vi.fn(), onResume: vi.fn(), onAllowMore: vi.fn(), onStop: vi.fn(), onRule: vi.fn() });
const render = (view: WorkstreamView, confirmingStop = false) =>
  renderToStaticMarkup(<WorkstreamControlsView view={view} globals={AUTOSTART_DEFAULTS} actions={noop()} confirmingStop={confirmingStop} onConfirmStop={vi.fn()} />);

describe("the line under the mode switch", () => {
  it("says what Manage does, and changes to what Advise does", () => {
    const manage = render(viewOf({ mode: "manage" }));
    expect(manage).toContain('data-mode-line="manage"');
    expect(manage).toContain("Pip manages: it starts the next step by itself and drafts what&#x27;s next; nothing reaches Jira without you.");
    const advise = render(viewOf({ mode: "advise" }));
    expect(advise).toContain('data-mode-line="advise"');
    expect(advise).toContain("Pip advises: it answers when asked and starts nothing by itself.");
    expect(advise).not.toContain("Pip manages");
    expect(MODE_LINE.manage).toMatch(/^Pip manages: /);
  });

  it("sits directly under the switch's row, ahead of the held banner and the next step", () => {
    const html = render(viewOf({ mode: "manage", heldReason: HELD_PERSON }));
    const at = (s: string) => html.indexOf(s);
    expect(at("Manage this workstream")).toBeGreaterThan(-1);
    expect(at("data-mode-line")).toBeGreaterThan(at("Manage this workstream"));
    expect(at("data-mode-line")).toBeLessThan(at("data-held-banner"));
  });
});

describe("a decision open in Pip home's pane", () => {
  const escalation: Escalation = { reviewRun: "r-rev", buildRun: "r-b", reviewLabel: "R5", buildLabel: "R4", rounds: 2, reviewDraft: "p-review", at: "2026-10-01T10:00:00Z" };
  const withProvider = (view: WorkstreamView, kind: "hold" | "escalation" | null) => {
    const need = kind ? ({ key: `${kind}:x`, kind, workstreamId: view.workstream.id, target: { type: "workstream" } } as never) : null;
    return renderToStaticMarkup(
      <DecisionShownContext.Provider value={decisionShown(need, [view])}>
        <WorkstreamControlsView view={view} globals={AUTOSTART_DEFAULTS} actions={noop()} confirmingStop={false} onConfirmStop={vi.fn()} />
      </DecisionShownContext.Provider>,
    );
  };

  it("leaves the held banner off the rail, since the pane shows it", () => {
    const held = viewOf({ mode: "manage", heldReason: HELD_RESTART });
    expect(withProvider(held, null)).toContain("data-held-banner");
    expect(withProvider(held, "hold")).not.toContain("data-held-banner");
    // Another kind of need open leaves it where it is.
    expect(withProvider(held, "escalation")).toContain("data-held-banner");
  });

  it("leaves the escalation card off the rail, since the pane shows it, and keeps every other line", () => {
    const view = { ...viewOf({ mode: "manage" }), escalation };
    expect(withProvider(view, null)).toContain("data-escalation");
    const decided = withProvider(view, "escalation");
    expect(decided).not.toContain("data-escalation");
    expect(decided).toContain("data-mode-line");
  });

  it("works out what the pane shows: a draft need's draft, and the review draft folded into an escalation", () => {
    const view = { ...viewOf({ mode: "manage" }), escalation };
    const draftNeed = { key: "draft:d1", kind: "draft", workstreamId: view.workstream.id, target: { type: "draft", id: "d1" } } as never;
    expect([...decisionShown(draftNeed, [view]).drafts]).toEqual(["d1"]);
    const escalationNeed = { key: "escalation:r-rev", kind: "escalation", workstreamId: view.workstream.id, target: { type: "escalation" } } as never;
    expect([...decisionShown(escalationNeed, [view]).drafts]).toEqual(["p-review"]);
    expect(decisionShown(escalationNeed, [viewOf()]).drafts.size).toBe(0);
    expect(decisionShown(null, [view])).toMatchObject({ need: null });
    expect(decisionShown(undefined, [view]).drafts.size).toBe(0);
  });
});

describe("the next-step line", () => {
  it("shows the sentence with data-next-step, and leaves the line out when nothing is given", () => {
    const view = viewOf({ mode: "manage" });
    const withLine = renderToStaticMarkup(<WorkstreamControlsView view={view} globals={AUTOSTART_DEFAULTS} actions={noop()} confirmingStop={false} onConfirmStop={vi.fn()} next={{ kind: "auto", text: "Next: when R5 (Build) finishes, a review starts automatically.", need: null }} />);
    expect(withLine).toContain('data-next-step="auto"');
    expect(withLine).toContain("Next: when R5 (Build) finishes, a review starts automatically.");
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

describe("the next-step line before Settings' switches are read", () => {
  const building = (): { view: WorkstreamView; runs: Run[] } => {
    const base = new MockBackend().runs.list()[0];
    const run = { ...base, id: "b1", state: "working", spec: { ...base.spec, kind: "build", workstream: sample.id, allowPush: true }, failure: null, needs: null, slotWaitSince: null, endedAt: null } as Run;
    return { view: { ...viewOf({ mode: "manage" }), runs: [run.id], labels: [[run.id, "R1"]] }, runs: [run] };
  };

  it("stays hidden while globals are null, then shows once they load", async () => {
    const { view, runs } = building();
    expect(nextStepOnceKnown(view, runs, [], [], null)).toBeNull();
    const loaded = nextStepOnceKnown(view, runs, [], [], AUTOSTART_DEFAULTS);
    expect(loaded).toMatchObject({ kind: "auto", text: "Next: when R1 (Build) finishes, a review starts automatically." });
  });

  it("respects a rule the person's saved settings switched off", () => {
    const { view, runs } = building();
    const off = nextStepOnceKnown(view, runs, [], [], { ...AUTOSTART_DEFAULTS, buildReview: false });
    expect(off?.kind).not.toBe("auto");
    expect(off?.text).not.toContain("a review starts automatically");
  });

  it("reads the saved switches when the store starts", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    await backend.runsSetSettings({ ...(await backend.runsSettings()), autostart: { ...AUTOSTART_DEFAULTS, buildReview: false } });
    useWorkstreams.getState().init(backend);
    expect(useWorkstreams.getState().globals).toBeNull();
    await vi.waitFor(() => expect(useWorkstreams.getState().globals).toEqual({ ...AUTOSTART_DEFAULTS, buildReview: false }));
    useWorkstreams.getState().init(backend);
    await vi.waitFor(() => expect(useWorkstreams.getState().globals).not.toBeNull());
    useWorkstreams.getState().dispose();
    expect(useWorkstreams.getState().globals).toBeNull();
  });
});

describe("the workstream's controls", () => {
  it("shows the Manage switch as the workstream's mode", () => {
    expect(render(viewOf({ mode: "advise" }))).toMatch(/role="switch" aria-checked="false"[^>]*aria-label="Manage this workstream"/);
    expect(render(viewOf({ mode: "manage" }))).toMatch(/role="switch" aria-checked="true"[^>]*aria-label="Manage this workstream"/);
  });

  it("shows Close beside Hold, not only behind the menu, and asks before closing", () => {
    const at = (view: WorkstreamView, closing = false) =>
      renderToStaticMarkup(<WorkstreamControlsView view={view} globals={AUTOSTART_DEFAULTS} actions={noop()} confirmingStop={false} onConfirmStop={vi.fn()} confirmingClose={closing} onConfirmClose={vi.fn()} />);
    const idle = at(viewOf());
    expect(idle).toContain("data-close-workstream");
    expect(idle.indexOf(">Hold</button>")).toBeLessThan(idle.indexOf("data-close-workstream"));
    expect(idle).not.toContain('aria-label="Close this workstream"');
    // Held, there is no Hold, but Close stays.
    expect(at(viewOf({ heldReason: HELD_PERSON }))).toContain("data-close-workstream");
    const asking = at(viewOf(), true);
    expect(asking).toContain('aria-label="Close this workstream"');
    expect(asking).toContain("Its conversation goes back to General; its agents and drafts are kept.");
    // Where a workstream can't be closed from (no handler), there is no button.
    expect(render(viewOf())).not.toContain("data-close-workstream");
    expect(renderToStaticMarkup(<CloseConfirm onClose={vi.fn()} onKeep={vi.fn()} />)).toContain("Keep");
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
      expect(html).toContain(heldText(reason)!.replace(/'/g, "&#x27;"));
      expect(html).toContain(">Resume</button>");
      expect(html).not.toContain(">Hold</button>");
    }
    expect(render(viewOf({ heldReason: HELD_BUDGET }))).toContain("Held: automatic steps used up");
    expect(render(viewOf({ heldReason: HELD_RESTART }))).toContain("Held after a restart");
  });

  it("asks the budget question in a budget hold in Manage, with no Resume, which would reset what was spent; in Advise only the hold is left to lift", () => {
    const spent = { budget: { autoTurns: 2, wakes: null, tokens: null }, spent: { autoTurns: 2, wakes: 2, tokens: 0 }, heldReason: HELD_BUDGET };
    const manage = render(viewOf({ ...spent, mode: "manage" }));
    expect(manage).toContain("Allow 5 more");
    expect(manage).toContain("Switch to Advise");
    expect(manage).not.toContain(">Resume</button>");
    const advise = render(viewOf({ ...spent, mode: "advise" }));
    expect(advise).toContain(">Resume</button>");
    expect(advise).not.toContain("Allow 5 more");
    // Any other hold in Manage keeps Resume.
    expect(render(viewOf({ heldReason: HELD_QUOTA, mode: "manage" }))).toContain(">Resume</button>");
  });

  it("says a hold the person chose is not in Needs you and offers Resume, and says nothing of that for a hold the system made", () => {
    for (const reason of [HELD_PERSON, HELD_ALL]) {
      const html = render(viewOf({ heldReason: reason }));
      expect(html).toContain("data-held-by-you");
      expect(html).toContain("You chose this, so it is not in Needs you.");
      expect(html).toContain(">Resume</button>");
    }
    expect(render(viewOf({ heldReason: HELD_PERSON }))).toContain("Held by you");
    expect(render(viewOf({ heldReason: HELD_ALL }))).toContain("Held by you (Hold all)");
    for (const reason of [HELD_RESTART, HELD_BUDGET, HELD_DAILY, HELD_QUOTA, `${TRIPWIRE}basis_drift`]) expect(render(viewOf({ heldReason: reason })), reason).not.toContain("data-held-by-you");
  });

  it("says nothing of a budget with plenty left, warns in amber from 80% and says when it is spent", () => {
    expect(render(viewOf({ spent: { autoTurns: 7, wakes: 7, tokens: 0 } }))).not.toContain("data-budget");
    const amber = render(viewOf({ spent: { autoTurns: 9, wakes: 9, tokens: 0 } }));
    expect(amber).toContain('data-budget="amber"');
    expect(amber).toContain("9 of 11 automatic steps used");
    expect(render(viewOf({ spent: { autoTurns: 1, wakes: 10, tokens: 0 } }))).toContain("9 of 11 automatic steps used");
    // A workstream's own limit counts, and its banner says what to do once spent; the line isn't said twice.
    const own = viewOf({ budget: { autoTurns: 2, wakes: null, tokens: null }, spent: { autoTurns: 2, wakes: 2, tokens: 0 }, heldReason: HELD_BUDGET });
    expect(own.budget.level).toBe("spent");
    expect(render(own)).not.toContain("data-budget");
    expect(render(own)).toContain("Held: automatic steps used up");
    expect(render(own)).toContain("data-step-help");
    // Held because the wakes ran out: it still says automatic steps, never a second unit.
    const wakes = render(viewOf({ spent: { autoTurns: 1, wakes: 12, tokens: 0 }, heldReason: HELD_BUDGET }));
    expect(wakes).toContain("Held: automatic steps used up");
    expect(wakes).not.toMatch(/wakes|turns|write to Pip/);
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

  it("defines an automatic step wherever the budget is shown", () => {
    const amber = render(viewOf({ spent: { autoTurns: 9, wakes: 9, tokens: 0 } }));
    const help = STEP_HELP.replace(/'/g, "&#x27;");
    expect(amber).toMatch(new RegExp(`data-budget="amber" title="${help}"`));
    expect(amber).toContain("<summary");
    expect(amber).toContain(help);
    expect(render(viewOf())).not.toContain("data-step-help");
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
    // Where something above already says it (the decision pane's header), the card leaves its own title out.
    const quiet = renderToStaticMarkup(<EscalationCardView escalation={escalation} busy={false} titled={false} onFixRound={vi.fn()} onTakeOver={vi.fn()} onPost={vi.fn()} />);
    expect(quiet).not.toContain("What next?");
    expect(buttons(quiet)).toHaveLength(3);
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

  it("says why Post the review as is is greyed out, in place of what it would do", () => {
    const view = (over: Partial<Parameters<typeof EscalationCardView>[0]>) => renderToStaticMarkup(<EscalationCardView escalation={{ ...escalation, reviewDraft: null }} busy={false} onFixRound={vi.fn()} onTakeOver={vi.fn()} onPost={vi.fn()} {...over} />);
    const noDraft = view({});
    expect(noDraft).toContain(NO_REVIEW_DRAFT);
    expect(noDraft).not.toContain(POST_AS_IS_HELP);
    expect(noDraft).not.toContain("Connect GitHub");
    const offline = view({ github: false, onConnect: vi.fn() });
    expect(offline).toContain(CONNECT_TO_POST);
    expect(offline).toContain("data-escalation-connect");
    expect(offline).not.toContain(POST_AS_IS_HELP);
    // With a draft there is nothing to explain.
    expect(view({ github: false, escalation })).toContain(POST_AS_IS_HELP.replace(/'/g, "&#x27;"));
  });

  it("on Pip home's decision pane, says to connect GitHub rather than that no draft waits, while it isn't connected", () => {
    const view = { ...viewOf(), escalation: { ...escalation, reviewDraft: null } };
    // The store as it starts has no connections; renderToStaticMarkup reads that initial state.
    const offline = renderToStaticMarkup(<EscalationBody view={view} />);
    expect(offline).toContain(CONNECT_TO_POST);
    expect(offline).toContain("data-escalation-connect");
    expect(offline).not.toContain(NO_REVIEW_DRAFT);
  });

  it("on Pip home's decision pane, holds the choices once Post the review as is was pressed, until the draft is posted or goes", () => {
    const pending = { state: { type: "pending" } } as Proposal;
    expect(postingReview(false, pending)).toBe(false);
    expect(postingReview(true, pending)).toBe(true);
    expect(postingReview(true, { state: { type: "applied" } } as Proposal)).toBe(false);
    expect(postingReview(true, { state: { type: "skipped" } } as Proposal)).toBe(false);
    expect(postingReview(true, undefined)).toBe(false);
    // Held, the card shows the marker and 'Run another fix round' is disabled.
    const html = renderToStaticMarkup(<EscalationCardView escalation={escalation} busy={false} drafting={postingReview(true, pending)} onFixRound={vi.fn()} onTakeOver={vi.fn()} onPost={vi.fn()} />);
    expect(html).toContain("data-escalation-draft-open");
    expect(buttons(html).find((b) => b.text === "Run another fix round")?.disabled).toBe(true);
  });

  it("says why the choices wait while the review draft is open, and describes it to a screen reader", () => {
    const html = renderToStaticMarkup(<EscalationCardView escalation={escalation} busy={false} drafting onFixRound={vi.fn()} onTakeOver={vi.fn()} onPost={vi.fn()} />);
    expect(buttons(html).every((b) => b.disabled && b.title === DRAFT_OPEN.replace(/'/g, "&#x27;"))).toBe(true);
    expect(html).toMatch(/<p id="escalation-r-rev-draft" role="status" data-escalation-draft-open[^>]*>Review draft open: post it from the draft\./);
    // Every button is described by what it does and by the reason it waits.
    expect(html.match(/aria-describedby="escalation-r-rev-\d escalation-r-rev-draft"/g)).toHaveLength(3);
    // Closed or discarded, the choices are back and the reason is gone.
    const back = card();
    expect(back).not.toContain("data-escalation-draft-open");
    expect(buttons(back).some((b) => b.disabled)).toBe(false);
  });

  it("holds the draft open only while it waits to be posted and its peek is showing", () => {
    const proposal = (type: string) => ({ state: { type }, intent: { type: "githubReview", item: null } }) as never;
    const opened = { "r-rev": "p-review" };
    const key = "draft:p-review";
    expect(draftOpen(escalation, {}, { "p-review": proposal("pending") }, key)).toBeNull();
    expect(draftOpen(escalation, opened, { "p-review": proposal("pending") }, key)).toBe("p-review");
    expect(draftOpen(escalation, opened, { "p-review": proposal("applying") }, key)).toBe("p-review");
    expect(draftOpen(escalation, opened, { "p-review": proposal("applied") }, key)).toBeNull();
    expect(draftOpen(escalation, opened, { "p-review": proposal("skipped") }, key)).toBeNull();
    expect(draftOpen(escalation, opened, {}, key)).toBeNull();
    expect(draftOpen(escalation, opened, { "p-review": proposal("pending") }, null)).toBeNull();
    expect(draftOpen({ ...escalation, reviewRun: "r-newer" }, opened, { "p-review": proposal("pending") }, key)).toBeNull();
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
    // The store reads them at init; clear them to see the popover read them again.
    await vi.waitFor(() => expect(useWorkstreams.getState().globals).toEqual(AUTOSTART_DEFAULTS));
    useWorkstreams.setState({ globals: null });
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

describe("what the Steps column's words mean", () => {
  it("explains Automatic steps in a tooltip, naming the steps and that they can be switched off", () => {
    const html = render(viewOf());
    expect(html).toContain(`title="${AUTO_STEPS_HELP}"`);
    expect(AUTO_STEPS_HELP).toMatch(/routine next steps/);
    expect(AUTO_STEPS_HELP).toMatch(/Switch any of them off/);
    expect(html).toContain("data-mode-line");
  });
});
