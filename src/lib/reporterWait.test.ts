import { describe, expect, it } from "vitest";
import type { Proposal, WorkstreamActor } from "../types";
import { ANSWERS_COMMENT_LABEL, READINESS_COMMENT_LABEL } from "./proposals";
import { agoText, askedQuestions, answersDue, nudgeComment, nudgeOffered, nudgeText, NUDGE_AFTER_DAYS, followWithReply, planDue, replyComment, replyExcerpt, REPLY_EXCERPT, reporterAsk, reporterFollow, reporterReplies, waitedDays, waitingOnReporterText } from "./reporterWait";
import { NUDGE_COMMENT_LABEL } from "./proposals";
import fixtures from "./reporterWait.fixtures.json";

const at = (minutes: number) => new Date(Date.parse("2026-10-12T10:00:00Z") + minutes * 60_000).toISOString();
const line = (minutes: number, actor: WorkstreamActor, action: string, proposalId: string | null = null) => ({ actor, action, proposalId, at: at(minutes) });

describe("reporterFollow in the shared cases the Rust side runs too (reporterWait.fixtures.json)", () => {
  it.each(fixtures.cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const replies = c.comments.filter((k) => k.author !== c.me).map((k) => k.at);
    const { follow: got, repliedAt } = followWithReply(c.events.map((e) => ({ proposalId: null, ...e }) as Parameters<typeof reporterFollow>[0][number]), replies);
    const { repliedAt: expectedAt, reply, replies: expectedReplies, ...expected } = c.expect as typeof c.expect & { repliedAt?: string | null; reply?: { id: string; excerpt: string } | null; replies?: { id: string; excerpt: string; at: string }[] };
    expect({ waiting: got.waiting !== null, since: got.waiting, changed: got.changed, replied: got.replied }).toEqual(expected);
    if (expectedAt !== undefined) expect(repliedAt).toBe(expectedAt);
    if (expectedReplies !== undefined) expect(reporterReplies(c.events.map((e) => ({ proposalId: null, ...e }) as Parameters<typeof reporterFollow>[0][number]), c.comments.filter((k) => k.author !== c.me).map((k) => ({ id: "", text: "", ...k })))).toEqual(expectedReplies);
    if (reply !== undefined) expect(replyComment(c.comments.filter((k) => k.author !== c.me).map((k) => ({ id: "", text: "", ...k })), repliedAt)).toEqual(reply);
  });
});

describe("the reporter's reply as a quote (G15)", () => {
  it("is the first two lines, evened out, short enough to read at a glance", () => {
    expect(replyExcerpt("  Hi,\n second")).toBe("Hi,\nsecond");
    expect(replyExcerpt("1. a\n2. b\n3. c\n\n4. d")).toBe("1. a\n2. b (+2 more)");
    expect(replyExcerpt("1. a\n2. b\n3. c")).toBe("1. a\n2. b (+1 more)");
    expect(replyExcerpt("\n\n  a   b \t c")).toBe("a b c");
    expect(replyExcerpt("  Hi,\n \n ")).toBe("Hi,");
    expect(replyExcerpt("")).toBe("");
    expect(Array.from(replyExcerpt("x".repeat(500)))).toHaveLength(REPLY_EXCERPT);
    expect(replyExcerpt("x".repeat(REPLY_EXCERPT))).toBe("x".repeat(REPLY_EXCERPT));
  });

  it("finds the comment written when the wait ended, and none without one", () => {
    const comments = [{ id: "a", at: at(5), text: "First" }, { id: "b", at: at(9), text: "Second" }];
    expect(replyComment(comments, at(9))).toEqual({ id: "b", excerpt: "Second" });
    expect(replyComment(comments, at(7))).toBeNull();
    expect(replyComment(comments, null)).toBeNull();
  });
});

