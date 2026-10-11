import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Proposal } from "../types";
import { useWorkspace } from "../workspaceStore";
import { countOf, PullViewSheet, pullViewKey, stepPullNav, type Rovable } from "./PullView";
import { openPullView, pendingReviewDraft, sameCommit, usePullView } from "./pullViewStore";
import { sample } from "./reviewSample";

const RETRY = "src/consumer/retry.ts";
const at = (line: number, body: string) => ({ path: RETRY, line, side: "RIGHT" as const, body });
const review = (over: Partial<Proposal> = {}): Proposal => ({
  id: "r1",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:00:00Z",
  origin: { type: "run", runId: "run-1", shortId: "abcd1234" },
  createdBy: "agent",
  intent: { type: "githubReview", connectionId: "github:sample", item: null, runId: "run-1", repo: "acme/webshop", number: 218, commitSha: "a1b2c3d4e5f6", summary: "Gossamr review of #218.\n\nFindings without a line in the diff:\n- **Should fix:** no test covers the timeout path. (src/consumer/retry.test.ts)", comments: [at(42, "No backoff."), at(17, "Nit: name.")] },
  label: null,
  basis: null,
  state: { type: "pending" },
  revisions: [],
  created: [],
  error: null,
  run: null,
  ...over,
});
const target = { connectionId: "github:sample", repo: "acme/webshop", number: 218, proposalId: "r1" };
const key = (k: string, over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...over });

/** A stand-in for an element j and k step to. */
function item(name: string, focused: string[]): Rovable & { name: string } {
  return { name, tabIndex: -1, focus: () => void focused.push(name), contains: (other) => (other as unknown) === name };
}

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));
afterEach(() => {
  vi.unstubAllGlobals();
  usePullView.setState({ target: null, opener: null });
  useWorkspace.setState({ proposals: {}, watch: [] });
});

