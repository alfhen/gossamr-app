import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { scriptPip } from "../backend/mockPip";
import { jiraNote, subtaskProposals } from "../backend/mockRunResult";
import { SCRIPTED_RESULT } from "../backend/mockRuns";
import subtaskFixtures from "../../src-tauri/test-fixtures/agents/subtask-results.json";
import type { Intent, Proposal, Run, RunKind, RunOutcome, RunSpec, ScreenContext } from "../types";
import { toRunEntries } from "./activityLogic";
import { AgentCard } from "./AgentCard";
import { Found, type ResultActions } from "./RunResult";
import { breakdownStatus, breakdownTarget, breakdownWithPipPrompt, pendingBreakdownOn, runBreakdownDraftOf } from "./runSheetLogic";

const blank: ScreenContext = { view: null, item: null, filter: null, selection: [] };

const spec = (kind: RunKind): RunSpec => ({ kind, repo: "acme/web", clonePath: "/Users/sample/Code/web", base: "main", name: `ca-412-${kind}-ab12`, instruction: "Do it.", focus: null, focusFromRun: null, ticketBlock: "CA-412: sample" });

async function finished(backend: MockBackend, kind: RunKind, item: ReturnType<typeof itemRef> | null = itemRef("CA-412")): Promise<Run> {
  const intent: Intent = { type: "startRun", connectionId: "mock", item, spec: spec(kind) };
  const p = await backend.proposalsCreate(intent);
  const queued = await backend.runsApprove(p.id, (await backend.runsReview(p.id)).digest);
  for (let i = 0; i < 4; i++) backend.runs.advance(queued.id);
  return (await backend.runsGet(queued.id))!;
}

const subtasksOf = (backend: MockBackend, run: Run) => backend.proposals.list().filter((p) => p.origin.type === "run" && p.origin.runId === run.id && p.intent.type === "subtasks");

describe("the sample parser agrees with the shared subtask fixtures it can read", () => {
  const plain = subtaskFixtures.filter((c) => !/hostile/.test(c.name));
  it.each(plain.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(subtaskProposals(c.input)).toEqual(c.expected);
  });

  it("reads a negative answer as no breakdown", () => {
    for (const no of ["No subtasks needed.", "None", "N/A", "Not applicable here", "No breakdown: it fits", "- No need to split this"]) {
      expect(subtaskProposals(`Subtasks:\n${no.startsWith("-") ? no : `- ${no}`}`), no).toEqual([]);
    }
    expect(subtaskProposals("Subtasks:\nNo subtasks needed.\n\nFor Jira: one piece.")).toEqual([]);
    expect(subtaskProposals("Subtasks:\n- None of the retries back off: add a cap")).toHaveLength(1);
  });

  it("is not read out of the For Jira note", () => {
    const result = SCRIPTED_RESULT.triage;
    expect(subtaskProposals(result)).toHaveLength(4);
    expect(jiraNote(result).text).not.toContain("Cache the carrier rates");
    expect(jiraNote(result).text).toContain("breakdown");
  });
});

