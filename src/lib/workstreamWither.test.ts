import { describe, expect, it } from "vitest";
import type { Intent, WorkstreamActor, WorkstreamEvent } from "../types";
import { WITHER_DAYS, witherLevel } from "./views";
import { isPost, workstreamWither, type WitherDraft, type WitherRun } from "./workstreamWither";

const NOW = new Date("2026-10-12T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 3_600_000).toISOString();

let seq = 0;
const line = (action: string, at: string, over: { actor?: WorkstreamActor; proposalId?: string | null; runId?: string | null } = {}): WorkstreamEvent => ({
  workstreamId: "ws-1",
  seq: seq++,
  at,
  actor: over.actor ?? "person",
  action,
  runId: over.runId ?? null,
  proposalId: over.proposalId ?? null,
  digest: null,
  detail: null,
});

const run = (launched: string | null, ended: string | null = null): WitherRun => ({ launchedAt: launched, endedAt: ended });
const draft = (type: Intent["type"], state: "pending" | "applying" | "applied" | "skipped" = "applied"): WitherDraft => ({ intent: { type } as Intent, state: { type: state } as WitherDraft["state"] });
const drafts = (map: Record<string, WitherDraft>) => (id: string) => map[id];

describe("a workstream's cobweb", () => {
  it("counts the days since the person's last post and says it with the runs since: 'No Jira update for 5 days (3 runs since)'", () => {
    const events = [line("opened", ago(9)), line("draft_approved", ago(7), { proposalId: "old" }), line("draft_approved", ago(5, 2), { proposalId: "d1" })];
    const runs = [run(ago(4), ago(4)), run(ago(3), ago(2)), run(ago(1))];
    const w = workstreamWither(events, runs, NOW, { draft: drafts({ old: draft("comment"), d1: draft("comment") }) });
    expect(w).toMatchObject({ days: 5, runs: 3, turns: 0, since: ago(5, 2), level: 3, text: "No Jira update for 5 days (3 runs since)" });
  });

  it("uses the stages a ticket row withers by", () => {
    expect(WITHER_DAYS.ticket).toEqual([2, 3, 5, 7, 10]);
    for (const [days, level] of [[1, 0], [2, 1], [3, 2], [5, 3], [7, 4], [10, 5]] as const) {
      const post = [line("review_posted", ago(days))];
      const w = workstreamWither(post, [run(ago(days - 0.5))], NOW);
      expect(w.level, `${days} days`).toBe(level);
      expect(w.level).toBe(witherLevel(ago(days), NOW, WITHER_DAYS.ticket));
    }
  });

  it("shows nothing while nothing happened since: no run started or finished, no Pip turn", () => {
    const events = [line("opened", ago(9)), line("review_posted", ago(8))];
    expect(workstreamWither(events, [], NOW)).toMatchObject({ level: 0, text: "", runs: 0, turns: 0 });
    // Runs that started and finished before the post are not activity since it.
    expect(workstreamWither(events, [run(ago(9), ago(8, 1))], NOW).level).toBe(0);
    // The ticket's own cobweb covers a ticket nobody touches; this one only counts work.
    expect(workstreamWither(events, [run(ago(7))], NOW).level).toBeGreaterThan(0);
  });

  it("counts a run that only finished since the post, and one that only started", () => {
    const events = [line("review_posted", ago(6))];
    expect(workstreamWither(events, [run(ago(7), ago(5))], NOW)).toMatchObject({ runs: 1, level: 3 });
    expect(workstreamWither(events, [run(ago(5), null)], NOW)).toMatchObject({ runs: 1, level: 3 });
    expect(workstreamWither(events, [run(null, null)], NOW).level).toBe(0);
  });

  it("counts Pip's turns, from the conversation when it is known, else from the audit's wake lines", () => {
    const events = [line("review_posted", ago(6)), line("wake", ago(5), { actor: "supervisor", runId: "r1" }), line("wake", ago(4), { actor: "supervisor", runId: "r2" })];
    expect(workstreamWither(events, [], NOW)).toMatchObject({ turns: 2, runs: 0, level: 3, text: "No Jira update for 6 days (2 Pip turns since)" });
    const turns = [{ at: ago(7) }, { at: ago(3) }, { at: null }, {}];
    expect(workstreamWither(events, [], NOW, { turns })).toMatchObject({ turns: 1, text: "No Jira update for 6 days (1 Pip turn since)" });
    expect(workstreamWither(events, [run(ago(2))], NOW, { turns })).toMatchObject({ text: "No Jira update for 6 days (1 run and 1 Pip turn since)" });
  });

  it("measures from when the workstream opened when the person has posted nothing", () => {
    const opened = [line("opened", ago(6, 1)), line("wake", ago(3), { actor: "supervisor" })];
    expect(workstreamWither(opened, [run(ago(5))], NOW)).toMatchObject({ since: ago(6, 1), days: 6, level: 3, text: "No Jira update for 6 days (1 run and 1 Pip turn since)" });
    // No `opened` line either: the workstream's own opening time stands in; with no clock at all there is no cobweb.
    expect(workstreamWither([], [run(ago(5))], NOW, { openedAt: ago(8) })).toMatchObject({ since: ago(8), level: 4 });
    expect(workstreamWither([], [run(ago(5))], NOW)).toMatchObject({ level: 0, since: null, text: "" });
    expect(workstreamWither([line("opened", "not a time")], [run(ago(5))], NOW).level).toBe(0);
  });

  it("restarts the clock at each post", () => {
    const events = [line("opened", ago(12)), line("review_posted", ago(10)), line("review_posted", ago(1))];
    expect(workstreamWither(events, [run(ago(0, 5))], NOW)).toMatchObject({ since: ago(1), days: 1, level: 0, runs: 1 });
  });

  it("says whole days, so a fraction of a day over two is two", () => {
    expect(workstreamWither([line("review_posted", ago(2, 5))], [run(ago(1))], NOW).text).toBe("No Jira update for 2 days (1 run since)");
    expect(workstreamWither([line("review_posted", ago(10))], [run(ago(1))], NOW).text).toBe("No Jira update for 10 days (1 run since)");
  });
});

describe("what counts as a post", () => {
  const approved = (id: string) => line("draft_approved", ago(1), { proposalId: id });

  it("is the person's approved Jira write or posted review, and nothing else", () => {
    for (const type of ["comment", "transition", "subtasks", "rewrite", "create", "update", "link"] as const) {
      expect(isPost(approved("d"), drafts({ d: draft(type) })), type).toBe(true);
    }
    expect(isPost(line("review_posted", ago(1)))).toBe(true);
    expect(isPost(line("escalation_posted", ago(1)))).toBe(true);
    for (const type of ["startRun", "followUp", "runAnswer", "githubReview"] as const) expect(isPost(approved("d"), drafts({ d: draft(type) })), `${type} reaches an agent or GitHub through its own line`).toBe(false);
  });

  it("needs the draft to have gone through, and to be known", () => {
    expect(isPost(approved("d"), drafts({ d: draft("comment", "applying") }))).toBe(true);
    for (const state of ["pending", "skipped"] as const) expect(isPost(approved("d"), drafts({ d: draft("comment", state) })), state).toBe(false);
    expect(isPost(approved("gone"), drafts({}))).toBe(false);
    expect(isPost(approved("d"))).toBe(false);
    expect(isPost(line("draft_approved", ago(1)), drafts({ d: draft("comment") }))).toBe(false);
  });

  it("is only ever the person's: Pip, the supervisor and a run post nothing here", () => {
    for (const actor of ["pip", "supervisor", "run"] as const) {
      expect(isPost(line("review_posted", ago(1), { actor }))).toBe(false);
      expect(isPost(line("draft_approved", ago(1), { actor, proposalId: "d" }), drafts({ d: draft("comment") }))).toBe(false);
    }
  });

  it("leaves the clock alone for a draft that reached no one, so the workstream still withers", () => {
    const events = [line("opened", ago(8)), line("draft_approved", ago(1), { proposalId: "run" })];
    const w = workstreamWither(events, [run(ago(7))], NOW, { draft: drafts({ run: draft("startRun") }) });
    expect(w).toMatchObject({ since: ago(8), days: 8, level: 4 });
  });
});

describe("a workstream waiting on the reporter", () => {
  it("shows the cobweb from the days since the asked comment was posted, without any work going on, and says the reporter hasn't answered", () => {
    const events = [line("opened", ago(9)), line("readiness_asked", ago(8), { proposalId: "q" }), line("draft_approved", ago(5, 2), { proposalId: "q" })];
    const w = workstreamWither(events, [], NOW, { draft: drafts({ q: draft("comment") }) });
    expect(w).toMatchObject({ reporter: true, days: 5, level: 3, runs: 0, turns: 0, since: ago(5, 2), text: "Reporter hasn't answered for 5 days" });
  });

  it("shows none before WITHER_DAYS.ticket's first stage, and says a day as one", () => {
    const post = (days: number) => [line("clarity_asked", ago(days + 1), { proposalId: "q" }), line("draft_approved", ago(days), { proposalId: "q" })];
    expect(workstreamWither(post(1), [], NOW)).toMatchObject({ level: 0, text: "" });
    expect(workstreamWither(post(2), [], NOW)).toMatchObject({ level: 1, text: "Reporter hasn't answered for 2 days" });
  });

  it("is not the reporter's silence once they replied on the ticket, which the audit doesn't say", () => {
    const events = [line("opened", ago(9)), line("readiness_asked", ago(8), { proposalId: "q" }), line("draft_approved", ago(5, 2), { proposalId: "q" })];
    const w = workstreamWither(events, [], NOW, { draft: drafts({ q: draft("comment") }), replied: true });
    expect(w.reporter).toBeUndefined();
  });

  it("is the ordinary cobweb again once the wait is over", () => {
    const events = [line("opened", ago(9)), line("readiness_asked", ago(8), { proposalId: "q" }), line("draft_approved", ago(6), { proposalId: "q" }), line("readiness_answered", ago(5))];
    const w = workstreamWither(events, [run(ago(4))], NOW, { draft: drafts({ q: draft("comment") }) });
    expect(w.reporter).toBeUndefined();
    expect(w.text).toMatch(/^No Jira update for 6 days/);
  });
});
