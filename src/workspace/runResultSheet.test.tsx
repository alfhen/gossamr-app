import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import type { CodeChange, Proposal, Run, RunOutcome, RunState } from "../types";
import { RunFeedRow } from "./ActivityView";
import { toRunEntries } from "./activityLogic";
import { AgentCard } from "./AgentCard";
import { DraftCard } from "./DraftCard";
import { DraftPreview } from "./DraftPreview";
import { scriptPip } from "../backend/mockPip";
import { commentWithPipPrompt } from "./runSheetLogic";
import { RunSheetView, type RunSheetActions, type RunSheetViewProps } from "./RunSheet";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const seeded = () => new MockBackend().runs.list();
const run = (state: RunState, over: Partial<Run> = {}): Run => ({ ...seeded()[0], id: `r-${state}`, state, needs: null, lastDetail: null, tokens: 1000, result: "Found it.\n\nFor Jira: add a backoff.", error: null, shortId: "1000a000", lastProgressAt: iso(1), queuedAt: iso(10), endedAt: iso(2), ...over });

const actions = (): RunSheetActions => ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), answer: vi.fn(), adoptSession: vi.fn(() => Promise.resolve()), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), loadBrief: vi.fn(), draftComment: vi.fn(), askPip: vi.fn(), openDraft: vi.fn(), pickBlocker: vi.fn(), cancelBlocker: vi.fn(), draftBlocker: vi.fn(), openChange: vi.fn(), draftTicket: vi.fn(), openTicketDraft: vi.fn(), finishWithPip: vi.fn(), openCreated: vi.fn(), askPipBreakdown: vi.fn(), buildFromPlan: vi.fn(), draftPlanComment: vi.fn(), openPlanDraft: vi.fn(), reviewThis: vi.fn() });

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({ note: { text: "add a backoff.", fromMarker: true }, keys: ["WEB-9", "CA-2"], change: null, draft: null, ticket: null, ticketDraft: null, subtasks: [], subtasksDraft: null, ...over });

const tickets = [
  { key: "WEB-9", title: "Banner flicker" },
  { key: "CA-2", title: "Refund rounding" },
  { key: "CA-3", title: "Cart total" },
];

const sheet = (r: Run, over: Partial<RunSheetViewProps> = {}) =>
  renderToStaticMarkup(
    <RunSheetView run={r} now={NOW} ticketTitle="Retry failed payment webhooks" place={null} wide={false} onWide={vi.fn()} events={[]} disk={null} brief={null} confirmStop={false} outcome={outcome()} tickets={tickets} pickBlocker={false} drafting={false} answering={false} opened={false} on={actions()} {...over} />,
  );

