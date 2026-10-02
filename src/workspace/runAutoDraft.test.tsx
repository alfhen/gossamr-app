import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AskRequest } from "../backend/claude";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { mockAsk, scriptPip } from "../backend/mockPip";
import { jiraNote } from "../backend/mockRunResult";
import { SCRIPTED_RESULT } from "../backend/mockRuns";
import { docFromText, docText } from "../lib/docs";
import type { Backend } from "../backend/types";
import type { Intent, Proposal, Run, RunKind, RunOutcome, RunSpec, ScreenContext } from "../types";
import { toRunEntries } from "./activityLogic";
import { AgentCard } from "./AgentCard";
import { AgentsSettingsView } from "./AgentsSettings";
import { DraftCard } from "./DraftCard";
import { followOutcome } from "./followOutcome";
import { Found } from "./RunResult";
import { commentWithPipPrompt, runDraftOf } from "./runSheetLogic";

const blank: ScreenContext = { view: null, item: null, filter: null, selection: [] };

const spec = (kind: RunKind = "investigate", over: Partial<RunSpec> = {}): RunSpec => ({
  kind,
  repo: "acme/web",
  clonePath: "/Users/sample/Code/web",
  base: "main",
  name: `ca-412-${kind}-ab12`,
  instruction: "Do it.",
  focus: null,
  focusFromRun: null,
  ticketBlock: "CA-412: sample",
  ...over,
});

async function finished(backend: MockBackend, kind: RunKind = "investigate", item: ReturnType<typeof itemRef> | null = itemRef("CA-412")): Promise<Run> {
  const intent: Intent = { type: "startRun", connectionId: "mock", item, spec: spec(kind, kind === "review" ? { pr: 331, prSha: "a1b2c3d4e5f6" } : {}) };
  const p = await backend.proposalsCreate(intent);
  const queued = await backend.runsApprove(p.id, (await backend.runsReview(p.id)).digest);
  for (let i = 0; i < 4; i++) backend.runs.advance(queued.id);
  return (await backend.runsGet(queued.id))!;
}

const commentsOf = (backend: MockBackend, run: Run) => backend.proposals.list().filter((p) => p.origin.type === "run" && p.origin.runId === run.id && p.intent.type === "comment");

describe("the sample backend drafts a comment when a run finishes", () => {
  it("does it for every kind that has a ticket, from the For Jira section, and posts nothing", async () => {
    for (const kind of ["investigate", "triage", "verify", "build"] as const) {
      const backend = new MockBackend({ runs: { seed: "empty" } });
      const run = await finished(backend, kind);
      expect(run.state).toBe("done");
      expect(run.result).toContain("For Jira:");
      const [draft] = commentsOf(backend, run);
      expect(draft, kind).toBeDefined();
      expect(draft).toMatchObject({ state: { type: "pending" }, createdBy: "user", origin: { type: "run", runId: run.id } });
      expect((await backend.runsOutcome(run.id)).draft).toEqual({ id: draft.id, state: { type: "pending" } });
    }
  });

  it("scripts a For Jira section for every kind, review included", () => {
    for (const kind of ["investigate", "triage", "verify", "build", "review"] as const) {
      expect(jiraNote(SCRIPTED_RESULT[kind]), kind).toMatchObject({ fromMarker: true });
    }
  });

  it("makes one, even when the run is advanced again, and none for a run with no ticket", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const run = await finished(backend);
    backend.runs.advance(run.id);
    expect(commentsOf(backend, run)).toHaveLength(1);
    const [draft] = commentsOf(backend, run);
    await backend.proposalsSkip(draft.id);
    expect((await backend.runsOutcome(run.id)).draft?.state.type).toBe("skipped");
    expect(commentsOf(backend, run)).toHaveLength(1);

    const none = new MockBackend({ runs: { seed: "empty" } });
    const noTicket = await finished(none, "investigate", null);
    expect(commentsOf(none, noTicket)).toHaveLength(0);
  });

  it("keeps the button path for a run whose result has no For Jira section", async () => {
    const backend = new MockBackend();
    const plain = backend.runs.list().find((r) => r.state === "done" && !r.result?.includes("For Jira"))!;
    expect(commentsOf(backend, plain)).toHaveLength(0);
    expect((await backend.runsOutcome(plain.id)).draft).toBeNull();
    expect((await backend.runsDraftComment(plain.id)).intent.type).toBe("comment");
  });

  it("stops when the setting is off", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    expect((await backend.runsSettings()).draftOnFinish).toBe(true);
    await backend.runsSetSettings({ ...(await backend.runsSettings()), draftOnFinish: false });
    const run = await finished(backend);
    expect(commentsOf(backend, run)).toHaveLength(0);
  });
});

