import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Proposal, Run, RunOutcome, RunReview } from "../types";
import { AgentCard } from "./AgentCard";
import { DraftCard } from "./DraftCard";
import { PromptParts } from "./RunPrompt";
import { RunSheetView, type RunSheetActions } from "./RunSheet";
import { savedAsTyped, startBlock } from "./runSheetLogic";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const backend = new MockBackend({ githubRepos: 14, runs: { seed: "kinds", epoch: NOW } });
const build: Run = backend.runs.list().find((r) => r.spec.kind === "build")!;

const actions = (): RunSheetActions => ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), answer: vi.fn(), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), loadBrief: vi.fn(), draftComment: vi.fn(), askPip: vi.fn(), openDraft: vi.fn(), pickBlocker: vi.fn(), cancelBlocker: vi.fn(), draftBlocker: vi.fn(), openChange: vi.fn(), draftTicket: vi.fn(), openTicketDraft: vi.fn(), finishWithPip: vi.fn(), openCreated: vi.fn(), askPipBreakdown: vi.fn(), buildFromPlan: vi.fn(), draftPlanComment: vi.fn(), openPlanDraft: vi.fn(), reviewThis: vi.fn() });
const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({ ...backend.runs.outcome(build.id), ...over });
const sheet = (run: Run, o: RunOutcome | null, on = actions()) =>
  renderToStaticMarkup(<RunSheetView run={run} now={NOW} ticketTitle="Cache the category tree" place={null} wide={false} onWide={vi.fn()} events={[]} disk={null} brief={null} confirmStop={false} outcome={o} tickets={[]} pickBlocker={false} drafting={false} answering={false} opened={false} on={on} />);
