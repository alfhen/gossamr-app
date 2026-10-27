import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run, RunOutcome } from "../types";
import { AgentCard } from "./AgentCard";
import { PromptParts } from "./RunPrompt";
import { RunSheetView, type RunSheetActions } from "./RunSheet";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const backend = new MockBackend({ githubRepos: 14, runs: { seed: "kinds", epoch: NOW } });
const build: Run = backend.runs.list().find((r) => r.spec.role === "builder")!;

const actions = (): RunSheetActions => ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), answer: vi.fn(), adoptSession: vi.fn(() => Promise.resolve()), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), askPip: vi.fn(), openChange: vi.fn() });
const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({ ...backend.runs.outcome(build.id), ...over });
const sheet = (run: Run, o: RunOutcome | null, on = actions()) =>
  renderToStaticMarkup(<RunSheetView run={run} now={NOW} ticketTitle="Cache the category tree" place={null} wide={false} onWide={vi.fn()} events={[]} disk={null} confirmStop={false} outcome={o} tickets={[]} pickBlocker={false} drafting={false} answering={false} opened={false} on={on} />);
const button = (html: string, label: string) => new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*${label}`).exec(html)?.[0] ?? "";
const disabled = (html: string, label: string) => /<button[^>]*disabled=""/.test(button(html, label));

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));

describe("Ask Pip to review on a card", () => {
  const card = (onReviewThis?: () => void) =>
    renderToStaticMarkup(<AgentCard run={build} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} onReviewThis={onReviewThis} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);

  it("shows the button only when it is given one", () => {
    expect(card(vi.fn())).toContain("Ask Pip to review");
    expect(card()).not.toContain("Ask Pip to review");
  });
});

describe("what the agent was told, on the run sheet", () => {
  const html = (run: Run) => renderToStaticMarkup(<PromptParts run={run} />);

  it("shows the base brief and Pip's brief, and the ticket as data, read-only", () => {
    const out = html({ ...build, spec: { ...build.spec, role: "reviewer", pr: 218, brief: "Review it and report a verdict." } });
    expect(out).toContain("Base brief from Gossamr");
    expect(out).toContain("Role: reviewer.");
    expect(out).toContain("then checks out pull request 218");
    expect(out).toContain("Pip&#x27;s brief");
    expect(out).toContain("Review it and report a verdict.");
    expect(out).toContain("Ticket from Jira, with its comments");
    expect(out).not.toContain("<textarea");
    expect(out).not.toContain("data-build-account");
    expect(out).not.toContain("data-findings");
  });

  it("leaves out the pull request step without one, and the ticket without its text", () => {
    const out = html({ ...build, spec: { ...build.spec, pr: null, ticketBlock: null } });
    expect(out).not.toContain("checks out pull request");
    expect(out).not.toContain("Ticket from Jira");
  });
});
