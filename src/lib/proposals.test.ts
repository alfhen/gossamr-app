import { describe, expect, it } from "vitest";
import type { Intent, Proposal, RunKind, RunSpec } from "../types";
import { answersProvenance, ANSWERS_COMMENT_LABEL, isReporterFollowUp, answersSupersession, READINESS_COMMENT_LABEL, draftsForTurn, earlierDrafts, inWorkstreamPane, isAnswersDraft, isReporterQuestions, reporterSupersession, supersession, supersessionKey, targetOf, withoutRunDrafts } from "./proposals";
import fixtures from "./draftHygiene.fixtures.json";
import { isRunPlanRewrite } from "../backend/mockProposals";

const ref = (key: string) => ({ connectionId: "c", externalId: key, key });

function proposal(id: string, intent: Intent, over: Partial<Proposal> = {}): Proposal {
  return {
    id,
    createdAt: `2026-09-29T12:00:0${id}Z`,
    updatedAt: "2026-09-29T12:00:00Z",
    origin: { type: "chat", requestId: "r1" },
    createdBy: "pip",
    intent,
    label: null,
    basis: null,
    state: { type: "pending" },
    revisions: [],
    created: [],
    error: null,
    run: null,
    ...over,
  };
}

const subtasks = (key: string): Intent => ({ type: "subtasks", parent: ref(key), summaries: ["a"] });

describe("draftsForTurn", () => {
  it("returns the turn's drafts oldest first", () => {
    const all = [proposal("2", subtasks("A-1")), proposal("1", subtasks("A-1")), proposal("3", subtasks("A-1"), { origin: { type: "chat", requestId: "r2" } })];
    expect(draftsForTurn(all, "r1").map((p) => p.id)).toEqual(["1", "2"]);
  });
});

describe("earlierDrafts", () => {
  it("lists open drafts on the ticket that no visible turn accounts for", () => {
    const all = [
      proposal("1", subtasks("A-1")),
      proposal("2", subtasks("A-1"), { origin: { type: "chat", requestId: "r9" } }),
      proposal("3", subtasks("A-1"), { origin: { type: "chat", requestId: "r9" }, state: { type: "skipped" } }),
      proposal("4", subtasks("A-2"), { origin: { type: "chat", requestId: "r9" } }),
    ];
    expect(earlierDrafts(all, "A-1", ["r1"]).map((p) => p.id)).toEqual(["2"]);
  });

  it("targets nothing for a new item", () => {
    const create: Intent = {
      type: "create",
      container: { connectionId: "c", externalId: "P" },
      fields: { title: "t", body: { blocks: [] }, kind: "task", assignee: null, parent: null, priority: null, labels: [] },
      link: null,
    };
    expect(targetOf(create)).toBeNull();
  });
});

const runSpec: RunSpec = { kind: "investigate", repo: "acme/web", clonePath: "/Users/x/Code/web", base: "main", name: "ca-1-fix-ab12", instruction: "Look into it." };
const startRun = (item: ReturnType<typeof ref> | null): Intent => ({ type: "startRun", connectionId: "c", item, spec: runSpec });

describe("startRun drafts", () => {
  it("target the ticket they were started from, or nothing", () => {
    expect(targetOf(startRun(ref("CA-1")))?.key).toBe("CA-1");
    expect(targetOf(startRun(null))).toBeNull();
  });

  it("are left out for screens that approve with proposalsApprove", () => {
    const all = [proposal("1", subtasks("A-1")), proposal("2", startRun(ref("A-1"))), proposal("3", startRun(null))];
    expect(withoutRunDrafts(all).map((p) => p.id)).toEqual(["1"]);
    expect(earlierDrafts(withoutRunDrafts(all), "A-1", []).map((p) => p.id)).toEqual(["1"]);
    expect(draftsForTurn(withoutRunDrafts(all), "r1").map((p) => p.id)).toEqual(["1"]);
  });
});

