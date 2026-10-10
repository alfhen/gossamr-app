import { describe, expect, it } from "vitest";
import type { Intent, Proposal, RunSpec } from "../types";
import { draftsForTurn, earlierDrafts, inWorkstreamPane, supersession, supersessionKey, targetOf, withoutRunDrafts } from "./proposals";
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
