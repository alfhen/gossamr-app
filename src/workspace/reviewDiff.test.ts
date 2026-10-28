import { describe, expect, it, vi } from "vitest";
import type { Backend } from "../backend/types";
import type { CacheChanged, PullDiff } from "../types";
import { followPullDiff, type PullDiffState } from "./reviewDiff";

const GH = "github:ada";
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const diff = (sha: string) => ({ change: { sha }, files: [] }) as unknown as PullDiff;

/** A backend that has only what the diff follower asks of it, with the cache event under the test's control. */
function backend() {
  let head = "old";
  const cache = new Set<(c: CacheChanged) => void>();
  const read = vi.fn(async () => diff(head));
  const fake = {
    codePullDiff: read,
    onProposalsChanged: () => () => {},
    onDevLinksChanged: () => () => {},
    onCacheChanged: (l: (c: CacheChanged) => void) => (cache.add(l), () => void cache.delete(l)),
  } as unknown as Backend;
  return { fake, read, listening: () => cache.size, push: (sha: string) => (head = sha), tell: (connectionId: string) => cache.forEach((l) => l({ connectionId })) };
}

const sha = (state: PullDiffState | undefined) => (state?.status === "ready" ? (state.diff.change as unknown as { sha: string }).sha : undefined);

describe("following a pull request's diff", () => {
  it("reads it again when its own connection's cache changes after a code sync stores a new head", async () => {
    const b = backend();
    const seen: PullDiffState[] = [];
    const stop = followPullDiff(b.fake, GH, "acme/webshop", 218, (s) => seen.push(s));
    await settle();
    expect(sha(seen[seen.length - 1])).toBe("old");

    b.push("new");
    b.tell(GH);
    await settle();
    stop();
    expect(sha(seen[seen.length - 1])).toBe("new");
  });

  it("reads at most twice for two triggers in quick succession, and the last read wins", async () => {
    const b = backend();
    const seen: PullDiffState[] = [];
    const stop = followPullDiff(b.fake, GH, "acme/webshop", 218, (s) => seen.push(s));
    await settle();
    b.read.mockClear();

    b.push("newer");
    b.tell(GH);
    b.tell(GH);
    b.tell(GH);
    await settle();
    stop();
    expect(b.read).toHaveBeenCalledTimes(2);
    expect(sha(seen[seen.length - 1])).toBe("newer");
  });

  it("ignores a cache change of another connection", async () => {
    const b = backend();
    const stop = followPullDiff(b.fake, GH, "acme/webshop", 218, () => {});
    await settle();
    b.tell("jira:other");
    b.tell("mock");
    await settle();
    expect(b.read).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops listening once it is stopped", async () => {
    const b = backend();
    const stop = followPullDiff(b.fake, GH, "acme/webshop", 218, () => {});
    expect(b.listening()).toBe(1);
    stop();
    expect(b.listening()).toBe(0);
  });

  it("keeps the diff it has when a later read fails", async () => {
    const b = backend();
    const seen: PullDiffState["status"][] = [];
    const stop = followPullDiff(b.fake, GH, "acme/webshop", 218, (s) => seen.push(s.status));
    await settle();
    b.read.mockRejectedValue(new Error("offline"));
    b.tell(GH);
    await settle();
    stop();
    expect(seen).toEqual(["loading", "ready"]);
  });
});
