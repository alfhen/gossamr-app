import { describe, expect, it } from "vitest";
import type { Intent, RunSpec } from "../types";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import { mockDigest } from "./mockRuns";

const spec: RunSpec = {
  kind: "investigate",
  repo: "acme/web",
  clonePath: "/Users/sample/Code/web",
  base: "main",
  name: "ca-412-fix-ab12",
  instruction: "Investigate this work.",
  focus: null,
  focusFromRun: null,
  ticketBlock: "CA-412: sample",
};
const startRun = (over: Partial<RunSpec> = {}): Intent => ({ type: "startRun", connectionId: "mock", item: itemRef("CA-412"), spec: { ...spec, ...over } });

async function draft(backend: MockBackend, over: Partial<RunSpec> = {}) {
  return backend.proposalsCreate(startRun(over));
}

describe("mock runs", () => {
  it("starts with eight scripted runs covering every lane", async () => {
    const runs = await new MockBackend().runsList();
    expect(runs).toHaveLength(8);
    const states = runs.map((r) => r.state).sort();
    expect(states).toEqual(["done", "done", "failed", "needsAnswer", "needsPermission", "working", "working", "working"]);
    const now = Date.parse("2026-09-30T12:00:00Z");
    const quiet = runs.filter((r) => r.state === "working" && now - Date.parse(r.lastProgressAt) >= 30 * 60_000);
    expect(quiet).toHaveLength(1);
    expect(runs.find((r) => r.state === "needsPermission")?.needs).toMatch(/^approve Bash:/);
  });

  it("is deterministic", async () => {
    const [a, b] = [await new MockBackend().runsList(), await new MockBackend().runsList()];
    expect(a).toEqual(b);
  });

  it("refuses a wrong digest and leaves no run behind", async () => {
    const backend = new MockBackend();
    const p = await draft(backend);
    const before = (await backend.runsList()).length;
    await expect(backend.runsApprove(p.id, "mock-0000")).rejects.toThrow(/changed after you read it/);
    expect(await backend.runsList()).toHaveLength(before);
    expect((await backend.proposalsGet(p.id))?.state.type).toBe("pending");
  });

  it("approves with the digest from the review, once", async () => {
    const backend = new MockBackend();
    const p = await draft(backend);
    const review = await backend.runsReview(p.id);
    expect(review.digest).toBe(mockDigest(spec));
    expect(review.prompt).toContain("Investigate this work.");
    const run = await backend.runsApprove(p.id, review.digest);
    expect(run).toMatchObject({ state: "queued", proposalId: p.id, digest: review.digest, expectedWorktree: "/Users/sample/Code/web/.claude/worktrees/ca-412-fix-ab12" });
    const stored = await backend.proposalsGet(p.id);
    expect(stored).toMatchObject({ state: { type: "applied" }, run: run.id });
    await expect(backend.runsApprove(p.id, review.digest)).rejects.toThrow(/applied/);
    expect((await backend.runsGet(run.id))?.id).toBe(run.id);
  });

  it("changes its digest when anything the agent receives changes", () => {
    const base = mockDigest(spec);
    for (const over of [{ instruction: "Other." }, { focus: "Look at the cache" }, { ticketBlock: "changed" }, { base: "dev" }, { name: "ca-412-fix-cd34" }]) {
      expect(mockDigest({ ...spec, ...over })).not.toBe(base);
    }
  });

  it("never approves a run draft through the generic path", async () => {
    const backend = new MockBackend();
    const p = await draft(backend);
    await expect(backend.proposalsApprove(p.id)).rejects.toThrow(/own button/);
    expect((await backend.proposalsGet(p.id))?.state.type).toBe("pending");
    expect(await backend.runsList({ item: itemRef("CA-412") })).toHaveLength(0);
  });

  it("walks a run through its states with advance", async () => {
    const backend = new MockBackend();
    const run = await backend.runsApprove((await draft(backend)).id, mockDigest(spec));
    const state = () => backend.runs.get(run.id)!.state;
    const seen = [state()];
    for (let i = 0; i < 4; i++) {
      backend.runs.advance(run.id);
      seen.push(state());
    }
    expect(seen).toEqual(["queued", "launching", "working", "done", "done"]);
    expect(backend.runs.get(run.id)).toMatchObject({ result: expect.any(String), endedAt: expect.any(String), shortId: expect.stringMatching(/^[0-9a-f]{8}$/) });
  });

  it("sends runs waiting on the person back to work and leaves finished ones alone", async () => {
    const backend = new MockBackend();
    const before = await backend.runsList();
    backend.runs.advance();
    const after = await backend.runsList();
    const stateOf = (list: typeof before, id: string) => list.find((r) => r.id === id)!.state;
    for (const r of before) {
      const next = stateOf(after, r.id);
      if (r.state === "needsPermission" || r.state === "needsAnswer") expect(next).toBe("working");
      if (r.state === "done" || r.state === "failed") expect(next).toBe(r.state);
    }
  });

  it("stops only runs that can be stopped", async () => {
    const backend = new MockBackend();
    const before = await backend.runsList();
    const active = before.filter((r) => ["working", "needsAnswer", "needsPermission", "systemBlocked"].includes(r.state));
    const { stopped, failed } = await backend.runsStopAll();
    expect({ stopped, failed }).toEqual({ stopped: active.length, failed: 0 });
    const after = await backend.runsList();
    for (const r of before.filter((x) => !active.includes(x))) expect(after.find((x) => x.id === r.id)?.state).toBe(r.state);
    expect(after.filter((r) => r.state === "stopped")).toHaveLength(active.length);
    expect(await backend.runsStopAll()).toEqual({ stopped: 0, failed: 0 });
  });

  it("answers a question, and only a question", async () => {
    const backend = new MockBackend();
    const [asking, permission] = ["needsAnswer", "needsPermission"].map((state) => backend.runs.list().find((r) => r.state === state)!);
    expect(asking.suggestedReply).toBeTruthy();
    await expect(backend.runsAnswer(asking.id, "   ")).rejects.toThrow(/Write an answer/);
    await expect(backend.runsAnswer(asking.id, "x".repeat(4001))).rejects.toThrow(/up to 4000 characters/);
    await expect(backend.runsAnswer(asking.id, "a\0b")).rejects.toThrow(/plain text/);
    await expect(backend.runsAnswer(permission.id, "Yes")).rejects.toThrow(/only be answered in Terminal/);
    const after = await backend.runsAnswer(asking.id, "Yes");
    expect(after).toMatchObject({ id: asking.id, state: "working", needs: null, suggestedReply: null, shortId: asking.shortId });
    await expect(backend.runsAnswer(asking.id, "Again")).rejects.toThrow(/isn't waiting for an answer/);
  });

  it("refuses to stop a run that is only queued", async () => {
    const backend = new MockBackend();
    const run = await backend.runsApprove((await draft(backend)).id, mockDigest(spec));
    await expect(backend.runsStop(run.id)).rejects.toThrow(/once it is working/);
  });

  it("emits runs-changed and open-run", async () => {
    const backend = new MockBackend();
    const changes: string[] = [];
    const opened: string[] = [];
    const off = [backend.onRunsChanged((c) => changes.push(c.connectionId)), backend.onOpenRun((id) => opened.push(id))];
    await backend.runsApprove((await draft(backend)).id, mockDigest(spec));
    backend.runs.advance();
    backend.runs.open("run-seed-1");
    off.forEach((f) => f());
    backend.runs.advance();
    expect(changes).toEqual(["mock", "mock"]);
    expect(opened).toEqual(["run-seed-1"]);
  });

  it("attaches only to runs that have a session, and retries only failed ones", async () => {
    const backend = new MockBackend();
    const failed = (await backend.runsList({ states: ["failed"] }))[0];
    await expect(backend.runsAttach(failed.id)).rejects.toThrow(/no session/);
    await expect(backend.runsRetryLaunch((await backend.runsList({ states: ["working"] }))[0].id)).rejects.toThrow(/failed/);
    expect((await backend.runsRetryLaunch(failed.id)).state).toBe("failed");
    await backend.runsTrustFolder(failed.id);
    expect((await backend.runsRetryLaunch(failed.id)).state).toBe("queued");
    const working = (await backend.runsList({ states: ["working"] }))[0];
    await backend.runsAttach(working.id);
    expect(backend.runs.attached).toEqual([working.id]);
  });

  it("has one failed launch of each kind, and the busy set's failed run is an untrusted folder", async () => {
    const failures = await new MockBackend({ runs: { seed: "failures" } }).runsList({ states: ["failed"] });
    expect(failures.map((r) => r.failure?.type).sort()).toEqual(["capReached", "claudeMissing", "noClone", "notSignedIn", "other", "untrustedFolder"]);
    for (const r of failures) expect([r.shortId, typeof r.error]).toEqual([null, "string"]);
    const [busy] = await new MockBackend().runsList({ states: ["failed"] });
    expect(busy.failure).toEqual({ type: "untrustedFolder", path: "/Users/sample/Code/storefront" });
    expect(busy.error).toContain("/Users/sample/Code/storefront");
  });

  it("opens Terminal to trust or sign in only for the failure it is meant for, and retry waits for it", async () => {
    const backend = new MockBackend({ runs: { seed: "failures" } });
    const by = async (type: string) => (await backend.runsList()).find((r) => r.failure?.type === type)!;
    const [untrusted, signedOut, other] = [await by("untrustedFolder"), await by("notSignedIn"), await by("other")];
    await expect(backend.runsTrustFolder(signedOut.id)).rejects.toThrow(/doesn't trust/);
    await expect(backend.runsSignIn(untrusted.id)).rejects.toThrow(/isn't signed in/);
    await expect(backend.runsTrustFolder(other.id)).rejects.toThrow();
    await expect(backend.runsTrustFolder("nope")).rejects.toThrow(/no longer exists/);
    expect((await backend.runsRetryLaunch(untrusted.id)).state).toBe("failed");
    expect((await backend.runsRetryLaunch(signedOut.id)).state).toBe("failed");
    expect(backend.runs.terminals).toEqual([]);

    await backend.runsTrustFolder(untrusted.id);
    await backend.runsSignIn(signedOut.id);
    expect(backend.runs.terminals).toEqual([untrusted.id, signedOut.id]);
    expect((await backend.runsRetryLaunch(untrusted.id)).state).toBe("queued");
    expect((await backend.runsRetryLaunch(signedOut.id)).state).toBe("queued");
    await expect(backend.runsTrustFolder(untrusted.id)).rejects.toThrow(/doesn't trust/);
  });

  it("reports Claude as signed in, and clears the blocking row, once signing in through Terminal worked", async () => {
    const backend = new MockBackend({ runs: { seed: "failures", environment: "signedOut" } });
    expect((await backend.runsEnvironment()).claude).toBe("signedOut");
    expect((await backend.runsPreflight(null)).blocking).toBe(true);
    await backend.runsSignIn((await backend.runsList()).find((r) => r.failure?.type === "notSignedIn")!.id);
    expect(await backend.runsEnvironment()).toEqual({ claude: "ok", version: "2.1.286" });
    expect((await backend.runsPreflight(null)).blocking).toBe(false);
  });

  it("can start empty, with many runs, or with Claude missing, and counts ages back from a chosen moment", async () => {
    expect(await new MockBackend({ runs: { seed: "empty" } }).runsList()).toEqual([]);
    const many = await new MockBackend({ runs: { seed: "many" } }).runsList();
    expect(many).toHaveLength(24);
    expect(new Set(many.map((r) => r.id)).size).toBe(24);
    expect(new Set(many.map((r) => r.expectedWorktree)).size).toBe(24);
    expect(many.some((r) => r.state === "stopped")).toBe(true);
    expect(await new MockBackend({ runs: { environment: "missing" } }).runsEnvironment()).toEqual({ claude: "missing", version: null });
    expect(await new MockBackend().runsEnvironment()).toEqual({ claude: "ok", version: "2.1.286" });
    const epoch = Date.parse("2026-10-01T09:00:00Z");
    const [newest] = await new MockBackend({ runs: { epoch } }).runsList();
    expect(epoch - Date.parse(newest.queuedAt)).toBeLessThan(60 * 60_000);
  });
});
