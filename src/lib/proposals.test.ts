import { describe, expect, it } from "vitest";
import type { Intent, Proposal, RunSpec } from "../types";
import { draftExcerpt, draftsForTurn, earlierDrafts, inWorkstreamPane, supersessionKey, targetOf, withoutRunDrafts } from "./proposals";
import { docFromText } from "./docs";

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

const runSpec: RunSpec = { role: "investigate", repo: "acme/web", clonePath: "/Users/x/Code/web", base: "main", name: "ca-1-fix-ab12", brief: "Look into it." };
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
    expect(supersessionKey(githubReview("Acme/WebShop"))).toBe('githubReview:["github:ada","acme/webshop",218]');
  });

  it("are left out for screens that approve with proposalsApprove", () => {
    const all = [proposal("1", subtasks("A-1")), proposal("2", githubReview("acme/webshop"))];
    expect(withoutRunDrafts(all).map((p) => p.id)).toEqual(["1"]);
  });
});

describe("draftExcerpt with an edit", () => {
  it("names a comment by its edited words when there are any", () => {
    const comment = { type: "comment", item: { connectionId: "c", key: "CA-1" }, body: docFromText("Stored") } as unknown as Intent;
    expect(draftExcerpt(comment, 40, { body: { text: "Edited" } })).toBe("Edited");
  });
});
