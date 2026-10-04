import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { SCRIPTED_RESULT } from "../backend/mockRuns";
import type { Run, RunOutcome } from "../types";
import { Found, type ResultActions } from "./RunResult";
import { commentWithPipPrompt, descriptionWithPipPrompt } from "./runSheetLogic";

const base: ResultActions = { draftComment: vi.fn(), askPip: vi.fn(), openDraft: vi.fn(), pickBlocker: vi.fn(), cancelBlocker: vi.fn(), draftBlocker: vi.fn(), openChange: vi.fn(), draftTicket: vi.fn(), openTicketDraft: vi.fn(), finishWithPip: vi.fn(), openCreated: vi.fn(), askPipBreakdown: vi.fn(), buildFromPlan: vi.fn(), draftPlanComment: vi.fn(), openPlanDraft: vi.fn(), reviewThis: vi.fn() };
const outcome: RunOutcome = { note: { text: "Size 8.", fromMarker: true }, keys: [], change: null, draft: null, ticket: null, ticketDraft: null, subtasks: [], subtasksDraft: null };
const doneRun = (kind: Run["spec"]["kind"]): Run => {
  const run = new MockBackend().runs.list().find((r) => r.state === "done" && r.item)!;
  return { ...run, spec: { ...run.spec, kind }, result: SCRIPTED_RESULT.triage };
};
const view = (run: Run, on: ResultActions) => renderToStaticMarkup(<Found run={run} outcome={outcome} tickets={[]} pickBlocker={false} drafting={false} on={on} />);

describe("asking Pip for a description update from a finished run", () => {
  it("is offered on a finished Triage once the sheet can send it", () => {
    const on = { ...base, askPipDescription: vi.fn() };
    expect(view(doneRun("triage"), on)).toContain("Draft a description update");
    expect(view(doneRun("triage"), base)).not.toContain("Draft a description update");
    expect(view(doneRun("investigate"), on)).not.toContain("Draft a description update");
  });

  it("sends the run and ticket by name, tells Pip to read first and to keep what the run doesn't change, and carries none of the run's words", () => {
    const prompt = descriptionWithPipPrompt({ id: "run-9", item: { key: "CA-412" } });
    expect(prompt).toContain("description of CA-412");
    expect(prompt).toContain("run run-9");
    for (const needed of ["get_run", "get_run_result", "get_item", "propose_description_edit", "word for word", "Don't say anything has been changed in Jira"]) expect(prompt).toContain(needed);
    expect(prompt).not.toContain(SCRIPTED_RESULT.triage.slice(0, 40));
    expect(prompt).not.toBe(commentWithPipPrompt({ id: "run-9", item: { key: "CA-412" } }));
  });
});
