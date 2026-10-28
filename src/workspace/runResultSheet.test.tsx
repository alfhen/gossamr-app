import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import type { CodeChange, Proposal, Run, RunOutcome, RunState } from "../types";
import { RunFeedRow } from "./ActivityView";
import { toRunEntries } from "./activityLogic";
import { DraftCard } from "./DraftCard";
import { DraftPreview } from "./DraftPreview";
import { RunSheetView, type RunSheetActions, type RunSheetViewProps } from "./RunSheet";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const seeded = () => new MockBackend().runs.list();
const run = (state: RunState, over: Partial<Run> = {}): Run => ({ ...seeded()[0], id: `r-${state}`, state, needs: null, lastDetail: null, tokens: 1000, result: "Found it.\n\nFor Jira: add a backoff.", error: null, shortId: "1000a000", lastProgressAt: iso(1), queuedAt: iso(10), endedAt: iso(2), ...over });

const actions = (): RunSheetActions => ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), answer: vi.fn(), adoptSession: vi.fn(() => Promise.resolve()), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), askPip: vi.fn(), openChange: vi.fn() });

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({ note: "Found it.", change: null, summaryOnly: false, source: "whole", report: null, ...over });

const tickets = [
  { key: "WEB-9", title: "Banner flicker" },
  { key: "CA-2", title: "Refund rounding" },
  { key: "CA-3", title: "Cart total" },
];

const sheet = (r: Run, over: Partial<RunSheetViewProps> = {}) =>
  renderToStaticMarkup(
    <RunSheetView run={r} now={NOW} ticketTitle="Retry failed payment webhooks" place={null} wide={false} onWide={vi.fn()} events={[]} disk={null} confirmStop={false} outcome={outcome()} tickets={tickets} pickBlocker={false} drafting={false} answering={false} opened={false} on={actions()} {...over} />,
  );


const pr = (over: Partial<CodeChange> = {}): CodeChange => ({
  connectionId: "github:me",
  externalId: "pr:acme/storefront#518",
  kind: "pullRequest",
  repo: "acme/storefront",
  number: 518,
  title: "Back off when the consumer retries",
  headRef: "worktree-devops-455-queue-lag-92a3",
  baseRef: "main",
  state: "open",
  mergedAt: null,
  createdAt: null,
  updatedAt: "2026-09-30T10:30:00Z",
  author: null,
  reviewers: [],
  checks: "passing",
  review: "none",
  url: "https://github.com/acme/storefront/pull/518",
  sha: null,
  additions: 84,
  deletions: 12,
  changedFiles: 5,
  body: "",
  linkedKeys: [],
  ...over,
});

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

describe("Changes", () => {
  it("shows the pull request with its size, checks and a way to open it", () => {
    const html = sheet(run("done"), { outcome: outcome({ change: pr() }) });
    expect(html).toContain(">Changes<");
    expect(html).toContain("#518 Back off when the consumer retries");
    for (const fact of ["5 files changed", "+84 −12", "Checks passing"]) expect(html).toContain(fact);
    expect(html).toContain("Open PR on GitHub");
  });

  it("says a branch has no pull request yet, and shows nothing when no change is known", () => {
    const branch = sheet(run("done"), { outcome: outcome({ change: pr({ kind: "branch", number: null, externalId: "branch:acme/storefront:x", additions: null, deletions: null, changedFiles: null }) }) });
    expect(branch).toContain("Branch only, no pull request yet");
    expect(branch).toContain("Open branch on GitHub");
    expect(sheet(run("done"))).not.toContain(">Changes<");
  });

  it("also shows the change of a run that has not finished", () => {
    expect(sheet(run("working", { result: null, endedAt: null }), { outcome: outcome({ change: pr() }) })).toContain("#518");
  });
});

const draft = (over: Partial<Proposal>): Proposal => ({
  id: "p1",
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  origin: { type: "run", runId: "run-1", shortId: "1000a000" },
  createdBy: "user",
  intent: { type: "comment", item: itemRef("CA-412"), body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "Looked into this with an agent.", marks: [] }] }] } as never },
  label: "From agent run 1000a000",
  basis: null,
  state: { type: "pending" },
  revisions: [],
  created: [],
  error: null,
  run: null,
  ...over,
});

describe("a draft made from a run", () => {
  const props = { statusName: null, people: [], working: false, error: null, onApprove: vi.fn(), onSkip: vi.fn() };

  it("says where it came from, who wrote the words, and still waits for the person", () => {
    // A static render reads the runs store's first state, so the run is named from the draft's ticket; runNames.test
    // covers naming it by its step once the run is known.
    const html = renderToStaticMarkup(<DraftCard proposal={draft({})} {...props} onOpenRun={vi.fn()} />);
    expect(html).toContain('data-provenance="run"');
    // Named by ticket and step, as a link to the run, and never by its id.
    expect(html).toMatch(/From <button[^>]*title="Open the run this draft came from"[^>]*>the CA-412 run<\/button>/);
    expect(html).not.toContain("1000a000");
    expect(html).not.toContain("font-mono");
    expect(html).toContain("The words are the agent&#x27;s. Read and edit them before you approve.");
    expect(html).toContain("Approve");
    expect(html).toContain("Edit");
  });

  it("is not marked when the person wrote it", () => {
    expect(renderToStaticMarkup(<DraftCard proposal={draft({ origin: { type: "board" } })} {...props} />)).not.toContain('data-provenance="run"');
  });

  it("shows a blocker as a sentence the person can read before creating the link", () => {
    const link = draft({ intent: { type: "link", from: itemRef("CA-402"), to: itemRef("CA-412"), kind: "blocks" }, label: "Blocked by CA-402" });
    const html = renderToStaticMarkup(<DraftCard proposal={link} {...props} />);
    expect(html).toContain("CA-402</b> blocks <b");
    expect(html).toContain("CA-412");
    expect(html).toContain("Approve");
    expect(html).toContain("From <b>the CA-402 run</b>");
    const preview = renderToStaticMarkup(<DraftPreview proposal={link} statusName={null} targetTitle={null} onOpen={vi.fn()} />);
    expect(preview).toContain("CA-402 blocks CA-412");
  });
});

describe("an agent row in Activity", () => {
  it("names what happened, the ticket, and that it opens the run", () => {
    const [entry] = toRunEntries([run("done", { result: "The lag comes from one consumer." })], new Set(), NOW).filter((e) => e.kind === "finished");
    const html = renderToStaticMarkup(<RunFeedRow entry={entry} ticketTitle="Retry failed payment webhooks" now={new Date(NOW)} selected={false} position={1} total={3} onOpen={vi.fn()} onMarkRead={vi.fn()} />);
    expect(html).toContain('data-source="agents"');
    expect(html).toContain("Investigator agent finished: The lag comes from one consumer.");
    expect(html).toContain("Retry failed payment webhooks");
    expect(html).toContain("Open run");
    expect(html).toContain("Mark read");
    expect(html).toContain('data-unread="true"');
    expect(html).toContain(">Finished<");
  });

  it("drops the unread marks once read", () => {
    const [entry] = toRunEntries([run("done")], new Set(["run:r-done:done"]), NOW).filter((e) => e.kind === "finished");
    const html = renderToStaticMarkup(<RunFeedRow entry={entry} ticketTitle={null} now={new Date(NOW)} selected={false} position={1} total={1} onOpen={vi.fn()} onMarkRead={vi.fn()} />);
    expect(html).not.toContain("data-unread");
    expect(html).not.toContain("Mark read");
  });
});
