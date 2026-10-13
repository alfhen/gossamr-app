import { describe, expect, it } from "vitest";
import type { Proposal, WorkstreamActor } from "../types";
import { ANSWERS_COMMENT_LABEL, READINESS_COMMENT_LABEL } from "./proposals";
import { agoText, answersDue, nudgeComment, nudgeOffered, nudgeText, NUDGE_AFTER_DAYS, planDue, reporterFollow, waitedDays, waitingOnReporterText } from "./reporterWait";
import { NUDGE_COMMENT_LABEL } from "./proposals";

const at = (minutes: number) => new Date(Date.parse("2026-10-12T10:00:00Z") + minutes * 60_000).toISOString();
const line = (minutes: number, actor: WorkstreamActor, action: string, proposalId: string | null = null) => ({ actor, action, proposalId, at: at(minutes) });

describe("reporterFollow", () => {
  const asked = line(1, "person", "readiness_asked", "d1");
  const posted = line(2, "person", "draft_approved", "d1");

  it("starts when the asked comment is approved, not when it is only asked or another draft is approved", () => {
    expect(reporterFollow([asked])).toEqual({ waiting: null, changed: false });
    expect(reporterFollow([asked, posted])).toEqual({ waiting: at(2), changed: false });
    expect(reporterFollow([asked, line(2, "person", "draft_approved", "other")]).waiting).toBeNull();
    expect(reporterFollow([asked, line(2, "pip", "draft_approved", "d1")]).waiting).toBeNull();
    expect(reporterFollow([line(1, "person", "clarity_asked", "c1"), line(2, "person", "draft_approved", "c1")]).waiting).toBe(at(2));
  });

  it("ends at the first of the ticket changing, the person answering or planning anyway, or resuming", () => {
    const ended = (e: ReturnType<typeof line>) => reporterFollow([asked, posted, e]);
    expect(ended(line(3, "supervisor", "basis_drifted"))).toEqual({ waiting: null, changed: true });
    expect(ended(line(3, "person", "basis_drifted")).waiting).toBe(at(2));
    expect(ended(line(3, "person", "readiness_answered"))).toEqual({ waiting: null, changed: false });
    expect(ended(line(3, "person", "readiness_overridden"))).toEqual({ waiting: null, changed: false });
    expect(ended(line(3, "person", "resumed"))).toEqual({ waiting: null, changed: false });
    expect(ended(line(3, "supervisor", "resumed")).waiting).toBe(at(2));
  });

  it("keeps the changed question until the person chooses, and a new ask begins a new wait", () => {
    const changed = [asked, posted, line(3, "supervisor", "basis_drifted")];
    expect(reporterFollow([...changed, line(4, "person", "resumed")]).changed).toBe(true);
    expect(reporterFollow([...changed, line(4, "person", "readiness_asked", "d2")]).changed).toBe(false);
    expect(reporterFollow([...changed, line(4, "person", "readiness_asked", "d2"), line(5, "person", "draft_approved", "d2")])).toEqual({ waiting: at(5), changed: false });
    expect(reporterFollow([line(1, "supervisor", "basis_drifted")])).toEqual({ waiting: null, changed: false });
  });
});

describe("what a wait says", () => {
  const now = new Date(at(0));
  it("counts how long ago in plain words", () => {
    expect(agoText(at(0), now)).toBe("just now");
    expect(agoText(at(-1), now)).toBe("1 minute ago");
    expect(agoText(at(-59), now)).toBe("59 minutes ago");
    expect(agoText(at(-60 * 3), now)).toBe("3 hours ago");
    expect(agoText(at(-60 * 24), now)).toBe("yesterday");
    expect(agoText(at(-60 * 24 * 4), now)).toBe("4 days ago");
    expect(waitingOnReporterText(at(-60 * 24 * 4), now)).toBe("Waiting on the reporter since 4 days ago; nothing starts on its own.");
  });
});

describe("answersDue", () => {
  const draft = (over: Partial<Proposal>) => ({ intent: { type: "comment" }, label: ANSWERS_COMMENT_LABEL, createdBy: "pip", createdAt: at(5), ...over }) as Pick<Proposal, "intent" | "label" | "createdBy" | "createdAt">;
  it("is true after I'll answer until Pip drafts the answers, and only while that is the newest choice", () => {
    const answered = line(3, "person", "readiness_answered");
    expect(answersDue([answered], [])).toBe(true);
    expect(answersDue([answered], [draft({})])).toBe(false);
    expect(answersDue([answered], [draft({ createdAt: at(1) })])).toBe(true);
    expect(answersDue([answered], [draft({ createdBy: "agent" })])).toBe(true);
    expect(answersDue([answered], [draft({ label: READINESS_COMMENT_LABEL })])).toBe(true);
    expect(answersDue([answered, line(4, "person", "readiness_overridden")], [])).toBe(false);
    expect(answersDue([line(2, "person", "readiness_asked", "d1")], [])).toBe(false);
    expect(answersDue([line(3, "pip", "readiness_answered")], [])).toBe(false);
    expect(answersDue([], [])).toBe(false);
  });
});

