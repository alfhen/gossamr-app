import { describe, expect, it } from "vitest";
import type { Proposal, WorkstreamActor } from "../types";
import { ANSWERS_COMMENT_LABEL, READINESS_COMMENT_LABEL } from "./proposals";
import { agoText, answersDue, reporterFollow, waitingOnReporterText } from "./reporterWait";

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
