import { useEffect, useState } from "react";
import { create } from "zustand";
import { useBackend } from "../backend/useBackend";
import type { Proposal, PullDiff } from "../types";
import { useWorkspace } from "../workspaceStore";
import { codeWatch } from "./domains";

/** The pull request the in-app view shows, and the review draft whose comments it shows inline, if any. */
export interface PullViewTarget {
  connectionId: string;
  repo: string;
  number: number;
  proposalId?: string | null;
}

/** Something focus can go back to. */
export interface Opener {
  focus(): void;
  readonly isConnected: boolean;
}

interface PullViewState {
  target: PullViewTarget | null;
  /** What had the keyboard when the view opened; closing gives it back. */
  opener: Opener | null;
  /** Shows the view; `opener` is what has the keyboard now, unless named. */
  open(target: PullViewTarget, opener?: Opener | null): void;
  close(): void;
}

const focused = (): Opener | null => {
  if (typeof document === "undefined") return null;
  const at = document.activeElement;
  return at instanceof HTMLElement && at !== document.body ? at : null;
};

export const usePullView = create<PullViewState>((set, get) => ({
  target: null,
  opener: null,

  open(target, opener = focused()) {
    // Opened over an open view, the first opener is still the one to go back to.
    set({ target, opener: get().target ? get().opener : opener });
  },

  close() {
    const { opener } = get();
    set({ target: null, opener: null });
    if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
  },
}));

type ReviewDraft = Proposal & { intent: Extract<Proposal["intent"], { type: "githubReview" }> };

/** The pending GitHub review draft of pull request `number` in `repo`, the newest when there are several. */
export function pendingReviewDraft(proposals: Readonly<Record<string, Proposal>>, repo: string, number: number): ReviewDraft | null {
  const found = Object.values(proposals).filter(
    (p): p is ReviewDraft => p.intent.type === "githubReview" && p.state.type === "pending" && p.intent.repo.toLowerCase() === repo.toLowerCase() && p.intent.number === number,
  );
  return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/**
 * Opens the view of pull request `number` in `repo`. With no draft named, it shows the pending review draft of that pull
 * request when there is one; with no connection named, the draft's, else the first code host's.
 */
export function openPullView({ connectionId, repo, number, proposalId }: { connectionId?: string | null; repo: string; number: number; proposalId?: string | null }) {
  const ws = useWorkspace.getState();
  const draft = proposalId === undefined ? pendingReviewDraft(ws.proposals, repo, number) : null;
  const connection = connectionId ?? draft?.intent.connectionId ?? codeWatch(ws.watch)[0]?.connectionId;
  if (!connection) return;
  usePullView.getState().open({ connectionId: connection, repo, number, proposalId: proposalId ?? draft?.id ?? null });
}

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
