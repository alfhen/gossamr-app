import { describe, expect, it } from "vitest";
import type { Intent, Proposal, Run } from "../types";
import { draftPhrase, fromRunPhrase, runPhrase, humanDuration } from "./runNames";

const ref = (key: string) => ({ connectionId: "mock", externalId: key, key });
const run = (kind: string, key: string | null, id = "run-1") => ({ id, item: key ? ref(key) : null, spec: { role: kind, repo: "acme/webshop" } }) as unknown as Pick<Run, "id" | "spec" | "item">;
const draft = (intent: Intent): Pick<Proposal, "intent"> => ({ intent });

describe("runPhrase", () => {
  it("names a run by its ticket and step", () => {
    const named: [string, string][] = [
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

describe("durations", () => {
  describe("humanDuration", () => {
    it("says minutes below two hours", () => {
      expect(humanDuration(0)).toBe("under a minute");
      expect(humanDuration(0.5)).toBe("under a minute");
      expect(humanDuration(1)).toBe("1 min");
      expect(humanDuration(40)).toBe("40 min");
      expect(humanDuration(119)).toBe("119 min");
    });

    it("says hours below two days, rounded down", () => {
      expect(humanDuration(120)).toBe("2 h");
      expect(humanDuration(180)).toBe("3 h");
      expect(humanDuration(47 * 60 + 59)).toBe("47 h");
    });

    it("says days from two days on, never a three-figure hour count", () => {
      expect(humanDuration(48 * 60)).toBe("2 days");
      expect(humanDuration(247 * 60)).toBe("10 days");
      expect(humanDuration(30 * 24 * 60)).toBe("30 days");
    });

    it("treats a negative or non-finite span as none", () => {
      expect(humanDuration(-5)).toBe("under a minute");
      expect(humanDuration(Number.NaN)).toBe("under a minute");
    });
  });
});
