import { useEffect, useState } from "react";
import type { Backend } from "../backend/types";
import { useBackend } from "../backend/useBackend";
import type { PullDiff } from "../types";

export type PullDiffState = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; diff: PullDiff };

/**
 * Reads pull request `number` with its files now, and again whenever drafts or development links change, or its own
 * connection's cache does (a code sync stores the head a push moved it to). Returns the unsubscribe.
 */
export function followPullDiff(backend: Backend, connectionId: string, repo: string, number: number, onState: (state: PullDiffState) => void): () => void {
  let current = true;
  let seen = false;
  let reading = false;
  let again = false;
  // One read at a time, and a trigger that arrives during one earns exactly one more, so an older answer never lands after a newer one.
  const read = async () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        await backend.codePullDiff(connectionId, repo, number).then(
          (diff) => {
            seen = true;
            if (current) onState({ status: "ready", diff });
          },
          (e: unknown) => {
            if (current && !seen) onState({ status: "error", error: e instanceof Error ? e.message : String(e) });
          },
        );
      } while (again && current);
    } finally {
      reading = false;
    }
  };
  onState({ status: "loading" });
  void read();
  const offs = [
    backend.onProposalsChanged(() => void read()),
    backend.onDevLinksChanged(() => void read()),
    backend.onCacheChanged((change) => change.connectionId === connectionId && void read()),
  ];
  return () => {
    current = false;
    offs.forEach((off) => off());
  };
}

/** Pull request `number` with its files, read when asked and kept current by `followPullDiff`. */
export function usePullDiff(connectionId: string | null, repo: string | null, number: number | null): PullDiffState {
  const backend = useBackend();
  const [state, setState] = useState<PullDiffState>({ status: "loading" });
  useEffect(() => {
    if (!backend || !connectionId || !repo || !number) return;
    return followPullDiff(backend, connectionId, repo, number, setState);
  }, [backend, connectionId, repo, number]);
  return state;
}

/** Whether the pull request's head is still the commit a review read; the two may be spelled at different lengths. */
export const sameCommit = (a: string, b: string) => !!a && !!b && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));
