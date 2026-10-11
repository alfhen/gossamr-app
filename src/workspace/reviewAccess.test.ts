import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../backend/types";
import type { ReviewAccess } from "../types";
import { accessKey, RETRY_MS, useReviewAccess } from "./reviewAccess";

const GH = "github:ada";
const REPO = "acme/webshop";

/** A backend whose `codeReviewAccess` answers each ask in turn from `answers`, an Error rejecting it. */
function backendAnswering(...answers: (ReviewAccess | Error)[]) {
  const codeReviewAccess = vi.fn(async () => {
    const next = answers.shift() ?? { canPost: true, reason: null };
    if (next instanceof Error) throw next;
    return next;
  });
  return { backend: { codeReviewAccess } as unknown as Backend, codeReviewAccess };
}

const answer = () => useReviewAccess.getState().answers[accessKey(GH, REPO)];
const settled = () => vi.waitFor(() => expect(answer()?.state).not.toBe("asking"));

describe("the review-access store", () => {
  beforeEach(() => useReviewAccess.getState().forgetAll());
  afterEach(() => vi.useRealTimers());

  it("asks once per repository while it has an answer, whatever the case of its name", async () => {
    const { backend, codeReviewAccess } = backendAnswering({ canPost: true, reason: null });
    useReviewAccess.getState().ask(backend, GH, REPO);
    await settled();
    useReviewAccess.getState().ask(backend, GH, "Acme/Webshop");
    expect(codeReviewAccess).toHaveBeenCalledTimes(1);
    expect(answer()).toEqual({ state: "known", access: { canPost: true, reason: null } });
  });

  it("reads a failed ask as can't post with why, and asks again a moment later rather than for the rest of the session", async () => {
    vi.useFakeTimers();
    const { backend, codeReviewAccess } = backendAnswering(new Error("GitHub is limiting requests; try again in 5 seconds."), { canPost: true, reason: null });
    useReviewAccess.getState().ask(backend, GH, REPO);
    await vi.waitFor(() => expect(answer()?.state).toBe("failed"));
    expect(answer()).toMatchObject({ access: { canPost: false, reason: expect.stringContaining("GitHub is limiting requests") } });
    vi.advanceTimersByTime(RETRY_MS);
    expect(answer()).toBeUndefined();
    useReviewAccess.getState().ask(backend, GH, REPO);
    await vi.waitFor(() => expect(answer()?.state).toBe("known"));
    expect(codeReviewAccess).toHaveBeenCalledTimes(2);
    expect(answer()).toEqual({ state: "known", access: { canPost: true, reason: null } });
  });

  it("asks again after forget, and every repository again after forgetAll, as when GitHub is reconnected", async () => {
    const { backend, codeReviewAccess } = backendAnswering({ canPost: false, reason: "no" }, { canPost: true, reason: null }, { canPost: true, reason: null });
    useReviewAccess.getState().ask(backend, GH, REPO);
    await settled();
    useReviewAccess.getState().forget(GH, REPO);
    useReviewAccess.getState().ask(backend, GH, REPO);
    await vi.waitFor(() => expect(answer()).toEqual({ state: "known", access: { canPost: true, reason: null } }));
    useReviewAccess.getState().forgetAll();
    expect(useReviewAccess.getState().answers).toEqual({});
    useReviewAccess.getState().ask(backend, GH, REPO);
    await settled();
    expect(codeReviewAccess).toHaveBeenCalledTimes(3);
  });

  it("drops an answer to an ask forgotten while it was out", async () => {
    let resolve: (a: ReviewAccess) => void = () => {};
    const backend = { codeReviewAccess: vi.fn(() => new Promise<ReviewAccess>((r) => (resolve = r))) } as unknown as Backend;
    useReviewAccess.getState().ask(backend, GH, REPO);
    useReviewAccess.getState().forgetAll();
    resolve({ canPost: false, reason: "the old token's" });
    await Promise.resolve();
    expect(answer()).toBeUndefined();
  });
});
