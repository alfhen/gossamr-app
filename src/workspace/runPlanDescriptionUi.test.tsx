import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run, RunOutcome } from "../types";
import { AgentCard } from "./AgentCard";
import { RunSheetView, type RunSheetActions } from "./RunSheet";
import { planDescriptionStatus, planDescriptionWithPipPrompt, runDescriptionDraftOf } from "./runSheetLogic";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const backend = new MockBackend({ runs: { seed: "kinds", epoch: NOW, planDescription: true } });
const plan: Run = backend.runs.list().find((r) => r.spec.kind === "plan")!;

const actions = (): RunSheetActions => ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), answer: vi.fn(), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), loadBrief: vi.fn(), draftComment: vi.fn(), askPip: vi.fn(), openDraft: vi.fn(), pickBlocker: vi.fn(), cancelBlocker: vi.fn(), draftBlocker: vi.fn(), openChange: vi.fn(), draftTicket: vi.fn(), openTicketDraft: vi.fn(), finishWithPip: vi.fn(), openCreated: vi.fn(), askPipBreakdown: vi.fn(), buildFromPlan: vi.fn(), draftPlanComment: vi.fn(), openPlanDraft: vi.fn(), reviewThis: vi.fn(), draftPlanDescription: vi.fn(), openPlanDescription: vi.fn(), discussPlanDescription: vi.fn() });
const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({ ...backend.runs.outcome(plan.id), ...over });
const sheet = (o: RunOutcome | null) =>
  renderToStaticMarkup(<RunSheetView run={plan} now={NOW} ticketTitle="Welcome flow refresh" place={null} wide={false} onWide={vi.fn()} events={[]} disk={null} brief={null} confirmStop={false} outcome={o} tickets={[]} pickBlocker={false} drafting={false} answering={false} opened={false} on={actions()} />);
const state = (type: "pending" | "applied" | "skipped") => ({ type }) as const;
const withDraft = (type: "pending" | "applied" | "skipped" | null, unavailable: string | null = null) => outcome({ planDescription: { draft: type ? { id: "p1", state: state(type) } : null, unavailable } });

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));

describe("the finished plan's description update on the run sheet", () => {
  it("shows the waiting draft first and prominently, with the diff and Pip beside it and the comment as the secondary way", () => {
    const html = sheet(withDraft("pending"));
    expect(html).toContain('data-plan-description="waiting"');
    expect(html).toContain("Description update ready: see the diff.");
    expect(html).toContain("See the diff");
    expect(html).toContain("Chat it over with Pip");
    expect(html).toContain("Gossamr Plan");
    expect(html.indexOf("Description update ready")).toBeLessThan(html.indexOf('data-plan="text"'));
    expect(html).toContain("Draft the plan as a comment");
    expect(html).not.toContain("Draft the description update");
  });

  it("says how a decided one ended and offers a new one for a skipped or out-of-date draft", () => {
    expect(sheet(withDraft("applied"))).toContain("The plan was added to");
    const skipped = sheet(withDraft("skipped"));
    expect(skipped).toContain("You skipped its description update.");
    expect(skipped).toContain("Draft it again");
    const retired = sheet(outcome({ planDescription: { draft: { id: "p1", state: { type: "retired", reason: "replaced by a newer plan" } }, unavailable: null } }));
    expect(retired).toContain("out of date");
  });

  it("offers to draft it when there is none and nothing stops it", () => {
    const html = sheet(withDraft(null));
    expect(html).toContain("Draft the description update");
    expect(html).not.toContain("See the diff");
  });

  it("says why there is none when the description can't take it, and the comment stays", () => {
    const html = sheet(withDraft(null, "This tracker can't change a ticket's description, so the plan can only go to the ticket as a comment."));
    expect(html).toContain("data-plan-description-why");
    expect(html).toContain("No description update: This tracker can&#x27;t change");
    expect(html).not.toContain("Draft the description update");
    expect(html).toContain("Draft the plan as a comment");
  });

  it("shows nothing about a description for an older backend or another kind", () => {
    expect(sheet(outcome({ planDescription: undefined }))).not.toContain("data-plan-description");
    const triage = backend.runs.list().find((r) => r.spec.kind === "triage")!;
    expect(backend.runs.outcome(triage.id).planDescription ?? null).toBeNull();
  });

  it("derives the status from the outcome and finds the waiting draft by its run", () => {
    expect(planDescriptionStatus(null)).toBe("none");
    expect(planDescriptionStatus(withDraft("pending"))).toBe("waiting");
    expect(planDescriptionStatus(withDraft("applied"))).toBe("applied");
    const proposals = backend.proposals.list({ states: ["pending"] });
    expect(runDescriptionDraftOf(proposals, plan.id)?.intent.type).toBe("rewrite");
    expect(runDescriptionDraftOf(proposals, "someone-else")).toBeUndefined();
  });

  it("sends Pip the draft and the run by id, never their text", () => {
    const prompt = planDescriptionWithPipPrompt(plan, "p1");
    expect(prompt).toContain("description update draft p1 on CA-401, drafted from agent run " + plan.id + ".");
    expect(prompt).toContain("get_run_result");
    expect(prompt).toContain("revise_proposal");
    expect(prompt).not.toContain("Klaviyo");
  });
});

describe("the card of a finished plan", () => {
  const card = (props: { descriptionReady?: boolean; onOpenDescription?: () => void }) =>
    renderToStaticMarkup(<AgentCard run={plan} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} {...props} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);

  it("carries a Description update ready chip only while one is waiting", () => {
    expect(card({ descriptionReady: true, onOpenDescription: vi.fn() })).toContain("Description update ready");
    expect(card({ descriptionReady: false, onOpenDescription: vi.fn() })).not.toContain("Description update ready");
    expect(card({ descriptionReady: true })).not.toContain("Description update ready");
  });
});