describe("the sample backend proposes a breakdown when a Triage finishes", () => {
  it("drafts the subtasks beside the comment, from the run, and creates nothing", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const run = await finished(backend, "triage");
    const [draft] = subtasksOf(backend, run);
    expect(draft).toMatchObject({ state: { type: "pending" }, createdBy: "user", origin: { type: "run", runId: run.id } });
    expect(draft.intent).toMatchObject({ type: "subtasks", parent: { key: "CA-412" } });
    const outcome = await backend.runsOutcome(run.id);
    expect(outcome.subtasks).toHaveLength(4);
    expect(outcome.subtasksDraft).toEqual({ id: draft.id, state: { type: "pending" } });
    expect(outcome.draft?.state.type).toBe("pending");
  });

  it("makes one even when advanced again, and none after it was skipped", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const run = await finished(backend, "triage");
    backend.runs.advance(run.id);
    expect(subtasksOf(backend, run)).toHaveLength(1);
    await backend.proposalsSkip(subtasksOf(backend, run)[0].id);
    backend.runs.advance(run.id);
    expect(subtasksOf(backend, run)).toHaveLength(1);
    expect((await backend.runsOutcome(run.id)).subtasksDraft?.state.type).toBe("skipped");
  });

  it("makes none for the other kinds, and none when the setting is off", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    for (const kind of ["investigate", "verify", "build"] as const) {
      const run = await finished(backend, kind);
      expect(subtasksOf(backend, run), kind).toHaveLength(0);
      expect((await backend.runsOutcome(run.id)).subtasks).toEqual([]);
    }
    await backend.runsSetSettings({ ...(await backend.runsSettings()), draftOnFinish: false });
    const off = await finished(backend, "triage");
    expect(subtasksOf(backend, off)).toHaveLength(0);
    expect((await backend.runsOutcome(off.id)).subtasks).toHaveLength(4);
  });

  it("lets Pip revise only the summaries of a pending breakdown a run left, never one the person made", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const run = await finished(backend, "triage");
    const [left] = subtasksOf(backend, run);
    const revised = await backend.pipRevise(left.id, { summaries: ["Only one", "  ", "Two"], body: "ignored" });
    expect((revised as Proposal).intent).toMatchObject({ type: "subtasks", parent: { key: "CA-412" }, summaries: ["Only one", "Two"] });
    expect((revised as Proposal).revisions[(revised as Proposal).revisions.length - 1]?.note).toBe("Revised by Pip");
    await expect(backend.pipRevise(left.id, { summaries: ["", " "] })).rejects.toThrow("at least one subtask");

    const mine = await backend.proposalsCreate({ type: "subtasks", parent: itemRef("CA-412"), summaries: ["by hand"] });
    await expect(backend.pipRevise(mine.id, { summaries: ["hijacked"] })).rejects.toThrow("wasn't made by Pip");
    await backend.proposalsSkip(left.id);
    await expect(backend.pipRevise(left.id, { summaries: ["late"] })).rejects.toThrow();
  });
});

describe("Pip and a breakdown in the sample", () => {
  const draftOf = async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const run = await finished(backend, "triage");
    return { run, draft: subtasksOf(backend, run)[0], backend };
  };

  it("discusses the draft it is named, then cuts it to the three that matter when asked for fewer", async () => {
    const { run, draft } = await draftOf();
    const first = scriptPip(breakdownWithPipPrompt(run, draft.id), blank, [], [run], Date.now(), [draft]);
    expect(first.discussed).toBe(draft.id);
    expect(first.revise).toBeUndefined();
    const second = scriptPip("fewer please", blank, [], [run], Date.now(), [draft], draft.id);
    expect(second.revise).toEqual({ id: draft.id, summaries: (draft.intent as Extract<Intent, { type: "subtasks" }>).summaries.slice(0, 3) });
  });

  it("discusses and trims a breakdown Pip drafted itself, but not one the person made by hand", async () => {
    const { run, backend } = await draftOf();
    const pips = await backend.pipDraft({ type: "subtasks", parent: itemRef("CA-412"), summaries: ["One", "Two", "Three", "Four"] }, null, "q1");
    const talk = scriptPip(breakdownWithPipPrompt(run, (pips as Proposal).id), blank, [], [run], Date.now(), [pips as Proposal]);
    expect(talk.discussed).toBe((pips as Proposal).id);
    const trimmed = scriptPip("fewer", blank, [], [run], Date.now(), [pips as Proposal], (pips as Proposal).id);
    expect(trimmed.revise).toEqual({ id: (pips as Proposal).id, summaries: ["One", "Two", "Three"] });
    const mine = await backend.proposalsCreate({ type: "subtasks", parent: itemRef("CA-412"), summaries: ["by hand"] });
    expect(scriptPip(breakdownWithPipPrompt(run, mine.id), blank, [], [run], Date.now(), [mine]).text).toContain("can't find that breakdown draft");
  });

  it("shortens the wording of every summary when asked for shorter, and only cuts the list when asked for fewer", async () => {
    const { run, draft } = await draftOf();
    const all = (draft.intent as Extract<Intent, { type: "subtasks" }>).summaries;
    for (const ask of ["shorter please", "can you shorten these", "tighten it"]) {
      const out = scriptPip(ask, blank, [], [run], Date.now(), [draft], draft.id);
      const summaries = out.revise?.summaries ?? [];
      expect(summaries, ask).toHaveLength(all.length);
      expect(summaries.every((t, i) => t.length <= all[i].length && t.split(" ").length <= 6), ask).toBe(true);
      expect(out.text).toContain("kept them all");
    }
    for (const ask of ["fewer", "merge a couple", "combine them"]) {
      expect(scriptPip(ask, blank, [], [run], Date.now(), [draft], draft.id).revise?.summaries, ask).toEqual(all.slice(0, 3));
    }
  });

  it("drafts the breakdown itself when asked to and there is none, and says so when the run proposes none", async () => {
    const { run, backend } = await draftOf();
    const asked = scriptPip(breakdownWithPipPrompt(run), blank, [], [run], Date.now(), []);
    expect(asked.draft?.intent).toMatchObject({ type: "subtasks", parent: { key: "CA-412" } });
    const plain = await finished(backend, "investigate");
    const none = scriptPip(breakdownWithPipPrompt(plain), blank, [], [plain], Date.now(), []);
    expect(none.draft).toBeNull();
    expect(none.text).toContain("one piece");
  });

  it("names the run and the draft in the prompt and never carries the result", async () => {
    const { run, draft } = await draftOf();
    const prompt = breakdownWithPipPrompt(run, draft.id);
    expect(prompt).toContain(draft.id);
    expect(prompt).toContain(run.id);
    expect(prompt).not.toContain("Cache the carrier rates");
  });
});