describe("reporterAsk", () => {
  const ask = [line(1, "person", "readiness_asked", "d1"), line(2, "person", "draft_approved", "d1")];

  it("is the approval time of the newest ask and of a nudge after it, and outlives the ticket changing", () => {
    expect(reporterAsk([])).toBeNull();
    expect(reporterAsk([line(1, "person", "readiness_asked", "d1")])).toBeNull();
    expect(reporterAsk(ask)).toEqual({ asked: at(2), nudged: null });
    const nudge = [line(3, "person", "reporter_nudged", "n1"), line(4, "person", "draft_approved", "n1")];
    expect(reporterAsk([...ask, ...nudge])).toEqual({ asked: at(2), nudged: at(4) });
    expect(reporterAsk([...ask, ...nudge, line(5, "supervisor", "basis_drifted")])).toEqual({ asked: at(2), nudged: at(4) });
    // Asking again starts over; answering or planning anyway ends it.
    expect(reporterAsk([...ask, ...nudge, line(5, "person", "readiness_asked", "d2"), line(6, "person", "draft_approved", "d2")])).toEqual({ asked: at(6), nudged: null });
    expect(reporterAsk([...ask, line(3, "person", "readiness_answered")])).toBeNull();
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
    expect(nudgeComment("CA-408", "Mette Lund")).toBe("Hi @Mette Lund,\n\nThe earlier questions about CA-408 are still open. Could you answer them here on the ticket when you have a moment? Thanks.");
    expect(nudgeComment("CA-408", null).startsWith("Hi,\n")).toBe(true);
    expect(nudgeComment("CA-408", null)).not.toContain("gentle");
  });

  it("lists the questions still open as bullets, the ones the ask carried (G20), and keeps its voice neutral", () => {
    const ask = "Hi @Mette Lund,\n\nA few things need clearing up before work on this starts:\n\n- What does done look like?\n- Who is waiting on it?\n\nCould you answer them here on the ticket? Thanks.";
    const open = askedQuestions(ask);
    expect(open).toEqual(["What does done look like?", "Who is waiting on it?"]);
    const text = nudgeComment("CA-408", "Mette Lund", false, open);
    expect(text).toBe("Hi @Mette Lund,\n\nThe earlier questions about CA-408 are still open:\n\n- What does done look like?\n- Who is waiting on it?\n\nCould you answer them here on the ticket when you have a moment? Thanks.");
    expect(text).not.toMatch(/\b(we|I|above|Gossamr|Pip|runs?|workstreams?)\b/);
    expect(askedQuestions("Hi,\n\nNo bullets.")).toEqual([]);
  });

  it("follows up on the follow-up questions once the reporter has replied before, and never says we, above, planned or Gossamr", () => {
    const again = nudgeComment("CA-408", "Mette Lund", true);
    expect(again).toContain("The follow-up questions about CA-408 are still open.");
    for (const text of [again, nudgeComment("CA-408", null)]) expect(text).not.toMatch(/\b(we|above|planned|Gossamr|Pip)\b/);
  });

  it("a posted nudge starts the wait again from then, and a nudge only drafted changes nothing", () => {
    const asked = line(1, "person", "clarity_asked", "c1");
    const posted = line(2, "person", "draft_approved", "c1");
    const nudged = line(3, "person", "reporter_nudged", "n1");
    expect(reporterFollow([asked, posted, nudged]).waiting).toBe(at(2));
    expect(reporterFollow([asked, posted, nudged, line(4, "person", "draft_approved", "n1")])).toEqual({ waiting: at(4), changed: false, replied: false });
    expect(reporterFollow([asked, posted, line(3, "pip", "reporter_nudged", "n1"), line(4, "pip", "draft_approved", "n1")]).waiting).toBe(at(2));
    // Core only drafts a nudge while the workstream waits; read alone, its posting starts the wait from then, as the Rust side reads it.
    expect(reporterFollow([nudged, line(4, "person", "draft_approved", "n1")]).waiting).toBe(at(4));
  });
});