describe("following a run's outcome", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("re-reads it when a draft is skipped elsewhere, and stops after it is unsubscribed", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const run = await finished(backend);
    const [draft] = commentsOf(backend, run);
    const seen: (string | null)[] = [];
    const stop = followOutcome(backend, run.id, (o) => seen.push(o.draft?.state.type ?? null));
    await settle();
    expect(seen).toEqual(["pending"]);

    await backend.proposalsSkip(draft.id);
    await settle();
    expect(seen[seen.length - 1]).toBe("skipped");

    stop();
    const count = seen.length;
    await backend.runsDraftComment(run.id);
    await settle();
    expect(seen).toHaveLength(count);
  });
});

describe("following a run's outcome out of order", () => {
  it("ignores a slow earlier read that finishes after a newer one", async () => {
    const later = (state: "pending" | "skipped") => ({ note: null, keys: [], change: null, draft: { id: "d1", state: { type: state } }, ticket: null, ticketDraft: null, subtasks: [], subtasksDraft: null }) as RunOutcome;
    const waiting: ((o: RunOutcome) => void)[] = [];
    let changed = () => {};
    const backend = {
      runsOutcome: () => new Promise<RunOutcome>((resolve) => waiting.push(resolve)),
      onDevLinksChanged: () => () => {},
      onProposalsChanged: (cb: () => void) => ((changed = cb), () => {}),
    } as unknown as Backend;
    const seen: string[] = [];
    followOutcome(backend, "r1", (o) => seen.push(o.draft?.state.type ?? "none"));
    changed();
    expect(waiting).toHaveLength(2);
    waiting[1](later("skipped"));
    await Promise.resolve();
    await Promise.resolve();
    waiting[0](later("pending"));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["skipped"]);
  });
});

