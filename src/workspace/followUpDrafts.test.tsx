import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import type { Proposal, Run } from "../types";
import { withoutRunDrafts, targetOf } from "../lib/proposals";
import { DraftCard, draftSummary, draftTitle } from "./DraftCard";
import { DraftPreview, draftPreviewBody } from "./DraftPreview";
import { FOLLOW_UP_LIMIT, followUpBlocker, followUpProblem, nextPass } from "./followUp";

const followUp = (over: Partial<Proposal> = {}): Proposal => ({
  id: "f1",
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  origin: { type: "chat", requestId: "r1" },
  createdBy: "pip",
  intent: { type: "followUp", connectionId: "mock", runId: "run-123456789", shortId: "ab12cd34", item: itemRef("CA-412"), message: "Settle the two open questions.", reason: "the plan left open questions" },
  label: null,
  basis: null,
  state: { type: "pending" },
  revisions: [],
  created: [],
  error: null,
  run: null,
  ...over,
});

const props = { proposal: followUp(), statusName: null, people: [], working: false, error: null, onApprove: vi.fn(), onSkip: vi.fn() };

describe("a follow-up draft", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  });

  it("is named for the run, belongs to its ticket and is kept off screens that only approve through the tracker", () => {
    const p = followUp();
    expect(draftTitle(p)).toBe("Follow-up for run ab12cd34");
    expect(draftSummary(p, null)).toBe("the plan left open questions");
    expect(targetOf(p.intent)?.key).toBe("CA-412");
    expect(withoutRunDrafts([p])).toEqual([]);
    expect(draftTitle(followUp({ intent: { ...(p.intent as object), shortId: null } as Proposal["intent"] }))).toBe("Follow-up for run run-1234");
  });

  it("shows the pass, the reason, the whole editable message and a prominent Send back, and nothing that applies it elsewhere", () => {
    const out = renderToStaticMarkup(<DraftCard {...props} pass={3} />);
    expect(out).toContain("Pass 3");
    expect(out).toContain("Proposed by Pip");
    expect(out).toContain("Why: the plan left open questions");
    expect(out).toContain("<textarea");
    expect(out).toContain("Settle the two open questions.");
    expect(out).toContain("Nothing is sent before you press Send back.");
    expect(out).toContain("Send back");
    expect(out).toContain("Skip");
    for (const label of ["Apply", "Post comment", "Review and start"]) expect(out).not.toContain(label);
  });

  it("is read-only once decided and says what happened", () => {
    const sent = renderToStaticMarkup(<DraftCard {...props} proposal={followUp({ state: { type: "applied" } })} />);
    expect(sent).toContain("Sent back.");
    expect(sent).toContain("disabled");
    expect(sent).not.toContain("Send back</button>");
  });

  it("previews the message in full with its pass and opens for review", () => {
    const p = followUp();
    const body = draftPreviewBody(p, null, 2);
    expect(body).toContain("another pass (pass 2)");
    expect(body).toContain("Settle the two open questions.");
    expect(body).toContain("Nothing is sent until you read this and send it.");
    const out = renderToStaticMarkup(<DraftPreview proposal={p} statusName={null} targetTitle="Fix the cart" pass={2} onOpen={() => {}} />);
    expect(out).toContain("Review and send back");
  });
});

describe("follow-up rules the page mirrors", () => {
  const run = (over: Partial<Run>) => ({ id: "r", state: "done", shortId: "ab12cd34", sessionId: "s", ...over }) as Run;

  it("counts the pass the agent would be on", () => {
    expect(nextPass(undefined)).toBe(2);
    expect(nextPass({ passes: 1 })).toBe(2);
    expect(nextPass({ passes: 4 })).toBe(5);
  });

  it("allows a finished run, or one stopped at a limit, and no other", () => {
    expect(followUpBlocker(run({}))).toBeNull();
    expect(followUpBlocker(run({ state: "stopped", stoppedByLimit: true }))).toBeNull();
    expect(followUpBlocker(run({ state: "needsAnswer" }))).toContain("waiting on the person");
    expect(followUpBlocker(run({ state: "working" }))).toContain("hasn't finished");
    expect(followUpBlocker(run({ state: "stopped", unsentAnswer: "x" }))).toContain("still waiting to be sent");
    expect(followUpBlocker(run({ sessionId: null }))).toContain("no session");
  });

  it("needs a message of bounded length and sets no limit on how many passes", () => {
    expect(followUpProblem("  ")).toContain("Write the message");
    expect(followUpProblem("x".repeat(FOLLOW_UP_LIMIT + 1))).toContain("up to");
    expect(followUpProblem("fine")).toBeNull();
    expect(nextPass({ passes: 50 })).toBe(51);
  });
});

describe("the run sheet after a follow-up", () => {
  it("shows the pass count only once the agent has been sent back and draws the timeline line with the retry icon", async () => {
    const { MockBackend } = await import("../backend/mock");
    const { RunSheetView } = await import("./RunSheet");
    const { timelineIcon } = await import("./runSheetLogic");
    const base = new MockBackend().runs.list()[0];
    const render = (passes: number | undefined) =>
      renderToStaticMarkup(
        <RunSheetView
          run={{ ...base, state: "done", passes } as Run}
          now={Date.parse("2026-09-30T12:00:00Z")}
          ticketTitle={null}
          place={null}
          wide={false}
          onWide={vi.fn()}
          events={[{ runId: base.id, seq: 1, at: "2026-09-30T11:00:00Z", kind: "follow_up", text: "Pip asked for another pass: the plan left open questions", detail: "Pass 2. Approved by you." }]}
          disk={null}
          brief={null}
          confirmStop={false}
          outcome={null}
          tickets={[]}
          pickBlocker={false}
          drafting={false}
          answering={false}
          opened={false}
          on={new Proxy({}, { get: () => vi.fn() }) as never}
        />,
      );
    expect(render(undefined)).not.toContain("data-passes");
    expect(render(1)).not.toContain("data-passes");
    const two = render(2);
    expect(two).toContain("data-passes");
    expect(two).toMatch(/Pass <b[^>]*>2<\/b>/);
    expect(two).toContain("Pip asked for another pass: the plan left open questions");
    expect(timelineIcon("follow_up")).toBe("retry");
  });
});
