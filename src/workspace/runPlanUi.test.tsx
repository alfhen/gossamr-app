import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { renderPrompt, SCRIPTED_PLAN_RESULT } from "../backend/mockRuns";
import type { Proposal, Run, RunOutcome, RunReview } from "../types";
import { toRunEntries } from "./activityLogic";
import { AgentCard } from "./AgentCard";
import { KIND_ICON } from "./AgentIcons";
import { AgentMenuView } from "./AgentMenu";
import { DraftCard } from "./DraftCard";
import { KIND_LABEL } from "./agentsLogic";
import { PromptParts } from "./RunPrompt";
import { RunSheetView, type RunSheetActions } from "./RunSheet";
import { buildFromPlanControl, buildFromPlanOptions, planCommentControl, planCommentMessage, savedAsTyped, startBlock } from "./runSheetLogic";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const backend = new MockBackend({ runs: { seed: "kinds", epoch: NOW } });
const plan: Run = backend.runs.list().find((r) => r.spec.kind === "plan")!;

const actions = (): RunSheetActions => ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), answer: vi.fn(), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), loadBrief: vi.fn(), draftComment: vi.fn(), askPip: vi.fn(), openDraft: vi.fn(), pickBlocker: vi.fn(), cancelBlocker: vi.fn(), draftBlocker: vi.fn(), openChange: vi.fn(), draftTicket: vi.fn(), openTicketDraft: vi.fn(), finishWithPip: vi.fn(), openCreated: vi.fn(), askPipBreakdown: vi.fn(), buildFromPlan: vi.fn(), draftPlanComment: vi.fn(), openPlanDraft: vi.fn(), reviewThis: vi.fn() });
const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({ ...backend.runs.outcome(plan.id), ...over });
const sheet = (run: Run, o: RunOutcome | null, on = actions()) =>
  renderToStaticMarkup(<RunSheetView run={run} now={NOW} ticketTitle="Welcome flow refresh" place={null} wide={false} onWide={vi.fn()} events={[]} disk={null} brief={null} confirmStop={false} outcome={o} tickets={[]} pickBlocker={false} drafting={false} answering={false} opened={false} on={on} />);
