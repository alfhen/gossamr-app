import { describe, expect, it } from "vitest";
import type { Intent, Proposal, Run, RunKind } from "../types";
import { draftPhrase, fromRunPhrase, runPhrase } from "./runNames";

const ref = (key: string) => ({ connectionId: "mock", externalId: key, key });
const run = (kind: RunKind, key: string | null, id = "run-1") => ({ id, item: key ? ref(key) : null, spec: { kind, repo: "acme/webshop" } }) as unknown as Pick<Run, "id" | "spec" | "item">;
const draft = (intent: Intent): Pick<Proposal, "intent"> => ({ intent });

describe("runPhrase", () => {
  it("names a run by its ticket and step", () => {
    const named: [RunKind, string][] = [
      ["investigate", "the CA-401 investigation"],
      ["triage", "the CA-401 triage"],
      ["plan", "the CA-401 plan"],
      ["build", "the CA-401 build"],
      ["review", "the CA-401 review"],
      ["verify", "the CA-401 verification"],
    ];
    for (const [kind, phrase] of named) expect(runPhrase(run(kind, "CA-401"))).toBe(phrase);
  });

  it("names a run with no ticket by its repository, and an unknown one plainly, never by an id", () => {
    expect(runPhrase(run("investigate", null))).toBe("the investigation on acme/webshop");
    expect(runPhrase(run("review", null))).toBe("the review on acme/webshop");
    expect(runPhrase(null)).toBe("an agent run");
    expect(runPhrase(undefined)).toBe("an agent run");
  });
});

describe("draftPhrase", () => {
  const body = { blocks: [] };
  it("names each kind of draft by what it is and where it goes", () => {
    expect(draftPhrase(draft({ type: "githubReview", connectionId: "gh", item: ref("CA-402"), runId: "run-1", repo: "acme/webshop", number: 218, commitSha: "a1b2c3d4", summary: "", comments: [] }))).toBe("the review of acme/webshop#218");
    expect(draftPhrase(draft({ type: "comment", item: ref("CA-402"), body }))).toBe("the comment draft on CA-402");
    expect(draftPhrase(draft({ type: "rewrite", item: ref("CA-401"), title: null, body: { from: "a", to: "b" } as never, flattened: [] }))).toBe("the description update for CA-401");
    expect(draftPhrase(draft({ type: "rewrite", item: ref("CA-401"), title: { from: "a", to: "b" } as never, body: null, flattened: [] }))).toBe("the title change for CA-401");
    expect(draftPhrase(draft({ type: "subtasks", parent: ref("CA-402"), summaries: ["a"] }))).toBe("the breakdown of CA-402");
    expect(draftPhrase(draft({ type: "create", container: { connectionId: "mock", externalId: "CA" }, fields: {} as never, link: null }))).toBe("the new ticket draft");
  });

  it("names a follow-up by the run it is for, when that run is known", () => {
    const followUp = draft({ type: "followUp", connectionId: "mock", runId: "run-7", shortId: "ab12cd34", item: ref("CA-402"), message: "m", reason: "r" });
    expect(draftPhrase(followUp, [run("review", "CA-402", "run-7")])).toBe("the follow-up for the CA-402 review");
    expect(draftPhrase(followUp)).toBe("the follow-up for the CA-402 run");
    expect(draftPhrase(followUp)).not.toContain("ab12cd34");
  });
});

describe("fromRunPhrase", () => {
  it("names the run a draft came from by its step when known, else by the draft's ticket", () => {
    const comment = draft({ type: "comment", item: ref("CA-402"), body: { blocks: [] } });
    expect(fromRunPhrase(comment, run("review", "CA-402"))).toBe("the CA-402 review");
    expect(fromRunPhrase(comment, undefined)).toBe("the CA-402 run");
    expect(fromRunPhrase(draft({ type: "githubReview", connectionId: "gh", item: ref("CA-402"), runId: "r", repo: "acme/webshop", number: 218, commitSha: "a", summary: "", comments: [] }), null)).toBe("the CA-402 review");
    expect(fromRunPhrase(draft({ type: "create", container: { connectionId: "mock", externalId: "CA" }, fields: {} as never, link: null }), null)).toBe("an agent run");
  });
});