const button = (html: string, label: string) => new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*${label}`).exec(html)?.[0] ?? "";
const disabled = (html: string, label: string) => /<button[^>]*disabled=""/.test(button(html, label));

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

describe("What it found", () => {
  it("shows the part for Jira first with the whole answer folded away, and both drafting buttons", () => {
    const html = sheet(run("done"));
    expect(html).toContain("For Jira, as the agent wrote it");
    expect(html).toContain('data-note="section"');
    expect(html).toContain("add a backoff.");
    expect(html).toContain("The full answer");
    expect(html).toContain("Found it.");
    expect(disabled(html, "Draft a Jira comment from this")).toBe(false);
    expect(disabled(html, "Draft a blocker")).toBe(false);
    expect(html).toContain("Nothing is posted until you approve a draft");
  });

  it("says plainly when there was no For Jira section and marks the text as unparsed", () => {
    const html = sheet(run("done", { result: "It is the rounding." }), { outcome: outcome({ note: { text: "It is the rounding.", fromMarker: false } }) });
    expect(html).toContain("No &#x27;For Jira:&#x27; section, so this is its whole answer, shortened");
    expect(html).toContain("Not parsed");
    expect(html).toContain('data-note="whole"');
    expect(html).not.toContain("The full answer");
  });

  it("says the full answer could not be read instead of claiming the agent marked nothing", () => {
    const summary = "Triage complete: small PR, link fields already protected";
    const html = sheet(run("done", { result: summary, summary, resultComplete: false }), { outcome: outcome({ note: { text: summary, fromMarker: false }, summaryOnly: true }) });
    expect(html).toContain("Gossamr could only read a one-line summary of the run, not its full answer. Open the session to see the rest.");
    expect(html).toContain("Summary only");
    expect(html).toContain('data-note="summary"');
    expect(html).not.toContain("Not parsed");
    expect(html).not.toContain("so this is its whole answer");
    expect(html).not.toContain("The full answer");
  });

  it("falls back to the raw text until the note has loaded", () => {
    const html = sheet(run("done"), { outcome: null });
    expect(html).toContain("Found it.");
    expect(html).not.toContain("For Jira, as the agent wrote it");
    expect(disabled(html, "Draft a Jira comment from this")).toBe(false);
  });

  it("offers a ticket instead of a comment or a blocker when the run has no ticket", () => {
    const html = sheet(run("done", { item: null }));
    expect(html).not.toContain("Draft a Jira comment from this");
    expect(html).not.toContain("Draft a blocker");
    expect(disabled(html, "Draft a ticket from this")).toBe(false);
  });

  it("disables the comment when it finished without an answer, but not the blocker", () => {
    const html = sheet(run("done", { result: null }), { outcome: outcome({ note: null, keys: [] }) });
    expect(html).toContain("It finished without a written answer");
    expect(disabled(html, "Draft a Jira comment from this")).toBe(true);
    expect(disabled(html, "Draft a blocker")).toBe(false);
    expect(html).toContain("so there is nothing to post");
  });

  it("offers Draft with Pip under the same rules as the plain draft", () => {
    expect(disabled(sheet(run("done")), "Draft with Pip")).toBe(false);
    expect(sheet(run("done", { item: null }))).not.toContain("Draft with Pip");
    expect(disabled(sheet(run("done", { result: null }), { outcome: outcome({ note: null, keys: [] }) }), "Draft with Pip")).toBe(true);
    expect(disabled(sheet(run("done"), { drafting: true }), "Draft with Pip")).toBe(true);
    for (const state of ["working", "failed"] as const) expect(sheet(run(state, { result: null }))).not.toContain("Draft with Pip");
  });

  it("names the run and its ticket in the prompt for Pip, and tells it not to claim anything is posted", () => {
    const r = run("done");
    const prompt = commentWithPipPrompt(r);
    expect(prompt).toContain(`run ${r.id}`);
    expect(prompt).toContain("get_run");
    expect(prompt).toContain(r.item!.key);
    expect(prompt).not.toContain(r.result!);
    expect(prompt).toContain("don't say anything has been posted");
  });

  it("has the sample Pip answer that prompt with a comment draft on the run's ticket", () => {
    const r = run("done");
    const script = scriptPip(commentWithPipPrompt(r), { view: null, item: null, filter: null, selection: [] }, [], [r]);
    expect(script.draft?.intent).toMatchObject({ type: "comment", item: r.item });
    expect(script.text).toContain("isn't posted");
    expect(JSON.stringify(script.draft?.intent)).toContain("add a backoff.");
    expect(JSON.stringify(script.draft?.intent)).not.toContain("only read code");
    expect(script.runDraft ?? null).toBeNull();
  });

  it("waits while a draft is being made", () => {
    const html = sheet(run("done"), { drafting: true });
    expect(disabled(html, "Draft a Jira comment from this")).toBe(true);
    expect(disabled(html, "Draft a blocker")).toBe(true);
  });

  it("offers neither action on a run that has not finished", () => {
    for (const state of ["working", "needsAnswer", "failed", "stopped"] as const) {
      const html = sheet(run(state, { result: null }));
      expect(html).not.toContain("Draft a Jira comment");
      expect(html).not.toContain("Draft a blocker");
    }
  });

  it("opens the blocker picker with the tickets the result names first, not the run's own", () => {
    const html = sheet(run("done"), { pickBlocker: true });
    expect(html).toContain("Which ticket blocks");
    const keys = [...html.matchAll(/font-mono text-sm font-semibold">([A-Z]+-\d+)</g)].map((m) => m[1]);
    expect(keys.slice(0, 2)).toEqual(["WEB-9", "CA-2"]);
    expect(html).toContain("in the result");
    expect(html).not.toContain(`aria-label="Tickets"><li><button type="button"><span class="font-mono text-sm font-semibold">${run("done").item?.key}`);
    expect(html).toContain('aria-expanded="true"');
  });
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
    const html = renderToStaticMarkup(<DraftCard proposal={draft({})} {...props} onOpenRun={vi.fn()} />);
    expect(html).toContain('data-provenance="run"');
    expect(html).toContain("From agent run");
    expect(html).toContain("1000a000");
    expect(html).toContain("The words are the agent&#x27;s. Read and edit them before you approve.");
    expect(html).toContain("Post comment");
    expect(html).toContain("Edit");
  });

  it("is not marked when the person wrote it", () => {
    expect(renderToStaticMarkup(<DraftCard proposal={draft({ origin: { type: "board" } })} {...props} />)).not.toContain("From agent run");
  });

  it("shows a blocker as a sentence the person can read before creating the link", () => {
    const link = draft({ intent: { type: "link", from: itemRef("CA-402"), to: itemRef("CA-412"), kind: "blocks" }, label: "Blocked by CA-402" });
    const html = renderToStaticMarkup(<DraftCard proposal={link} {...props} />);
    expect(html).toContain("CA-402</b> blocks <b");
    expect(html).toContain("CA-412");
    expect(html).toContain("Create link");
    expect(html).toContain("From agent run");
    const preview = renderToStaticMarkup(<DraftPreview proposal={link} statusName={null} targetTitle={null} onOpen={vi.fn()} />);
    expect(preview).toContain("CA-402 blocks CA-412");
  });
});

describe("an agent row in Activity", () => {
  it("names what happened, the ticket, and that it opens the run", () => {
    const [entry] = toRunEntries([run("done", { result: "The lag comes from one consumer." })], new Set(), NOW).filter((e) => e.kind === "finished");
    const html = renderToStaticMarkup(<RunFeedRow entry={entry} ticketTitle="Retry failed payment webhooks" now={new Date(NOW)} selected={false} position={1} total={3} onOpen={vi.fn()} onMarkRead={vi.fn()} />);
    expect(html).toContain('data-source="agents"');
    expect(html).toContain("Investigate agent finished: The lag comes from one consumer.");
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

describe("the Draft comment shortcut on an agent card", () => {
  const card = (onDraftComment?: () => void) =>
    renderToStaticMarkup(
      <AgentCard run={run("done")} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} onDraftComment={onDraftComment} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />,
    );

  it("is there when the screen says there is something to post, and not otherwise", () => {
    expect(card(vi.fn())).toContain("Draft comment");
    expect(card()).not.toContain("Draft comment");
  });
});

describe("an investigation with no ticket", () => {
  const ticketless = (state = "done" as RunState, over: Partial<Run> = {}) => run(state, { item: null, result: "Read it.\n\nNew ticket:\nTitle: Add a backoff\nKind: bug\nIt loops.", ...over });
  const proposed = outcome({ note: null, keys: [], ticket: { title: "Add a backoff", kind: "bug", body: "It loops." } });

  it("shows the ticket it proposes and offers to draft it, with no comment or blocker buttons", () => {
    const html = sheet(ticketless(), { outcome: proposed });
    expect(html).toContain("The ticket it proposes");
    expect(html).toContain("Add a backoff");
    expect(html).toContain("It loops.");
    expect(disabled(html, "Draft a ticket from this")).toBe(false);
    for (const gone of ["Draft a Jira comment from this", "Draft a blocker", "Draft with Pip", "Finish with Pip"]) expect(html).not.toContain(gone);
  });

  it("says when the answer had no New ticket section and offers the person-driven draft", () => {
    const html = sheet(ticketless("done", { result: "It is the rounding." }), { outcome: outcome({ note: null, keys: [] }) });
    expect(html).toContain("No &#x27;New ticket:&#x27; section, so this is its whole answer");
    expect(html).toContain("Not parsed");
    expect(html).toContain("It is the rounding.");
    expect(disabled(html, "Draft a ticket from this")).toBe(false);
  });

  it("cannot draft a ticket from nothing", () => {
    const html = sheet(ticketless("done", { result: null }), { outcome: outcome({ note: null, keys: [] }) });
    expect(disabled(html, "Draft a ticket from this")).toBe(true);
    expect(html).toContain("nothing to make a ticket from");
  });

  it("offers Open the draft ticket and Finish with Pip while the draft waits, and no second draft", () => {
    const html = sheet(ticketless(), { outcome: { ...proposed, ticketDraft: { id: "d1", state: { type: "pending" } } } });
    expect(html).toContain("A new ticket is drafted.");
    expect(html).toContain("Nothing is created in Jira until you approve it.");
    expect(disabled(html, "Open the draft ticket")).toBe(false);
    expect(disabled(html, "Finish with Pip")).toBe(false);
    expect(html).not.toContain("Draft a ticket from this");
    expect(disabled(sheet(ticketless(), { outcome: { ...proposed, ticketDraft: { id: "d1", state: { type: "pending" } } }, drafting: true }), "Finish with Pip")).toBe(true);
  });

  it("says which ticket was created, and offers no draft once it was decided", () => {
    const created = sheet(ticketless("done", { createdItem: { connectionId: "mock", externalId: "CA-812", key: "CA-812" } }), { outcome: { ...proposed, ticketDraft: { id: "d1", state: { type: "applied" } } } });
    expect(created).toContain("Ticket CA-812 created from this");
    expect(created).toContain("Open CA-812");
    expect(created).not.toContain("Draft a ticket from this");
    const skipped = sheet(ticketless(), { outcome: { ...proposed, ticketDraft: { id: "d1", state: { type: "skipped" } } } });
    expect(skipped).toContain("You skipped its ticket draft.");
    expect(skipped).not.toContain("Draft a ticket from this");
    expect(sheet(ticketless(), { outcome: { ...proposed, ticketDraft: { id: "d1", state: { type: "retired", reason: "x" } } } })).toContain("out of date");
  });
});