describe("the sample Pip", () => {
  async function withDraft() {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const run = await finished(backend);
    const [draft] = commentsOf(backend, run);
    return { backend, run, draft };
  }

  it("reads the run and the draft when asked to discuss them and changes nothing", async () => {
    const { backend, run, draft } = await withDraft();
    const prompt = commentWithPipPrompt(run, draft.id);
    const script = scriptPip(prompt, blank, [], [run], Date.now(), backend.proposals.list());
    expect(script.steps).toContain("Read the rest of its result");
    expect(script.revise ?? null).toBeNull();
    expect(script.draft).toBeNull();
    expect(script.text).toContain(draft.id);
  });

  it("revises the draft the run left when asked, keeping it a draft the person approves", async () => {
    const { backend, run, draft } = await withDraft();
    const before = draft.intent.type === "comment" ? docText(draft.intent.body) : "";
    const req: AskRequest = { requestId: "req-1", prompt: "make it shorter", context: { ...blank, item: run.item }, sessionId: null };
    await mockAsk(req, backend, 0);
    const after = backend.proposals.get(draft.id)!;
    expect(after.state.type).toBe("pending");
    expect(after.createdBy).toBe("user");
    expect(after.intent.type === "comment" && docText(after.intent.body)).not.toBe(before);
    expect(after.revisions[after.revisions.length - 1]?.note).toBe("Revised by Pip");
    expect(backend.proposals.list({ states: ["applied"] }).filter((p) => p.intent.type === "comment")).toHaveLength(0);
  });

  it("revises only the draft that was discussed when two are waiting on the same ticket", async () => {
    const { backend, run, draft: again } = await withDraft();
    const other = backend.proposals.fromRun({ type: "comment", item: run.item!, body: docFromText("Another note.\n\nSecond paragraph.") }, null, { type: "run", runId: run.id, shortId: null });
    expect(backend.proposals.list({ states: ["pending"] }).map((p) => p.id).sort()).toEqual([again.id, other.id].sort());
    const ctx = { ...blank, item: run.item };
    const waiting = backend.proposals.list();

    const unclear = scriptPip("make it shorter", ctx, [], [run], Date.now(), waiting);
    expect(unclear.revise ?? null).toBeNull();
    expect(unclear.text).toContain("Which comment draft");

    const chosen = scriptPip("make it shorter", ctx, [], [run], Date.now(), waiting, other.id);
    expect(chosen.revise?.id).toBe(other.id);
    expect(scriptPip("make it shorter", ctx, [], [run], Date.now(), waiting, again.id).revise?.id).toBe(again.id);

    const talk = scriptPip(commentWithPipPrompt(run, other.id), ctx, [], [run], Date.now(), waiting);
    expect(talk.discussed).toBe(other.id);
  });

  it("revises the only waiting draft without being told which only when it is on the open ticket", async () => {
    const { backend, run } = await withDraft();
    const waiting = backend.proposals.list();
    const asks = (item: ScreenContext["item"]) => scriptPip("make it shorter", { ...blank, item }, [], [run], Date.now(), waiting);
    expect(asks(run.item).revise?.id).toBe(waiting[0].id);
    for (const elsewhere of [itemRef("CA-999"), { ...run.item!, connectionId: "another" }, null]) {
      const script = asks(elsewhere);
      expect(script.revise ?? null).toBeNull();
      expect(script.text).toContain("Which comment draft");
    }
    const chosen = scriptPip("make it shorter", { ...blank, item: itemRef("CA-999") }, [], [run], Date.now(), waiting, waiting[0].id);
    expect(chosen.revise?.id, "an explicit choice still works anywhere").toBe(waiting[0].id);
  });

  it("remembers the discussed draft across the turns of one conversation", async () => {
    const { backend, run } = await withDraft();
    const other = backend.proposals.fromRun({ type: "comment", item: run.item!, body: docFromText("Another note.\n\nSecond paragraph.") }, null, { type: "run", runId: run.id, shortId: null });
    const before = (id: string) => {
      const { intent } = backend.proposals.get(id)!;
      return intent.type === "comment" ? docText(intent.body) : "";
    };
    const mine = before(other.id);
    const [first] = backend.proposals.list({ states: ["pending"] }).filter((p) => p.id !== other.id);
    const keptFirst = before(first.id);
    await mockAsk({ requestId: "t1", prompt: commentWithPipPrompt(run, other.id), context: { ...blank, item: run.item }, sessionId: "conv-1" }, backend, 0);
    await mockAsk({ requestId: "t2", prompt: "make it shorter", context: { ...blank, item: run.item }, sessionId: "conv-1" }, backend, 0);
    expect(before(other.id)).not.toBe(mine);
    expect(before(first.id)).toBe(keptFirst);
  });

  it("will not revise a draft the person typed or one that was decided", async () => {
    const { backend, draft } = await withDraft();
    const typed = await backend.proposalsCreate({ type: "comment", item: itemRef("CA-412"), body: { blocks: [{ type: "paragraph", children: [{ type: "text", text: "mine" }] }] } as never });
    expect(() => backend.proposals.pipRevise(typed.id, "hijacked")).toThrow(/wasn't made by Pip/);
    await backend.proposalsSkip(draft.id);
    expect(() => backend.proposals.pipRevise(draft.id, "late")).toThrow(/skipped/);
    expect(scriptPip("make it shorter", { ...blank, item: itemRef("CA-412") }, [], [], Date.now(), backend.proposals.list()).revise ?? null).toBeNull();
  });
});

describe("what the person sees", () => {
  const pending = (over: Partial<Proposal> = {}): Proposal => ({
    id: "d1",
    createdAt: "2026-09-30T12:00:00Z",
    updatedAt: "2026-09-30T12:00:00Z",
    origin: { type: "run", runId: "r1", shortId: "ab12cd34" },
    createdBy: "user",
    intent: { type: "comment", item: itemRef("CA-412"), body: { blocks: [] } as never },
    label: null,
    basis: null,
    state: { type: "pending" },
    revisions: [],
    created: [],
    error: null,
    run: null,
    ...over,
  });

  it("names the run and the draft so Pip can read both, and sends no text of either", () => {
    const run = { id: "r1", item: itemRef("CA-412") };
    const discuss = commentWithPipPrompt(run, "d1");
    expect(discuss).toContain("draft d1");
    expect(discuss).toContain("agent run r1");
    expect(discuss).toContain("get_run_result");
    expect(discuss).toContain("Edit the draft only if I ask");
    const make = commentWithPipPrompt(run);
    expect(make).toContain("Draft a Jira comment from run r1");
    expect(make).toContain("get_run_result");
    expect(make).not.toContain("draft d1");
  });

  it("finds only a waiting comment draft of that run", () => {
    expect(runDraftOf([pending()], "r1")?.id).toBe("d1");
    expect(runDraftOf([pending()], "other")).toBeUndefined();
    expect(runDraftOf([pending({ state: { type: "skipped" } })], "r1")).toBeUndefined();
    expect(runDraftOf([pending({ origin: { type: "board" } })], "r1")).toBeUndefined();
  });

  it("offers Discuss with Pip on a comment from a run, and not on any other", () => {
    const props = { statusName: null, people: [], working: false, error: null, onApprove: vi.fn(), onSkip: vi.fn() };
    const html = (p: Proposal, onDiscuss?: () => void) => renderToStaticMarkup(<DraftCard proposal={p} onDiscuss={onDiscuss} {...props} />);
    expect(html(pending(), vi.fn())).toContain("Discuss with Pip");
    expect(html(pending())).not.toContain("Discuss with Pip");
    expect(html(pending({ state: { type: "skipped" } }), vi.fn())).not.toContain("Discuss with Pip");
  });

  it("shows the draft on the run sheet with Open the draft and Discuss with Pip instead of drafting again", () => {
    const run = new MockBackend().runs.list().find((r) => r.state === "done" && r.item)!;
    const on = { draftComment: vi.fn(), askPip: vi.fn(), pickBlocker: vi.fn(), cancelBlocker: vi.fn(), draftBlocker: vi.fn(), openChange: vi.fn(), openDraft: vi.fn(), draftTicket: vi.fn(), openTicketDraft: vi.fn(), finishWithPip: vi.fn(), openCreated: vi.fn(), askPipBreakdown: vi.fn() };
    const view = (draft: { id: string; state: Proposal["state"] } | null) =>
      renderToStaticMarkup(<Found run={run} outcome={{ note: { text: "Do x.", fromMarker: true }, keys: [], change: null, draft, ticket: null, ticketDraft: null, subtasks: [], subtasksDraft: null }} tickets={[]} pickBlocker={false} drafting={false} on={on} />);
    const waiting = view({ id: "d1", state: { type: "pending" } });
    expect(waiting).toContain("Open the draft");
    expect(waiting).toContain("Discuss with Pip");
    expect(waiting).not.toContain("Draft a Jira comment from this");
    expect(waiting).toContain(`A comment is drafted on ${run.item?.key}`);
    const skipped = view({ id: "d1", state: { type: "skipped" } });
    expect(skipped).toContain("You skipped its comment draft.");
    expect(skipped).toContain("Draft a Jira comment from this");
    expect(view(null)).toContain("Draft with Pip");
  });

  it("marks a finished run's card and its Activity row when a draft is waiting", () => {
    const run = new MockBackend().runs.list().find((r) => r.state === "done" && r.item)!;
    const card = (draftReady: boolean) =>
      renderToStaticMarkup(<AgentCard run={run} now={Date.now()} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} onDraftComment={vi.fn()} onOpenDraft={vi.fn()} draftReady={draftReady} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    expect(card(true)).toContain("Draft ready");
    expect(card(true)).not.toContain("Draft comment<");
    expect(card(false)).toContain("Draft comment");
    const row = (drafted: Set<string>) => toRunEntries([run], new Set(), Date.now(), drafted).find((e) => e.kind === "finished")!;
    expect(row(new Set([run.id])).text).toContain(`Draft ready on ${run.item?.key}.`);
    expect(row(new Set()).text).not.toContain("Draft ready");
    expect(row(new Set([run.id])).id).toBe(row(new Set()).id);
  });

  it("has the setting in the safety sheet's limits, on by default", () => {
    const settings = { maxRuns: 3, wallClockMinutes: 60, tokenCap: 3_000_000, terminal: "terminal" as const, draftOnFinish: true };
    const html = renderToStaticMarkup(<AgentsSettingsView runs={[]} stopping={false} keepRunning={0} settings={settings} cleanup={null} onSettings={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain("Draft a Jira comment when an agent finishes");
    expect(html).toMatch(/<input type="checkbox"[^>]*checked/);
  });
});
