import { useEffect, useState } from "react";
import { useBackend } from "../backend/useBackend";
import type { PullDiff } from "../types";

export type PullDiffState = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; diff: PullDiff };

/** Pull request `number` with its files, read when asked and again whenever drafts or development links change (a push moves its head). */
export function usePullDiff(connectionId: string | null, repo: string | null, number: number | null): PullDiffState {
  const backend = useBackend();
  const [state, setState] = useState<PullDiffState>({ status: "loading" });
  useEffect(() => {
    if (!backend || !connectionId || !repo || !number) return;
    let current = true;
    const read = () =>
      backend.codePullDiff(connectionId, repo, number).then(
        (diff) => current && setState({ status: "ready", diff }),
        (e: unknown) => current && setState((was) => (was.status === "ready" ? was : { status: "error", error: e instanceof Error ? e.message : String(e) })),
      );
    setState({ status: "loading" });
    void read();
    const offs = [backend.onProposalsChanged(() => void read()), backend.onDevLinksChanged(() => void read())];
    return () => {
      current = false;
      offs.forEach((off) => off());
    };
  }, [backend, connectionId, repo, number]);
  return state;
}

/** Whether the pull request's head is still the commit a review read; the two may be spelled at different lengths. */
export const sameCommit = (a: string, b: string) => !!a && !!b && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));
