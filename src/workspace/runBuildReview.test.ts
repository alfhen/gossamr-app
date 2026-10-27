import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run } from "../types";
import { pipAsks, reviewThisControl } from "./runSheetLogic";

let backend: MockBackend;
let build: Run;

beforeEach(async () => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
  backend = new MockBackend({ githubRepos: 14, runs: { epoch: Date.parse("2026-09-30T12:00:00Z"), seed: "kinds" } });
  await backend.watchSetMode("github:ada", "everything");
  build = (await backend.runsList()).find((r) => r.spec.role === "builder")!;
});

describe("a finished build in the mock", () => {
  it("has a draft pull request on a seeded ticket", async () => {
    expect(build).toMatchObject({ state: "done", item: { key: "CA-402" }, spec: { repo: "acme/webshop" } });
    const { change } = await backend.runsOutcome(build.id);
    expect(change).toMatchObject({ kind: "pullRequest", number: 218, state: "draft", repo: "acme/webshop", headRepo: "acme/webshop", headRef: `worktree-${build.spec.name}` });
    expect(backend.github.code.change("acme/webshop", 218)).toMatchObject({ state: "draft", sha: "a1b2c3d4e5f6" });
    expect(build.result).toContain("draft pull request");
  });
});

describe("Ask Pip to review", () => {
  it("is turned on only for a finished, fully read build with a reviewable pull request in its own repository", async () => {
    const change = (await backend.runsOutcome(build.id)).change!;
    expect(reviewThisControl(build, change)).toEqual({ enabled: true, reason: null });
    const off = (over: Partial<Run>, c: typeof change | null = change) => reviewThisControl({ ...build, ...over }, c);
    expect(off({ state: "working" }).reason).toContain("isn't finished");
    expect(off({ item: null }).reason).toContain("needs a ticket");
    expect(off({ result: " " }).reason).toContain("without a written answer");
    expect(off({ resultComplete: false }).reason).toContain("read in full");
    expect(off({}, null).reason).toContain("hasn't been found on GitHub yet");
    expect(off({}, { ...change, kind: "branch", number: null }).reason).toContain("hasn't been found on GitHub yet");
    expect(off({}, { ...change, headRepo: "mallory/webshop" }).reason).toContain("same repository");
    expect(off({}, { ...change, repo: "acme/other" }).reason).toContain("same repository");
    expect(off({}, { ...change, state: "merged" }).reason).toContain("merged");
    expect(off({}, { ...change, state: "closed" }).reason).toContain("closed");
    expect(off({}, { ...change, state: "open" }).enabled).toBe(true);
    expect(off({ spec: { ...build.spec, role: "investigator" } }).reason).toContain("Only a build");
  });

  it("sends Pip a short request that names the build, shown to the person as Ask Pip to review", () => {
    expect(pipAsks.review(build)).toEqual({ prompt: `Review it: the pull request the build ${build.id} opened.`, shown: "Ask Pip to review" });
  });
});