describe("inWorkstreamPane", () => {
  const ws = { id: "ws-1", itemKey: "A-1", connectionId: "c" };

  it("shows the workstream's own drafts in any state, and open drafts on its ticket, as Pip's block lists them", () => {
    const own = proposal("1", subtasks("B-2"), { origin: { type: "chat", requestId: "r1", workstream: "ws-1" }, state: { type: "applied" } });
    const onTicket = proposal("2", subtasks("A-1"), { origin: { type: "run", runId: "run-1", shortId: null, workstream: null }, createdBy: "agent" });
    const doneOnTicket = proposal("3", subtasks("A-1"), { state: { type: "skipped" } });
    const elsewhere = proposal("4", subtasks("B-2"));
    const otherConnection = proposal("5", { type: "subtasks", parent: { connectionId: "other", externalId: "A-1", key: "A-1" }, summaries: ["a"] });
    const otherWorkstream = proposal("6", subtasks("B-2"), { origin: { type: "chat", requestId: "r1", workstream: "ws-2" } });
    expect([own, onTicket, doneOnTicket, elsewhere, otherConnection, otherWorkstream].filter((p) => inWorkstreamPane(p, ws)).map((p) => p.id)).toEqual(["1", "2"]);
    expect(inWorkstreamPane(onTicket, { ...ws, itemKey: null })).toBe(false);
  });
});

describe("inWorkstreamPane and retired drafts", () => {
  const ws = { id: "ws-1", itemKey: "A-1", connectionId: "c", createdAt: "2026-09-29T11:00:00Z" };

  it("keeps a draft on its ticket retired since the workstream opened, so it collapses instead of vanishing", () => {
    const retired = proposal("1", subtasks("A-1"), { origin: { type: "board" }, createdBy: "user", state: { type: "retired", reason: "Another move of A-1 was approved" } });
    expect(inWorkstreamPane(retired, ws)).toBe(true);
    expect(inWorkstreamPane({ ...retired, updatedAt: "2026-09-29T10:00:00Z" }, ws)).toBe(false);
    expect(inWorkstreamPane(retired, { ...ws, createdAt: undefined })).toBe(false);
    expect(inWorkstreamPane({ ...retired, state: { type: "skipped" } }, ws)).toBe(false);
  });
});

/** A draft as `draftHygiene.fixtures.json` describes it; `src-tauri/src/proposals.rs` builds the same. */
type FixtureDraft = { by: Proposal["createdBy"]; origin: "chat" | "run" | "board"; workstream: string | null; intent: Intent; edited?: boolean; planRewrite?: boolean; state?: "skipped" };

const PLAN_BODY = { blocks: [{ type: "heading", level: 2, content: [{ type: "text", text: "Gossamr Plan", marks: [] }] }] };

function fixtureDraft(d: FixtureDraft, id: string): Proposal {
  const origin: Proposal["origin"] =
    d.origin === "chat" ? { type: "chat", requestId: "r", workstream: d.workstream } : d.origin === "run" ? { type: "run", runId: "run-1", shortId: null, workstream: d.workstream } : { type: "board" };
  const intent = (d.planRewrite && d.intent.type === "rewrite" ? { ...d.intent, body: { from: { blocks: [] }, to: PLAN_BODY, fromText: "old", toText: "## Gossamr Plan" } } : d.intent) as Intent;
  return proposal(id, intent, {
    origin,
    createdBy: d.by,
    state: d.state === "skipped" ? { type: "skipped" } : { type: "pending" },
    revisions: d.edited ? [{ at: "2026-09-29T12:00:00Z", note: "Edited", intent }] : [],
  });
}

describe("draft hygiene fixtures, as proposals.rs runs them", () => {
  for (const c of fixtures as unknown as ({ name: string; kind: "key"; a: Intent; b: Intent; same: boolean } | { name: string; kind: "decide"; older: FixtureDraft; newer: FixtureDraft; expect: string })[]) {
    it(c.name, () => {
      if (c.kind === "key") {
        const a = supersessionKey(c.a);
        expect(a !== null && a === supersessionKey(c.b)).toBe(c.same);
      } else {
        expect(supersession(fixtureDraft(c.older, "old"), fixtureDraft(c.newer, "new"), isRunPlanRewrite).type).toBe(c.expect);
      }
    });
  }

  it("names the edited draft when it refuses Pip", () => {
    const older = proposal("1", { type: "transition", item: ref("A-1"), to: "x" }, { origin: { type: "chat", requestId: "r", workstream: "w" }, revisions: [{ at: "t", note: "Edited", intent: { type: "transition", item: ref("A-1"), to: "y" } }] });
    const newer = proposal("2", { type: "transition", item: ref("A-1"), to: "z" }, { origin: { type: "chat", requestId: "r", workstream: "w" } });
    const verdict = supersession(older, newer, () => false);
    expect(verdict.type === "refuse" && verdict.reason).toContain("the user edited draft 1 of the same kind on A-1");
  });
});