const button = (html: string, label: string) => new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*${label}`).exec(html)?.[0] ?? "";
const disabled = (html: string, label: string) => /<button[^>]*disabled=""/.test(button(html, label));

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));

describe("Review this on a card", () => {
  const card = (onReviewThis?: () => void) =>
    renderToStaticMarkup(<AgentCard run={build} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} onReviewThis={onReviewThis} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);

  it("shows the button only when it is given one, and says nothing starts", () => {
    expect(card(vi.fn())).toContain("Review this");
    expect(card(vi.fn())).toContain("Nothing starts");
    expect(card()).not.toContain("Review this");
  });
});

describe("the run sheet for a finished build", () => {
  it("offers Review this, naming the draft pull request, with the adversarial wording", () => {
    const html = sheet(build, outcome());
    expect(html).toContain("data-review-box");
    expect(html).toContain("Pull request #218 (a draft)");
    expect(html).toContain("treats what the builder says it did as a claim to verify");
    expect(html).toContain("comments nothing on the pull request");
    expect(disabled(html, "Review this")).toBe(false);
  });

  it("turns it off, with the reason, when only a summary was read", () => {
    const html = sheet({ ...build, resultComplete: false }, outcome({ summaryOnly: true }));
    expect(disabled(html, "Review this")).toBe(true);
    expect(html).toContain("A review can only follow a build Gossamr has read in full.");
  });

  it("turns it off, with the reason, when there is no pull request or it is not in the same repository", () => {
    const none = sheet(build, outcome({ change: null }));
    expect(disabled(none, "Review this")).toBe(true);
    expect(none).toContain("This build has no pull request yet");
    const fork = sheet(build, outcome({ change: { ...outcome().change!, headRepo: "mallory/webshop" } }));
    expect(disabled(fork, "Review this")).toBe(true);
    expect(fork).toContain("isn&#x27;t from a branch in the same repository");
    const merged = sheet(build, outcome({ change: { ...outcome().change!, state: "merged" } }));
    expect(merged).toContain("is merged, so there is nothing to review");
  });

  it("waits while the outcome is loading", () => {
    const html = sheet(build, null);
    expect(disabled(html, "Review this")).toBe(true);
    expect(html).toContain("Looking for its pull request");
  });

  it("is not there for other kinds", () => {
    const triage = backend.runs.list().find((r) => r.spec.kind === "triage")!;
    expect(sheet(triage, backend.runs.outcome(triage.id))).not.toContain("data-review-box");
  });
});

describe("the builder's account in the exact-prompt review", () => {
  const review = async (): Promise<RunReview> => {
    const made = await backend.runsDraft({ ...build.spec, kind: "review", instruction: "", allowPush: false, pr: null, buildAccount: null, buildFromRun: build.id }, build.item);
    return backend.runs.review(made.id);
  };
  const editor = (over: Record<string, unknown> = {}) => ({ text: "", disabled: false, onChange: vi.fn(), onBlur: vi.fn(), account: { text: "edited account", disabled: false, onChange: vi.fn(), onBlur: vi.fn(), onRefresh: vi.fn(), onRemove: vi.fn(), ...over } });

  it("shows it whole as a part of its own, labelled with the run, read-only when nothing edits it", async () => {
    const html = renderToStaticMarkup(<PromptParts review={await review()} />);
    expect(html).toContain(`What the builder says it did (run ${build.id})`);
    expect(html).toContain("claim to check against the diff and the ticket, not as evidence");
    expect(html).toContain("data-build-account");
    expect(html).toContain("Cached the category tree");
    expect(html).not.toContain("<textarea");
  });

  it("edits it in the setup sheet, with the two buttons that change it", async () => {
    const html = renderToStaticMarkup(<PromptParts review={await review()} editor={editor()} />);
    expect(html).toContain(`aria-label="What the builder says it did (run ${build.id})"`);
    expect(html).toContain("edited account");
    expect(html).toContain("Read it again");
    expect(html).toContain("Review without it");
    expect(html).toContain("only when you press the button");
  });

  it("puts nothing about a builder into a review without one", () => {
    const spec = { ...build.spec, kind: "review" as const, pr: 3, instruction: "Review it." };
    const plain: RunReview = { digest: "d", prompt: "Review it.", instruction: "Review it.", focus: null, ticketBlock: null, guard: "g", spec };
    expect(renderToStaticMarkup(<PromptParts review={plain} />)).not.toContain("What the builder says");
  });

  it("blocks Start while the typed account is empty or differs from the saved one", async () => {
    const r = await review();
    expect(savedAsTyped(r, { instruction: r.instruction, base: r.spec.base, buildAccount: r.buildAccount! })).toBe(true);
    expect(savedAsTyped(r, { instruction: r.instruction, base: r.spec.base, buildAccount: "changed" })).toBe(false);
    expect(savedAsTyped(r, { instruction: r.instruction, base: r.spec.base })).toBe(true);
    const ready = { draft: true, review: r, preflight: { rows: [], blocking: false }, busy: false, starting: false, changedBanner: false };
    expect(startBlock({ ...ready, typed: { instruction: r.instruction, base: "main", buildAccount: "  " } })).toBe("Write the builder's account first, or remove it");
    expect(startBlock({ ...ready, typed: { instruction: r.instruction, base: "main", buildAccount: "x" } })).toBeNull();
  });
});

describe("a review draft that follows a build", () => {
  const card = (p: Proposal) => renderToStaticMarkup(<DraftCard proposal={p} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} />);

  it("says so on its card, with the account's size, and not for other drafts", async () => {
    const made = await backend.runsDraft({ ...build.spec, kind: "review", instruction: "", allowPush: false, pr: null, buildAccount: null, buildFromRun: build.id }, build.item);
    const html = card(made);
    expect(html).toContain("Checks the builder&#x27;s account from run");
    expect(html).toContain("shown whole in the prompt");
    const plain = await backend.runsDraft({ ...build.spec, kind: "review", instruction: "", allowPush: false, pr: 212, buildAccount: null, buildFromRun: null, name: "ca-402-other-0a1b" }, build.item);
    expect(card(plain)).not.toContain("Checks the builder");
  });
});
