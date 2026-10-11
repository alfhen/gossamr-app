import { useEffect } from "react";
import { create } from "zustand";
import { useBackend } from "../backend/useBackend";
import type { Backend } from "../backend/types";
import type { ReviewAccess } from "../types";

/**
 * What a review draft's card knows of a repository: still being asked, the answer, or an ask that failed, which reads as
 * can't post, with why, until it is asked again a moment later (`RETRY_MS`).
 */
export type AccessAnswer = { state: "asking" } | { state: "known"; access: ReviewAccess } | { state: "failed"; access: ReviewAccess };

/** How long a failed ask stands before it is asked again: a network blip or a rate limit says nothing lasting. */
export const RETRY_MS = 30_000;

interface ReviewAccessState {
  /** Answers by `connectionId|repo`, the repository lowercased. */
  answers: Record<string, AccessAnswer>;
  /** Asks the backend once per repository; later calls keep what is known. */
  ask(backend: Backend, connectionId: string, repo: string): void;
  /** Asks again, as after a post GitHub refused for want of access. */
  forget(connectionId: string, repo: string): void;
  /** Asks every repository again, as after a GitHub connection was added, removed or reconnected with another token. */
  forgetAll(): void;
}

export const accessKey = (connectionId: string, repo: string) => `${connectionId}|${repo.toLowerCase()}`;

export const useReviewAccess = create<ReviewAccessState>((set, get) => ({
  answers: {},

  ask(backend, connectionId, repo) {
    const key = accessKey(connectionId, repo);
    if (get().answers[key]) return;
    set((s) => ({ answers: { ...s.answers, [key]: { state: "asking" } } }));
    const asking = get().answers[key];
    // An answer to an ask the store has since forgotten (a reconnect, say) is dropped.
    const settle = (answer: AccessAnswer) => get().answers[key] === asking && set((s) => ({ answers: { ...s.answers, [key]: answer } }));
    void backend.codeReviewAccess(connectionId, repo).then(
      (access) => settle({ state: "known", access }),
      (e: unknown) => {
        const failed: AccessAnswer = { state: "failed", access: { canPost: false, reason: `Gossamr couldn't tell whether this token may post reviews on ${repo}: ${e instanceof Error ? e.message : String(e)}` } };
        settle(failed);
        setTimeout(() => get().answers[key] === failed && get().forget(connectionId, repo), RETRY_MS);
      },
    );
  },

  forget(connectionId, repo) {
    const key = accessKey(connectionId, repo);
    set((s) => {
      const answers = { ...s.answers };
      delete answers[key];
      return { answers };
    });
  },

  forgetAll() {
    set({ answers: {} });
  },
}));

/** Whether the token may post a review on `repo`, asked once per repository; null while asking or with no repository. */
export function useRepoReviewAccess(connectionId: string | null, repo: string | null): ReviewAccess | null {
  const backend = useBackend();
  const answer = useReviewAccess((s) => (connectionId && repo ? s.answers[accessKey(connectionId, repo)] : undefined));
  useEffect(() => {
    if (backend && connectionId && repo) useReviewAccess.getState().ask(backend, connectionId, repo);
  }, [backend, connectionId, repo, answer]);
  return answer?.state === "known" || answer?.state === "failed" ? answer.access : null;
}
