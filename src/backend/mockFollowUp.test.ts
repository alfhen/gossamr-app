import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";
import { mockAsk } from "./mockPip";
import { SCRIPTED_PLAN_ANSWERED } from "./mockRuns";
import type { ScreenContext } from "../types";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const sample = () => new MockBackend({ runs: { seed: "kinds", epoch: NOW, planDescription: true } });
const planRun = (b: MockBackend) => b.runs.list().find((r) => r.spec.kind === "plan")!;
const followUps = (b: MockBackend) => b.proposals.list().filter((p) => p.intent.type === "followUp");

async function ask(b: MockBackend, prompt: string, item: ScreenContext["item"]) {
  const context = { view: "board", item } as unknown as ScreenContext;
  await mockAsk({ requestId: `r${Math.random()}`, prompt, context, images: [], sessionId: undefined } as never, b, 0);
}

describe("a finished plan run with open questions in the sample build", () => {
  it("is sent back after Pip proposes a follow-up the person approves, goes to Working and finishes again with the questions settled", async () => {
    const b = sample();
    const run = planRun(b);
    expect(run.state).toBe("done");
    await ask(b, "Send it back for another pass to settle the open questions", run.item);
    const [draft] = followUps(b);
    expect(draft.createdBy).toBe("pip");
    if (draft.intent.type !== "followUp") throw new Error("a follow-up");
    expect(draft.intent.runId).toBe(run.id);
    expect(draft.intent.message).toContain("Do the Klaviyo flows read the subject lines");
    expect(b.runs.get(run.id)?.state).toBe("done");

    await b.proposalsEdit(draft.id, { type: "followUp", message: "Settle both questions yourself and say which you chose." });
    await expect(b.proposalsApprove(draft.id)).rejects.toThrow("own button");
    const sent = await b.runsSendFollowUp(draft.id);
    expect(sent.state).toBe("working");
    expect(sent.passes).toBe(2);
    expect(sent.continuedAt).toBeTruthy();
    expect(b.proposals.get(draft.id)?.state.type).toBe("applied");
    const line = b.runs.events(run.id).find((e) => e.kind === "follow_up");
    expect(line?.text).toBe("Pip asked for another pass: the plan left open questions");
    expect(line?.detail).toBe("Pass 2. Approved by you.");

    b.runs.advance(run.id);
    const again = b.runs.get(run.id)!;
    expect(again.state).toBe("done");
    expect(again.result).toBe(SCRIPTED_PLAN_ANSWERED);
    expect(again.result).not.toContain("## Open questions for a person");
    expect(again.passes).toBe(2);
  });

  it("is not sent back twice at once, and a run that did its job is not sent back at all", async () => {
    const b = sample();
    const run = planRun(b);
    await ask(b, "send it back for another pass", run.item);
    await ask(b, "send it back for another pass", run.item);
    expect(followUps(b)).toHaveLength(1);
    const other = b.runs.list().find((r) => r.state === "done" && r.spec.kind === "investigate" && r.item)!;
    await ask(b, "send it back for another pass", other.item);
    expect(followUps(b)).toHaveLength(1);
  });

  it("keeps a follow-up off a run that is working and lets Pip revise its own until the person edits it", async () => {
    const b = sample();
    const run = planRun(b);
    await ask(b, "send it back for another pass", run.item);
    const [draft] = followUps(b);
    b.proposals.pipRevise(draft.id, "Revised message.");
    expect(b.proposals.get(draft.id)?.intent).toMatchObject({ message: "Revised message." });
    await b.proposalsEdit(draft.id, { type: "followUp", message: "Mine." });
    expect(() => b.proposals.pipRevise(draft.id, "Pip again")).toThrow("edited this follow-up");
    await b.runsSendFollowUp(draft.id);
    await expect(b.runs.pipFollowUp(run.id, "More", "x", "r")).rejects.toThrow("can't be sent back");
    await expect(b.runsSendFollowUp(draft.id)).rejects.toThrow("already been decided");
  });
});