describe("planDue", () => {
  const draft = (over: Partial<Proposal>) => ({ intent: { type: "comment" }, label: ANSWERS_COMMENT_LABEL, createdBy: "pip", createdAt: at(5), state: { type: "applied" }, ...over }) as Pick<Proposal, "intent" | "label" | "createdBy" | "createdAt" | "state">;
  const plan = (over: Partial<Proposal> = {}) => draft({ intent: { type: "startRun", spec: { kind: "plan", workstream: "ws-1" } } as Proposal["intent"], label: null, state: { type: "pending" }, createdAt: at(8), ...over });
  const answered = [line(3, "person", "readiness_answered")];
  it("is true once the answers comment was posted, and not while it still waits or before it was drafted", () => {
    expect(planDue(answered, [draft({})], [], "ws-1")).toBe(true);
    expect(planDue(answered, [draft({ state: { type: "pending" } })], [], "ws-1")).toBe(false);
    expect(planDue(answered, [draft({ state: { type: "skipped" } })], [], "ws-1")).toBe(false);
    expect(planDue(answered, [], [], "ws-1")).toBe(false);
    expect(planDue(answered, [draft({ createdAt: at(1) })], [], "ws-1")).toBe(false);
    expect(planDue(answered, [draft({ createdBy: "agent" })], [], "ws-1")).toBe(false);
  });
  it("is over once a plan was drafted or started since, or another choice was the newest", () => {
    expect(planDue(answered, [draft({}), plan()], [], "ws-1")).toBe(false);
    expect(planDue(answered, [draft({}), plan({ state: { type: "retired", reason: "x" } as Proposal["state"] })], [], "ws-1")).toBe(false);
    expect(planDue(answered, [draft({}), plan({ intent: { type: "startRun", spec: { kind: "plan", workstream: "ws-2" } } as Proposal["intent"] })], [], "ws-1")).toBe(true);
    expect(planDue(answered, [draft({})], [{ spec: { kind: "plan", workstream: "ws-1" }, queuedAt: at(9) }], "ws-1")).toBe(false);
    expect(planDue(answered, [draft({})], [{ spec: { kind: "plan", workstream: "ws-1" }, queuedAt: at(2) }], "ws-1")).toBe(true);
    expect(planDue([...answered, line(4, "person", "readiness_overridden")], [draft({})], [], "ws-1")).toBe(false);
  });
});

describe("the nudge", () => {
  const NOW = new Date(at(0));
  const since = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
  const nudge = (state: "pending" | "applying" | "applied" | "skipped" = "pending", workstream = "w1", createdBy: Proposal["createdBy"] = "user") =>
    ({ intent: { type: "comment" }, label: NUDGE_COMMENT_LABEL, createdBy, state: { type: state }, origin: { type: "chat", requestId: "nudge:w1", workstream } }) as unknown as Proposal;

  it("is offered after the cobweb's first stage, which is 2 days, and not before", () => {
    expect(NUDGE_AFTER_DAYS).toBe(2);
    expect(nudgeOffered({ since: since(1.9) }, NOW, [], "w1")).toBe(false);
    expect(nudgeOffered({ since: since(2) }, NOW, [], "w1")).toBe(true);
    expect(nudgeOffered({ since: since(9) }, NOW, [], "w1")).toBe(true);
    expect(nudgeOffered(null, NOW, [], "w1")).toBe(false);
    expect(nudgeOffered({ since: "not a time" }, NOW, [], "w1")).toBe(false);
    expect(waitedDays(since(3.5), NOW)).toBe(3);
  });

  it("waits while a nudge draft waits in the workstream, and counts only that workstream's, Gossamr's and pending ones", () => {
    const wait = { since: since(4) };
    expect(nudgeOffered(wait, NOW, [nudge("pending")], "w1")).toBe(false);
    expect(nudgeOffered(wait, NOW, [nudge("applying")], "w1")).toBe(false);
    expect(nudgeOffered(wait, NOW, [nudge("skipped")], "w1")).toBe(true);
    expect(nudgeOffered(wait, NOW, [nudge("applied")], "w1")).toBe(true);
    expect(nudgeOffered(wait, NOW, [nudge("pending", "w2")], "w1")).toBe(true);
    expect(nudgeOffered(wait, NOW, [nudge("pending", "w1", "pip")], "w1")).toBe(true);
  });

  it("says how long the reporter has been silent and that a nudge can be drafted", () => {
    expect(nudgeText(3)).toBe("The reporter hasn't answered for 3 days. You can draft a nudge.");
    expect(nudgeText(1)).toBe("The reporter hasn't answered for 1 day. You can draft a nudge.");
  });

  it("is short and polite, names the reporter when known, and says what the Rust side says", () => {
    expect(nudgeComment("CA-408", "Mette Lund")).toBe("Hi @Mette Lund,\n\nA gentle nudge on the questions above; we can't plan CA-408 until they are cleared up. Could you answer them here on the ticket when you have a moment? Thanks.");
    expect(nudgeComment("CA-408", null).startsWith("Hi,\n")).toBe(true);
  });

  it("a posted nudge starts the wait again from then, and a nudge only drafted changes nothing", () => {
    const asked = line(1, "person", "clarity_asked", "c1");
    const posted = line(2, "person", "draft_approved", "c1");
    const nudged = line(3, "person", "reporter_nudged", "n1");
    expect(reporterFollow([asked, posted, nudged]).waiting).toBe(at(2));
    expect(reporterFollow([asked, posted, nudged, line(4, "person", "draft_approved", "n1")])).toEqual({ waiting: at(4), changed: false });
    expect(reporterFollow([asked, posted, line(3, "pip", "reporter_nudged", "n1"), line(4, "pip", "draft_approved", "n1")]).waiting).toBe(at(2));
    // Core only drafts a nudge while the workstream waits; read alone, its posting starts the wait from then, as the Rust side reads it.
    expect(reporterFollow([nudged, line(4, "person", "draft_approved", "n1")]).waiting).toBe(at(4));
  });
});
