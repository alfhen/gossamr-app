import { describe, expect, it } from "vitest";
import { workstreamConversation } from "../lib/conversations";
import { MockBackend } from "./mock";
import { mockAsk } from "./mockPip";
import { SCRIPTED_PLAN_ANSWERED } from "./mockRuns";
import type { ScreenContext } from "../types";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const sample = () => new MockBackend({ runs: { seed: "kinds", epoch: NOW, planDescription: true } });
const planRun = (b: MockBackend) => b.runs.list().find((r) => r.spec.role === "planner")!;

async function ask(b: MockBackend, prompt: string, item: ScreenContext["item"], conversation?: string) {
  const context = { view: "board", item } as unknown as ScreenContext;
  await mockAsk({ requestId: `r${Math.random()}`, prompt, context, images: [], sessionId: undefined, conversation } as never, b, 0);
}

/** The plan run of the sample, put in a workstream on its ticket, where Pip knows it as R1. */
function inWorkstream(b: MockBackend) {
  const run = planRun(b);
  const ws = b.workstreams.open(run.item);
  b.runs.setWorkstream(run.id, ws.id);
  return { run, conversation: workstreamConversation(ws.id) };
}

describe("a finished plan run with open questions in the sample build", () => {
  it("is woken by Pip's message, goes to Working and finishes again with the questions settled", async () => {
    const b = sample();
    const { run, conversation } = inWorkstream(b);
    expect(run.state).toBe("done");
    await ask(b, "tell R1 to settle both open questions yourself and say which you chose", run.item, conversation);
    const woken = b.runs.get(run.id)!;
    expect(woken).toMatchObject({ state: "working", passes: 2 });
    expect(woken.continuedAt).toBeTruthy();
    expect(b.proposals.list().filter((p) => p.intent.type === "followUp")).toEqual([]);
    expect(b.runs.events(run.id).find((e) => e.kind === "follow_up")).toMatchObject({ text: "Pip sent a message", detail: "Pass 2." });

    b.runs.advance(run.id);
    const again = b.runs.get(run.id)!;
    expect(again.state).toBe("done");
    expect(again.result).toBe(SCRIPTED_PLAN_ANSWERED);
    expect(again.result).not.toContain("## Open questions for a person");
    expect(again.passes).toBe(2);
    expect(again.summary).not.toContain("open questions");
  });

  it("is not messaged while it works, and Pip says why when a message is refused", async () => {
    const b = sample();
    const { run, conversation } = inWorkstream(b);
    await ask(b, "tell R1 to carry on", run.item, conversation);
    expect(b.runs.get(run.id)?.state).toBe("working");
    // Working now: the message waits for its next question instead of waking it again.
    await ask(b, "tell R1 to skip the tests", run.item, conversation);
    expect(b.runs.get(run.id)).toMatchObject({ state: "working", passes: 2 });
    expect(b.runs.queuedMessage(run.id)).toBe("skip the tests");
  });
});