describe("the in-app pull request view", () => {
  it("shows the pull request, its files list and each file's unified diff, with the draft's comments under their lines", () => {
    const html = renderToStaticMarkup(<PullViewSheet target={target} draft={review()} onClose={vi.fn()} diff={sample()} />);
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-label="Pull request acme\/webshop#218"/);
    expect(html).toContain("CA-402: Cache the category tree (agent)");
    expect(html).toMatch(/data-pull-state[^>]*>draft</);
    expect(html).toContain("worktree-ca-402 → main");
    expect(html).toContain('href="https://github.com/acme/webshop/pull/218"');
    expect(html).toContain("Files changed (2)");
    expect(html).toContain(`data-pull-file-row="${RETRY}"`);
    expect(html).toContain('data-pull-file-row="src/consumer/index.ts"');
    expect(html).toContain("2 comments");
    // The summary, with its findings that have no line, comes first.
    expect(html).toMatch(/data-pull-summary[^>]*>Gossamr review of #218.\n\nFindings without a line in the diff:\n- \*\*Should fix:\*\* no test covers the timeout path/);
    // Each comment sits right under the line it is about.
    expect(html).toMatch(/<span class="pr-2">\+ {4}try \{ return await handle\(message\); \} catch \{ continue; \}<\/span><\/div><div role="note" aria-label="Comment on src\/consumer\/retry.ts:42"/);
    expect(html).toMatch(/<span class="pr-2">\+const MAX = 5;<\/span><\/div><div role="note" aria-label="Comment on src\/consumer\/retry.ts:17"/);
    expect(html.match(/data-pull-nav/g)).toHaveLength(4);
    expect(html).not.toContain("Comments on lines this diff doesn&#x27;t show now");
  });

  it("lists a comment whose line the diff no longer shows under its file", () => {
    const moved = review({ intent: { ...(review().intent as Extract<Proposal["intent"], { type: "githubReview" }>), comments: [at(99, "Gone.")] } });
    const html = renderToStaticMarkup(<PullViewSheet target={target} draft={moved} onClose={vi.fn()} diff={sample()} />);
    expect(html).toContain("Comments on lines this diff doesn&#x27;t show now");
    expect(html).toContain('aria-label="Comment on src/consumer/retry.ts:99"');
  });

  it("with no draft shows just the pull request", () => {
    const html = renderToStaticMarkup(<PullViewSheet target={{ ...target, proposalId: null }} draft={null} onClose={vi.fn()} diff={sample()} />);
    expect(html).not.toContain("data-pull-review");
    expect(html).not.toContain('role="note"');
    expect(html.match(/data-pull-nav/g)).toHaveLength(2);
  });

  it("moves focus with j and k through the files and comments, one at a time and keeping one in the Tab order", () => {
    const focused: string[] = [];
    const items = ["retry.ts", "retry.ts:17", "retry.ts:42", "index.ts"].map((n) => item(n, focused));
    expect(stepPullNav(items, null, 1)?.name).toBe("retry.ts");
    expect(stepPullNav(items, "retry.ts" as unknown as Element, 1)?.name).toBe("retry.ts:17");
    expect(stepPullNav(items, "retry.ts:17" as unknown as Element, 1)?.name).toBe("retry.ts:42");
    expect(stepPullNav(items, "retry.ts:42" as unknown as Element, -1)?.name).toBe("retry.ts:17");
    expect(items.map((i) => i.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(stepPullNav(items, "index.ts" as unknown as Element, 1)?.name).toBe("index.ts");
    expect(stepPullNav(items, "retry.ts" as unknown as Element, -1)?.name).toBe("retry.ts");
    expect(stepPullNav(items, null, -1)?.name).toBe("index.ts");
    expect(focused).toEqual(["retry.ts", "retry.ts:17", "retry.ts:42", "retry.ts:17", "index.ts", "retry.ts", "index.ts"]);
    expect(stepPullNav([], null, 1)).toBeNull();
  });

  it("takes j, k and Esc, never with a modifier and never while typing in a field", () => {
    expect([pullViewKey(key("j"), false), pullViewKey(key("k"), false), pullViewKey(key("Escape"), false)]).toEqual(["next", "prev", "close"]);
    expect(pullViewKey(key("j"), true)).toBeNull();
    expect(pullViewKey(key("k"), true)).toBeNull();
    expect(pullViewKey(key("Escape"), true)).toBeNull();
    expect(pullViewKey(key("j", { metaKey: true }), false)).toBeNull();
    expect(pullViewKey(key("k", { ctrlKey: true }), false)).toBeNull();
    expect(pullViewKey(key("a"), false)).toBeNull();
  });

  it("counts a file's comments in the singular for one", () => {
    expect([countOf(1, "comment"), countOf(2, "comment")]).toEqual(["1 comment", "2 comments"]);
  });

  it("closes and gives the keyboard back to what opened it", () => {
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => (f(), 0));
    const opener = { isConnected: true, focus: vi.fn() };
    usePullView.getState().open(target, opener);
    // Opened again from inside, the first opener is still the one to go back to.
    usePullView.getState().open({ ...target, proposalId: null }, { isConnected: true, focus: vi.fn() });
    expect(usePullView.getState().target).toEqual({ ...target, proposalId: null });
    usePullView.getState().close();
    expect(usePullView.getState().target).toBeNull();
    expect(opener.focus).toHaveBeenCalledOnce();
    const gone = { isConnected: false, focus: vi.fn() };
    usePullView.getState().open(target, gone);
    usePullView.getState().close();
    expect(gone.focus).not.toHaveBeenCalled();
  });

  it("opens with the pull request's pending review draft when one exists, on the draft's connection", () => {
    const older = review({ id: "r0", createdAt: "2026-09-30T10:00:00Z" });
    const done = review({ id: "r2", createdAt: "2026-10-02T10:00:00Z", state: { type: "applied" } });
    useWorkspace.setState({ proposals: { r0: older, r1: review(), r2: done } });
    expect(pendingReviewDraft(useWorkspace.getState().proposals, "ACME/webshop", 218)?.id).toBe("r1");
    expect(pendingReviewDraft(useWorkspace.getState().proposals, "acme/webshop", 219)).toBeNull();
    openPullView({ repo: "acme/webshop", number: 218 });
    expect(usePullView.getState().target).toEqual(target);
    usePullView.setState({ target: null });
    openPullView({ connectionId: "github:other", repo: "acme/webshop", number: 219 });
    expect(usePullView.getState().target).toEqual({ connectionId: "github:other", repo: "acme/webshop", number: 219, proposalId: null });
    usePullView.setState({ target: null });
    useWorkspace.setState({ proposals: {} });
    openPullView({ repo: "acme/webshop", number: 218 });
    expect(usePullView.getState().target).toBeNull();
  });

  it("tells the reviewed commit from a moved head at either length", () => {
    expect(sameCommit("a1b2c3d4e5f6", "a1b2c3d4e5f6a7b8")).toBe(true);
    expect(sameCommit("A1B2C3D4E5F6A7", "a1b2c3d4e5f6")).toBe(true);
    expect(sameCommit("a1b2c3d4e5f6", "moved1a2b3c")).toBe(false);
    expect(sameCommit("", "a1b2c3d4")).toBe(false);
  });
});
