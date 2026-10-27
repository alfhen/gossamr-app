import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { readOnlyRules } from "../backend/mockRunKinds";
import type { Run, RunSpec } from "../types";
import { AgentCard } from "./AgentCard";
import { RunSheetView, type RunSheetActions } from "./RunSheet";
import { AgentRow } from "./AgentRow";
import { COPY, MAY_TOUCH_READ_ONLY } from "./runSheetLogic";

// What the person is shown of the restriction Claude Code enforces on a read-only kind: the badge on the card and the rules a
// run was launched with, on its sheet. A Build shows none of it and keeps the "request, not a lock" copy.

const NOW = Date.parse("2026-09-30T12:00:00Z");
const seeded = () => new MockBackend().runs.list();
/** Text as the static markup escapes it. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const rulesOf = (over: Partial<RunSpec> = {}) => readOnlyRules({ ...seeded()[0].spec, name: "ca-401-fix-ab12", ...over });

const run = (over: Partial<Run> = {}): Run => ({ ...seeded()[0], id: "r-1", state: "working", needs: null, error: null, result: null, endedAt: null, ...over });

const actions = (): RunSheetActions => ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), answer: vi.fn(), adoptSession: vi.fn(() => Promise.resolve()), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), draftComment: vi.fn(), askPip: vi.fn(), openDraft: vi.fn(), pickBlocker: vi.fn(), cancelBlocker: vi.fn(), draftBlocker: vi.fn(), openChange: vi.fn(), draftTicket: vi.fn(), openTicketDraft: vi.fn(), finishWithPip: vi.fn(), openCreated: vi.fn(), askPipBreakdown: vi.fn(), buildFromPlan: vi.fn(), draftPlanComment: vi.fn(), openPlanDraft: vi.fn(), reviewThis: vi.fn() });

const sheet = (r: Run) =>
  renderToStaticMarkup(<RunSheetView run={r} now={NOW} ticketTitle="Welcome flow refresh" place={{ index: 1, total: 1 }} wide={false} onWide={vi.fn()} events={[]} disk={null} confirmStop={false} outcome={null} tickets={[]} pickBlocker={false} drafting={false} answering={false} opened={false} on={actions()} />);

const card = (r: Run) => renderToStaticMarkup(<AgentCard run={r} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);

/** The rules listed under `attr`, one per list item. */
const listed = (html: string, attr: string) => {
  const list = new RegExp(`<ul ${attr}[^>]*>([\\s\\S]*?)</ul>`).exec(html)?.[1] ?? "";
  return [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
};

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

describe("the rules of a read-only kind", () => {
  it("lists a review's pull request head and test runners among the allowed commands", () => {
    expect(rulesOf({ kind: "review", pr: 512, prSha: "abc1234" })?.allow).toEqual(expect.arrayContaining(["Bash(git fetch origin pull/512/head)", "Bash(git checkout --detach abc1234)", "Bash(cargo test)"]));
  });
});

describe("a run's sheet and card", () => {
  const readOnly = rulesOf({ kind: "investigate" });

  it("lists the rules among what the agent was told only when the run was launched with them", () => {
    const launched = sheet(run({ readOnly }));
    expect(launched).toContain("data-read-only-extras");
    expect(listed(launched, "data-read-only-rules")).toContain("Bash(git push *)");
    expect(launched).toContain(COPY.readOnly);
    // A run launched before Phase 6 has no record of a restriction, whatever its spec would get today.
    const old = sheet(run({ readOnly: undefined }));
    expect(old).not.toContain("data-read-only");
    expect(old).not.toContain("--permission-mode");
  });

  it("says on a read-only run's sheet that pushes are refused, not asked, and keeps the old list for a Build", () => {
    const restricted = sheet(run({ readOnly }));
    for (const t of MAY_TOUCH_READ_ONLY) expect(restricted).toContain(esc(t.text));
    expect(restricted).not.toContain("the run stops under Needs you");
    const builder = sheet(run({ spec: { ...run().spec, kind: "build" }, readOnly: null }));
    expect(builder).toContain("the run stops under Needs you");
  });

  it("shows only a shield in a list row, so the title keeps its room", () => {
    const html = renderToStaticMarkup(<AgentRow run={run({ readOnly })} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    const badge = /<span data-read-only="true"[^>]*>[\s\S]*?<\/span>/.exec(html)?.[0] ?? "";
    expect(badge).toContain(`aria-label="${esc(COPY.readOnly)}"`);
    const tested = renderToStaticMarkup(<AgentRow run={run({ spec: { ...run().spec, kind: "review" }, readOnly: rulesOf({ kind: "review", pr: 512, prSha: "abc1234" }) })} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    expect(/<span data-read-only="true"[^>]*>/.exec(tested)?.[0]).toContain(`aria-label="${esc(COPY.readOnlyTests)}"`);
    expect(badge).not.toMatch(/>Read-only</);
    expect(html).toMatch(/class="min-w-\[6ch\] truncate font-semibold"/);
    expect(renderToStaticMarkup(<AgentRow run={run({ readOnly: undefined })} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />)).not.toContain("data-read-only");
  });

  it("puts the Read-only badge on a restricted run's card, not on a Build's or an old run's", () => {
    const restricted = card(run({ readOnly }));
    expect(restricted).toMatch(new RegExp(`<span data-read-only="true" title="${COPY.readOnly}"[^>]*>[\\s\\S]*?Read-only</span>`));
    const builder = run({ spec: { ...run().spec, kind: "build" }, readOnly: null });
    expect(card(builder)).not.toContain("data-read-only");
    expect(card(run({ readOnly: undefined }))).not.toContain("data-read-only");
  });
});
