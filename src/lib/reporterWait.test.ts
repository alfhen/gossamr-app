import { describe, expect, it } from "vitest";
import type { Proposal, WorkstreamActor } from "../types";
import { ANSWERS_COMMENT_LABEL, READINESS_COMMENT_LABEL } from "./proposals";
import { agoText, answersDue, planDue, reporterFollow, waitingOnReporterText } from "./reporterWait";
import fixtures from "./reporterWait.fixtures.json";

const at = (minutes: number) => new Date(Date.parse("2026-10-12T10:00:00Z") + minutes * 60_000).toISOString();
const line = (minutes: number, actor: WorkstreamActor, action: string, proposalId: string | null = null) => ({ actor, action, proposalId, at: at(minutes) });

describe("reporterFollow in the shared cases the Rust side runs too (reporterWait.fixtures.json)", () => {
  it.each(fixtures.cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const replies = c.comments.filter((k) => k.author !== c.me).map((k) => k.at);
    const got = reporterFollow(c.events.map((e) => ({ proposalId: null, ...e }) as Parameters<typeof reporterFollow>[0][number]), replies);
    expect({ waiting: got.waiting !== null, since: got.waiting, changed: got.changed, replied: got.replied }).toEqual(c.expect);
  });
});

describe("reporterFollow", () => {
  const asked = line(1, "person", "readiness_asked", "d1");
  const posted = line(2, "person", "draft_approved", "d1");

  it("starts when the asked comment is approved, not when it is only asked or another draft is approved", () => {
    expect(reporterFollow([asked])).toEqual({ waiting: null, changed: false, replied: false });
    expect(reporterFollow([asked, posted])).toEqual({ waiting: at(2), changed: false, replied: false });
    expect(reporterFollow([asked, line(2, "person", "draft_approved", "other")]).waiting).toBeNull();
    expect(reporterFollow([asked, line(2, "pip", "draft_approved", "d1")]).waiting).toBeNull();
    expect(reporterFollow([line(1, "person", "clarity_asked", "c1"), line(2, "person", "draft_approved", "c1")]).waiting).toBe(at(2));
  });

  it("ends at the first of the ticket changing, the person answering or planning anyway, or resuming", () => {
    const ended = (e: ReturnType<typeof line>) => reporterFollow([asked, posted, e]);
    expect(ended(line(3, "supervisor", "basis_drifted"))).toEqual({ waiting: null, changed: true, replied: false });
    expect(ended(line(3, "person", "basis_drifted")).waiting).toBe(at(2));
    expect(ended(line(3, "person", "readiness_answered"))).toEqual({ waiting: null, changed: false, replied: false });
    expect(ended(line(3, "person", "readiness_overridden"))).toEqual({ waiting: null, changed: false, replied: false });
    expect(ended(line(3, "person", "resumed"))).toEqual({ waiting: null, changed: false, replied: false });
    expect(ended(line(3, "supervisor", "resumed")).waiting).toBe(at(2));
  });

  it("keeps the changed question until the person chooses, and a new ask begins a new wait", () => {
    const changed = [asked, posted, line(3, "supervisor", "basis_drifted")];
    expect(reporterFollow([...changed, line(4, "person", "resumed")]).changed).toBe(true);
    expect(reporterFollow([...changed, line(4, "person", "readiness_asked", "d2")]).changed).toBe(false);
    expect(reporterFollow([...changed, line(4, "person", "readiness_asked", "d2"), line(5, "person", "draft_approved", "d2")])).toEqual({ waiting: at(5), changed: false, replied: false });
    expect(reporterFollow([line(1, "supervisor", "basis_drifted")])).toEqual({ waiting: null, changed: false, replied: false });
  });

  it("ends at a comment from someone else newer than the wait's start, and not at an older one or one of the person's own", () => {
    const events = [asked, posted];
    const waiting = { waiting: at(2), changed: false, replied: false };
    // The caller leaves the person's own comments out, so a newer comment of theirs is not among the replies.
    expect(reporterFollow(events, [])).toEqual(waiting);
    expect(reporterFollow(events, [at(1)])).toEqual(waiting);
    expect(reporterFollow(events, [at(2)])).toEqual(waiting);
    expect(reporterFollow(events, [at(1), at(5)])).toEqual({ waiting: null, changed: true, replied: true });
    // Nobody waiting: a comment says nothing.
    expect(reporterFollow([asked], [at(9)])).toEqual({ waiting: null, changed: false, replied: false });
    expect(reporterFollow([], [at(9)])).toEqual({ waiting: null, changed: false, replied: false });
    // A change in the ticket still ends it as itself.
    expect(reporterFollow([...events, line(3, "supervisor", "basis_drifted")], [at(5)])).toEqual({ waiting: null, changed: true, replied: false });
  });

  it("keeps the reply's question until the person chooses, and a new ask waits for a newer reply", () => {
    const events = [asked, posted];
    expect(reporterFollow([...events, line(6, "person", "resumed")], [at(5)]).replied).toBe(true);
    expect(reporterFollow([...events, line(6, "person", "readiness_overridden")], [at(5)])).toEqual({ waiting: null, changed: false, replied: false });
    expect(reporterFollow([...events, line(6, "person", "readiness_overridden")], [at(7)])).toEqual({ waiting: null, changed: false, replied: false });
    expect(reporterFollow([...events, line(6, "person", "readiness_asked", "d2")], [at(5)]).changed).toBe(false);
    const again = [...events, line(6, "person", "readiness_asked", "d2"), line(7, "person", "draft_approved", "d2")];
    expect(reporterFollow(again, [at(5)])).toEqual({ waiting: at(7), changed: false, replied: false });
    expect(reporterFollow(again, [at(5), at(8)]).replied).toBe(true);
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