const githubReview = (repo: string, item: ReturnType<typeof ref> | null = ref("CA-1")): Intent => ({
  type: "githubReview",
  connectionId: "github:ada",
  item,
  runId: "run-1",
  repo,
  number: 218,
  commitSha: "a1b2c3d4e5f6",
  summary: "Gossamr review of #218.",
  comments: [{ path: "src/consumer/retry.ts", line: 42, side: "RIGHT", body: "No backoff." }],
});

describe("GitHub review drafts", () => {
  it("are grouped under their run's ticket and keyed by pull request, whatever the case of its repository", () => {
    expect(targetOf(githubReview("acme/webshop"))?.key).toBe("CA-1");
    expect(targetOf(githubReview("acme/webshop", null))).toBeNull();
    expect(supersessionKey(githubReview("Acme/WebShop"))).toBe("githubReview:acme/webshop#218");
  });

  it("are left out for screens that approve with proposalsApprove", () => {
    const all = [proposal("1", subtasks("A-1")), proposal("2", githubReview("acme/webshop"))];
    expect(withoutRunDrafts(all).map((p) => p.id)).toEqual(["1"]);
  });
});

describe("the comments about a ticket's open questions", () => {
  const comment = (key: string): Intent => ({ type: "comment", item: ref(key), body: { blocks: [] } }) as unknown as Intent;
  const fromRun = (id: string, run: string, over: Partial<Proposal> = {}) => proposal(id, comment("A-1"), { origin: { type: "run", runId: run, shortId: null, workstream: "ws-1" }, createdBy: "agent", ...over });
  const asked = (id: string, run: string, over: Partial<Proposal> = {}) => fromRun(id, run, { label: READINESS_COMMENT_LABEL, ...over });

  it("is Gossamr's questions to a reporter whoever's run or request they came from, and never one Pip made", () => {
    expect(isReporterQuestions(asked("1", "t1"))).toBe(true);
    expect(isReporterQuestions(proposal("2", comment("A-1"), { createdBy: "user", label: READINESS_COMMENT_LABEL, origin: { type: "chat", requestId: "clarity:ws-1", workstream: "ws-1" } }))).toBe(true);
    expect(isReporterQuestions(proposal("3", comment("A-1"), { label: READINESS_COMMENT_LABEL }))).toBe(false);
    expect(isReporterQuestions(fromRun("4", "t1"))).toBe(false);
    expect(isReporterQuestions(proposal("5", subtasks("A-1"), { createdBy: "user", label: READINESS_COMMENT_LABEL }))).toBe(false);
  });

  it("is a follow-up when the asked questions open with the thanks for the reporter's answer, and still the reporter's questions", () => {
    const body = (text: string) => ({ type: "comment", item: ref("A-1"), body: { blocks: [{ type: "paragraph", content: [{ type: "text", text, marks: [] }] }] } }) as unknown as Intent;
    const follow = proposal("1", body("Hi,\n\nThanks for your answer above. A few things about A-1 are still open:"), { label: READINESS_COMMENT_LABEL, createdBy: "user" });
    const first = proposal("2", body("Hi,\n\nA few things about A-1 need clearing up:"), { label: READINESS_COMMENT_LABEL, createdBy: "user" });
    expect([isReporterFollowUp(follow), isReporterQuestions(follow)]).toEqual([true, true]);
    expect([isReporterFollowUp(first), isReporterQuestions(first)]).toEqual([false, true]);
  });

  it("is Pip's comment with the person's answers only when Pip made it", () => {
    expect(isAnswersDraft(proposal("1", comment("A-1"), { label: ANSWERS_COMMENT_LABEL }))).toBe(true);
    expect(isAnswersDraft(proposal("2", comment("A-1"), { label: ANSWERS_COMMENT_LABEL, createdBy: "user" }))).toBe(false);
    expect(isAnswersDraft(proposal("3", comment("A-1")))).toBe(false);
  });

  it("replaces the triage's own pending comment, which repeats the questions, and nothing else", () => {
    const own = fromRun("1", "t1");
    expect(reporterSupersession(own, asked("9", "t1"))).toBe("supersede");
    expect(reporterSupersession(fromRun("2", "t1", { revisions: [{ note: "Edited" } as Proposal["revisions"][number]] }), asked("9", "t1"))).toBe("draft_kept_edited");
    expect(reporterSupersession(fromRun("3", "other-run"), asked("9", "t1"))).toBeNull();
    expect(reporterSupersession(fromRun("4", "t1", { state: { type: "applied" } as Proposal["state"] }), asked("9", "t1"))).toBeNull();
    expect(reporterSupersession(fromRun("5", "t1", { error: "boom" }), asked("9", "t1"))).toBeNull();
    expect(reporterSupersession(asked("6", "t1"), asked("9", "t1"))).toBeNull();
    expect(reporterSupersession(fromRun("7", "t1", { origin: { type: "run", runId: "t1", shortId: null, workstream: "ws-2" } }), asked("9", "t1"))).toBeNull();
    expect(reporterSupersession(proposal("8", comment("A-1")), asked("9", "t1"))).toBeNull();
    expect(reporterSupersession(own, fromRun("10", "t1"))).toBeNull();
  });

  it("replaces the triage's own pending comment once the person's answers are drafted, and leaves any other run's", () => {
    const answers = proposal("9", comment("A-1"), { label: ANSWERS_COMMENT_LABEL, origin: { type: "chat", requestId: "q1", workstream: "ws-1" } });
    const kinds: Record<string, RunKind> = { t1: "triage", i1: "investigate" };
    const kindOf = (run: string) => kinds[run] ?? null;
    expect(answersSupersession(fromRun("1", "t1"), answers, kindOf)).toBe("supersede");
    expect(answersSupersession(fromRun("2", "t1", { revisions: [{ note: "Edited" } as Proposal["revisions"][number]] }), answers, kindOf)).toBe("draft_kept_edited");
    expect(answersSupersession(fromRun("3", "i1"), answers, kindOf), "an investigation's findings are not the readiness text").toBeNull();
    expect(answersSupersession(fromRun("4", "unknown"), answers, kindOf)).toBeNull();
    expect(answersSupersession(fromRun("5", "t1", { state: { type: "retired", reason: "x" } as Proposal["state"] }), answers, kindOf)).toBeNull();
    expect(answersSupersession(fromRun("6", "t1", { error: "boom" }), answers, kindOf)).toBeNull();
    expect(answersSupersession(fromRun("7", "t1", { origin: { type: "run", runId: "t1", shortId: null, workstream: "ws-2" } }), answers, kindOf)).toBeNull();
    expect(answersSupersession(asked("8", "t1"), answers, kindOf), "the questions to the reporter stay").toBeNull();
    expect(answersSupersession(fromRun("10", "t1"), fromRun("11", "t1"), kindOf), "only the answers draft supersedes").toBeNull();
  });
});

describe("answersProvenance", () => {
  it("quotes the start of the reply after My answers:, and is words for the app, never for Jira", () => {
    const line = answersProvenance("CA-401's open questions: “Who is it for?”. My answers:   It is for\nthe winback team. ");
    expect(line).toBe("Drafted from your reply “It is for the winback team.” in this conversation, each answer under its question. Read and edit it before you approve.");
    expect(answersProvenance("My answers: " + "word ".repeat(40))).toContain("word word…”");
  });

  it("names the reply without quoting it when that turn is no longer at hand", () => {
    expect(answersProvenance(null)).toBe("Drafted from your reply in this conversation, each answer under its question. Read and edit it before you approve.");
  });
});