const button = (html: string, label: string) => new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*${label}`).exec(html)?.[0] ?? "";
const disabled = (html: string, label: string) => /<button[^>]*disabled=""/.test(button(html, label));

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));

describe("every surface knows the plan kind", () => {
  it("has a label and an icon, and the Agent menu offers it after Triage", () => {
    expect(KIND_LABEL.plan).toBe("Plan");
    expect(KIND_ICON.plan).toBe("plan");
    const html = renderToStaticMarkup(<AgentMenuView ticketKey="CA-401" open onOpen={vi.fn()} onStart={vi.fn()} />);
    expect(html).toContain("Plan this ticket");
    expect(html.indexOf("Triage this ticket")).toBeLessThan(html.indexOf("Plan this ticket"));
    expect(html.indexOf("Plan this ticket")).toBeLessThan(html.indexOf("Build this"));
  });

  it("names the kind on the card and in Activity", () => {
    const card = renderToStaticMarkup(<AgentCard run={plan} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    expect(card).toContain(">Plan<");
    const entries = toRunEntries([plan], new Set<string>(), NOW, new Set<string>(), new Set<string>());
    expect(entries.map((e) => e.text).join("\n")).toContain("Plan agent started");
  });
});

describe("Build from plan on a card", () => {
  const card = (run: Run, onBuildFromPlan?: () => void) =>
    renderToStaticMarkup(<AgentCard run={run} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} onBuildFromPlan={onBuildFromPlan} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);

  it("shows the button only when it is given one", () => {
    expect(card(plan, vi.fn())).toContain("Build from plan");
    expect(card(plan)).not.toContain("Build from plan");
  });

  it("is enabled for a finished, fully read plan run on a ticket, and for nothing else", () => {
    expect(buildFromPlanControl(plan)).toEqual({ enabled: true, reason: null });
    const off = (over: Partial<Run>) => buildFromPlanControl({ ...plan, ...over });
    expect(off({ state: "working" }).enabled).toBe(false);
    expect(off({ item: null }).reason).toContain("needs a ticket");
    expect(off({ result: "  " }).reason).toContain("no plan");
    expect(off({ resultComplete: false }).reason).toContain("read in full");
    expect(off({ spec: { ...plan.spec, kind: "triage" } }).reason).toContain("Only a plan run");
  });

  it("opens the Build draft for the same ticket and repository", () => {
    expect(buildFromPlanOptions(plan)).toEqual({ item: plan.item, kind: "build", repo: plan.spec.repo, planFromRun: plan.id });
  });
});

describe("the run sheet for a finished plan", () => {
  it("shows the whole plan, then the note for Jira, with both buttons on", () => {
    const html = sheet(plan, outcome());
    expect(html).toContain("The plan it wrote");
    expect(html).toContain('data-plan="text"');
    expect(html).toContain("Move the three welcome emails");
    expect(html).toContain("Open questions for a person");
    expect(html).toContain("For Jira, as the agent wrote it");
    expect(html.indexOf("The plan</p>")).toBeLessThan(html.indexOf("For Jira, as the agent wrote it"));
    expect(disabled(html, "Build from this plan")).toBe(false);
    expect(disabled(html, "Draft the plan as a comment")).toBe(false);
    expect(html).toContain("holds only the short note for Jira");
  });

  it("offers to open the plan comment once drafted, and says how a decided one ended", () => {
    const waiting = sheet(plan, outcome({ planDraft: { id: "p1", state: { type: "pending" } } }));
    expect(waiting).toContain("Open the plan comment");
    expect(waiting).not.toContain("Draft the plan as a comment");
    expect(waiting).toContain("The plan is drafted as a comment on");
    expect(sheet(plan, outcome({ planDraft: { id: "p1", state: { type: "applied" } } }))).toContain("Its plan comment was posted.");
    expect(sheet(plan, outcome({ planDraft: { id: "p1", state: { type: "skipped" } } }))).toContain("You skipped its plan comment.");
  });

  it("turns both off, with the reason, when only a summary was read", () => {
    const html = sheet({ ...plan, resultComplete: false }, outcome({ summaryOnly: true }));
    expect(disabled(html, "Build from this plan")).toBe(true);
    expect(disabled(html, "Draft the plan as a comment")).toBe(true);
    expect(html).toContain("read in full");
  });

  it("has no plan box for other kinds", () => {
    const triage = backend.runs.list().find((r) => r.spec.kind === "triage")!;
    expect(sheet(triage, backend.runs.outcome(triage.id))).not.toContain("data-plan-box");
  });

  it("explains the plan comment's message, and says when it was cut", () => {
    expect(planCommentMessage({ cut: false, total: 900 })).toBe("Plan comment drafted. Nothing is posted until you approve it.");
    expect(planCommentMessage({ cut: true, total: 31_204 })).toContain("31,204 characters and a Jira comment holds less, so it is cut at the end of a sentence");
    expect(planCommentControl(plan).enabled).toBe(true);
    expect(planCommentControl({ ...plan, item: null }).reason).toContain("nothing to comment on");
    expect(planCommentControl({ ...plan, resultComplete: false }).reason).toContain("There is no plan to draft");
  });
});

describe("the build's plan in the exact-prompt review", () => {
  const build = async () => {
    const made = await backend.runsDraft({ ...plan.spec, kind: "build", instruction: "", plan: null, planFromRun: plan.id }, plan.item);
    const review = backend.runs.review(made.id);
    return review;
  };
  const editor = (over: Record<string, unknown> = {}) => ({ text: "", disabled: false, onChange: vi.fn(), onBlur: vi.fn(), plan: { text: "edited plan", disabled: false, onChange: vi.fn(), onBlur: vi.fn(), onRefresh: vi.fn(), onRemove: vi.fn(), ...over } });

  it("shows the plan whole as a part of its own, labelled with the run, read-only when nothing edits it", async () => {
    const review = await build();
    const html = renderToStaticMarkup(<PromptParts review={review} />);
    expect(html).toContain(`Plan from run ${plan.id}`);
    expect(html).toContain("sent whole and as data");
    expect(html).toContain("data-plan");
    expect(html).toContain("Open questions for a person");
    expect(html).not.toContain("<textarea");
    expect(html).toContain(`${SCRIPTED_PLAN_RESULT.length.toLocaleString("en")} characters`);
  });

  it("edits it in the setup sheet, with the two buttons that change it", async () => {
    const review = await build();
    const html = renderToStaticMarkup(<PromptParts review={review} editor={editor()} />);
    expect(html).toContain(`aria-label="Plan from run ${plan.id}"`);
    expect(html).toContain("edited plan");
    expect(html).toContain("Read the plan again");
    expect(html).toContain("Build without it");
    expect(html).toContain("only when you press the button");
  });

  it("puts nothing about a plan into a review without one", () => {
    const spec = { ...plan.spec, kind: "build" as const, instruction: "Do it." };
    const review: RunReview = { digest: "d", prompt: renderPrompt(spec), instruction: "Do it.", focus: null, ticketBlock: null, guard: "g", spec };
    expect(renderToStaticMarkup(<PromptParts review={review} />)).not.toContain("Plan from run");
  });

  it("blocks Start while the typed plan is empty or differs from the saved one", async () => {
    const review = await build();
    expect(savedAsTyped(review, { instruction: review.instruction, base: review.spec.base, plan: review.plan! })).toBe(true);
    expect(savedAsTyped(review, { instruction: review.instruction, base: review.spec.base, plan: "changed" })).toBe(false);
    expect(savedAsTyped(review, { instruction: review.instruction, base: review.spec.base })).toBe(true);
    const ready = { draft: true, review, preflight: { rows: [], blocking: false }, busy: false, starting: false, changedBanner: false };
    expect(startBlock({ ...ready, typed: { instruction: review.instruction, base: "main", plan: "  " } })).toBe("Write the plan first, or remove it");
    expect(startBlock({ ...ready, typed: { instruction: review.instruction, base: "main", plan: "x" } })).toBeNull();
  });
});

describe("a build draft that follows a plan", () => {
  const card = (p: Proposal) => renderToStaticMarkup(<DraftCard proposal={p} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} />);

  it("says so on its card, with the plan's size, and not for other drafts", async () => {
    const made = await backend.runsDraft({ ...plan.spec, kind: "build", instruction: "", plan: null, planFromRun: plan.id }, plan.item);
    const html = card(made);
    expect(html).toContain("Follows the plan from run");
    expect(html).toContain("shown whole in the prompt");
    const plain = await backend.runsDraft({ ...plan.spec, kind: "build", instruction: "", plan: null, planFromRun: null, name: "ca-401-other-0a1b" }, plan.item);
    expect(card(plain)).not.toContain("Follows the plan");
  });
});