describe("the breakdown on the sheet, the card and Activity", () => {
  const on: ResultActions = { draftComment: vi.fn(), askPip: vi.fn(), openDraft: vi.fn(), pickBlocker: vi.fn(), cancelBlocker: vi.fn(), draftBlocker: vi.fn(), openChange: vi.fn(), draftTicket: vi.fn(), openTicketDraft: vi.fn(), finishWithPip: vi.fn(), openCreated: vi.fn(), askPipBreakdown: vi.fn() };
  const triage = (): Run => ({ ...new MockBackend().runs.list().find((r) => r.state === "done" && r.item)!, result: SCRIPTED_RESULT.triage });
  const outcome = (over: Partial<RunOutcome>): RunOutcome => ({ note: { text: "Size 8.", fromMarker: true }, keys: [], change: null, draft: null, ticket: null, ticketDraft: null, subtasks: ["First", "Second"], subtasksDraft: null, ...over });
  const view = (o: RunOutcome) => renderToStaticMarkup(<Found run={triage()} outcome={o} tickets={[]} pickBlocker={false} drafting={false} on={on} />);

  it("lists the proposal with Open the draft and Discuss with Pip while it waits", () => {
    const html = view(outcome({ subtasksDraft: { id: "s1", state: { type: "pending" } } }));
    expect(html).toContain("The breakdown it proposes");
    expect(html).toContain("<li>First</li>");
    expect(html).toContain("A breakdown is drafted on");
    expect(html).toMatch(/data-breakdown="waiting"/);
    expect(html.match(/Open the draft/g)).toHaveLength(1);
    expect(html.match(/Discuss with Pip/g)).toHaveLength(1);
  });

  it("offers Draft with Pip when it was never drafted, and says what became of a decided one", () => {
    expect(view(outcome({}))).toContain("It isn&#x27;t drafted");
    const none = view(outcome({}));
    expect(none.match(/Draft with Pip/g)).toHaveLength(2);
    expect(view(outcome({ subtasksDraft: { id: "s1", state: { type: "skipped" } } }))).toContain("You skipped its breakdown.");
    expect(view(outcome({ subtasksDraft: { id: "s1", state: { type: "applied" } } }))).toContain("Its subtasks were created.");
    expect(view(outcome({ subtasksDraft: { id: "s1", state: { type: "retired", reason: "x" } as never } }))).toContain("out of date");
  });

  it("points at a breakdown that waits on the ticket but came from nobody's run, such as Pip's", () => {
    const html = renderToStaticMarkup(<Found run={triage()} outcome={outcome({})} tickets={[]} pickBlocker={false} waitingBreakdown drafting={false} on={on} />);
    expect(html).toContain("A breakdown is already waiting on");
    expect(html).not.toContain("It isn&#x27;t drafted");
    expect(html.match(/Open the draft/g)).toHaveLength(1);
    const decided = renderToStaticMarkup(<Found run={triage()} outcome={outcome({ subtasksDraft: { id: "s1", state: { type: "skipped" } } })} tickets={[]} pickBlocker={false} waitingBreakdown drafting={false} on={on} />);
    expect(decided).not.toContain("already waiting");
  });

  it("finds a pending breakdown on a ticket whatever its origin, and only on that ticket", () => {
    const item = itemRef("CA-412");
    const made = (id: string, key: string, state: "pending" | "skipped", type: "subtasks" | "comment" = "subtasks") =>
      ({ id, createdAt: id, state: { type: state }, origin: { type: "chat", requestId: "q" }, intent: { type, parent: itemRef(key) } }) as unknown as Proposal;
    const all = [made("a", "CA-412", "skipped"), made("b", "CA-412", "pending"), made("c", "CA-9", "pending"), made("d", "CA-412", "pending", "comment")];
    expect(pendingBreakdownOn(all, item)?.id).toBe("b");
    expect(pendingBreakdownOn(all, itemRef("CA-1"))).toBeUndefined();
    expect(pendingBreakdownOn(all, null)).toBeUndefined();
  });

  it("shows nothing for a run that proposes no breakdown", () => {
    expect(view(outcome({ subtasks: [] }))).not.toContain("breakdown it proposes");
    expect(breakdownStatus(null)).toBe("none");
  });

  it("finds only a pending breakdown of that run", () => {
    const draft = (id: string, runId: string, state: "pending" | "skipped", type: "subtasks" | "comment" = "subtasks") =>
      ({ id, createdAt: id, state: { type: state }, origin: { type: "run", runId, shortId: null }, intent: { type } }) as unknown as Proposal;
    const all = [draft("a", "r1", "skipped"), draft("b", "r1", "pending"), draft("c", "r2", "pending"), draft("d", "r1", "pending", "comment")];
    expect(runBreakdownDraftOf(all, "r1")?.id).toBe("b");
    expect(runBreakdownDraftOf(all, "r3")).toBeUndefined();
  });

  it("sends the chip to the breakdown's own ticket even when a comment draft waits too", () => {
    const parent = itemRef("CA-412");
    const comment = { id: "c", createdAt: "2", state: { type: "pending" }, origin: { type: "run", runId: "r1", shortId: null }, intent: { type: "comment", item: itemRef("CA-1") } } as unknown as Proposal;
    const breakdown = { id: "s", createdAt: "1", state: { type: "pending" }, origin: { type: "run", runId: "r1", shortId: null }, intent: { type: "subtasks", parent } } as unknown as Proposal;
    expect(breakdownTarget([comment, breakdown], "r1")).toEqual(parent);
    expect(breakdownTarget([comment], "r1")).toBeNull();
    const only = renderToStaticMarkup(<AgentCard run={triage()} now={Date.now()} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} onOpenDraft={vi.fn()} draftReady breakdownReady failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    expect(only, "the chip needs its own handler").not.toContain("Breakdown proposed");
  });

  it("puts a chip on the card and 'Breakdown proposed on KEY' in Activity", () => {
    const run = triage();
    const card = (breakdownReady: boolean) =>
      renderToStaticMarkup(<AgentCard run={run} now={Date.now()} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} onOpenDraft={vi.fn()} onOpenBreakdown={vi.fn()} draftReady breakdownReady={breakdownReady} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    expect(card(true)).toContain("Breakdown proposed");
    expect(card(true)).toContain("Draft ready");
    expect(card(false)).not.toContain("Breakdown proposed");
    const row = (breakdown: Set<string>) => toRunEntries([run], new Set(), Date.now(), new Set([run.id]), breakdown).find((e) => e.kind === "finished")!;
    expect(row(new Set([run.id])).text).toContain(`Breakdown proposed on ${run.item?.key}.`);
    expect(row(new Set()).text).toContain(`Draft ready on ${run.item?.key}.`);
    expect(row(new Set([run.id])).id).toBe(row(new Set()).id);
  });
});
