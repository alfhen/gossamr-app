import fixtures from "../lib/diffHunks.fixtures.json";
import type { ChangedFile, CodeChange, PullDiff } from "../types";
import type { PullDiffState } from "./pullViewStore";

const patches = fixtures.patches as Record<string, string>;

/** For tests: sample pull request #218 of acme/webshop and its files at `sha`, as `codePullDiff` serves them, from the diff fixtures the Rust side also runs. */
export function sample(sha = "a1b2c3d4e5f6"): PullDiffState {
  const files: ChangedFile[] = [
    { path: "src/consumer/retry.ts", status: "modified", additions: 6, deletions: 1, patch: patches.retry, truncated: false },
    { path: "src/consumer/index.ts", status: "modified", additions: 1, deletions: 1, patch: patches.index, truncated: false },
  ];
  const change: CodeChange = {
    connectionId: "github:sample",
    externalId: "pr:acme/webshop#218",
    kind: "pullRequest",
    repo: "acme/webshop",
    number: 218,
    title: "CA-402: Cache the category tree (agent)",
    headRef: "worktree-ca-402",
    baseRef: "main",
    state: "draft",
    mergedAt: null,
    createdAt: null,
    updatedAt: "2026-10-01T09:00:00Z",
    author: null,
    reviewers: [],
    checks: "passing",
    review: "none",
    url: "https://github.com/acme/webshop/pull/218",
    sha,
    additions: 84,
    deletions: 12,
    changedFiles: 2,
    body: "",
    linkedKeys: ["CA-402"],
  };
  return { status: "ready", diff: { change, files } satisfies PullDiff };
}
