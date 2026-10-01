import { describe, expect, it } from "vitest";
import type { Intent, Proposal, RunSpec } from "../types";
import { draftsForTurn, earlierDrafts, targetOf, withoutRunDrafts } from "./proposals";

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
