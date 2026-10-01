import { create } from "zustand";
import type { Backend } from "../backend/types";
import { itemKey } from "../lib/filter";
import type { CloneChoice, ItemRef, Preflight, Proposal, Run, RunKind, RunReview, RunSpec } from "../types";
import { useWorkspace } from "../workspaceStore";
import { defaultRepo, findRunDraft, linkedRepo, repoChoices } from "./runSheetLogic";
import { useRuns } from "./runsStore";
import { readStored, writeStored } from "./storage";
import { useTabs } from "./tabsStore";
import { messageOf, useToasts } from "./toasts";

const LAST_REPO_KEY = "gossamr-agent-repo";
const CHANGED = /changed after you read it/i;

export type SetupPhase = "preparing" | "ready" | "starting";

interface SetupState {
  open: boolean;
  backend: Backend | null;
  kind: RunKind;
  item: ItemRef | null;
  /** What the ticket is called, for naming the worktree. */
  title: string | null;
  repo: string | null;
  repos: string[];
  reposStatus: "loading" | "ready" | "failed";
  reposError: string | null;
  choice: CloneChoice | null;
  proposalId: string | null;
  /** The draft was made by this sheet, so it may be discarded and re-made when the repository changes. */
  ownDraft: boolean;
  /** Pip proposed the draft, so its focus note is Pip's. */
  fromPip: boolean;
  review: RunReview | null;
  preflight: Preflight | null;
  phase: SetupPhase;
  busy: boolean;
  error: string | null;
  /** A fresh copy is being cloned into ~/Gossamr/agents, and why the last attempt failed. */
  cloning: boolean;
  cloneError: string | null;
  /** The backend refused the digest: the draft changed after it was read. */
  changed: boolean;
  /** The instruction as first drafted, for resetting. */
  initialInstruction: string | null;
  reloadRepos(): Promise<void>;
  begin(opts: { item?: ItemRef | null; proposalId?: string; kind?: RunKind }): Promise<void>;
  chooseRepo(repo: string): Promise<void>;
  chooseClone(path: string): Promise<void>;
  cloneFresh(): Promise<void>;
  saveEdit(edit: { instruction?: string; base?: string }): Promise<void>;
  dismissChanged(): void;
  start(): Promise<Run | null>;
  discard(): Promise<void>;
  close(): void;
}

const closed = {
  open: false,
  kind: "investigate" as RunKind,
  item: null,
  title: null,
  repo: null,
  repos: [] as string[],
  reposStatus: "loading" as "loading" | "ready" | "failed",
  reposError: null,
  choice: null,
  proposalId: null,
  ownDraft: false,
  fromPip: false,
  review: null,
  preflight: null,
  phase: "ready" as SetupPhase,
  busy: false,
  error: null,
  cloning: false,
  cloneError: null,
  changed: false,
  initialInstruction: null,
};

let run = 0;

const lastRepo = () => {
  const stored = readStored(LAST_REPO_KEY);
  return typeof stored === "string" ? stored : null;
};

export const useRunSetup = create<SetupState>((set, get) => {
  const current = (mine: number) => mine === run && get().open;
  let stopWatching: (() => void) | null = null;
  let repoRequest = 0;
  let latestWatched: string[] = [];

  const loadRepos = async (mine: number, quiet = false): Promise<string[]> => {
    const { backend } = get();
    if (!backend) return [];
    const request = ++repoRequest;
    const latest = () => request === repoRequest && current(mine);
    if (!quiet) set({ reposStatus: "loading", reposError: null });
    try {
      const watched = await backend.runsRepos();
      if (latest()) {
        latestWatched = watched;
        set({ repos: repoChoices(watched, useRuns.getState().runs), reposStatus: "ready", reposError: null });
      }
    } catch (e) {
      if (latest()) {
        latestWatched = [];
        set({ repos: repoChoices([], useRuns.getState().runs), reposStatus: "failed", reposError: messageOf(e) });
      }
    }
    return latestWatched;
  };

  const refresh = async (mine: number) => {
    const { backend, proposalId } = get();
    if (!backend || !proposalId) return;
    const review = await backend.runsReview(proposalId);
    if (!current(mine)) return;
    set({ review });
    const preflight = await backend.runsPreflight(review.spec).catch(() => null);
    if (current(mine)) set({ preflight });
  };

  const prepare = async (mine: number) => {
    const { backend, item, repo, kind, title, proposalId, ownDraft } = get();
    if (!backend || !repo) return;
    set({ phase: "preparing", error: null, cloneError: null, cloning: false, choice: null, review: null, preflight: null, busy: false });
    try {
      if (proposalId && ownDraft) await backend.proposalsSkip(proposalId).catch(() => {});
      const choice = await backend.runsClones(repo);
      if (!current(mine)) return;
      set({ choice, proposalId: null });
      const clone = choice.clones[0];
      if (!clone) {
        set({ phase: "ready", preflight: await backend.runsPreflight(null).catch(() => null) });
        return;
      }
      const name = await backend.runsSuggestName(clone.path, item?.key ?? repo.split("/").pop() ?? "task", title ?? "");
      const spec: RunSpec = { kind, repo, clonePath: clone.path, base: clone.defaultBranch ?? clone.branch, name, instruction: "", focus: null, focusFromRun: null, ticketBlock: null };
      const draft = await backend.runsDraft(spec, item);
      if (!current(mine)) return void backend.proposalsSkip(draft.id).catch(() => {});
      set({ proposalId: draft.id, ownDraft: true });
      await refresh(mine);
      if (current(mine)) set({ phase: "ready", initialInstruction: get().review?.instruction ?? null });
      void useWorkspace.getState().refreshProposals();
    } catch (e) {
      if (current(mine)) set({ phase: "ready", error: messageOf(e) });
    }
  };

  return {
    ...closed,
    backend: null,

    async begin({ item = null, proposalId, kind = "investigate" }) {
      const backend = useWorkspace.getState().backend;
      if (!backend) return;
      const mine = ++run;
      useRuns.getState().closeSheet();
      set({ ...closed, open: true, backend, kind, item, phase: "preparing" });
      latestWatched = [];
      stopWatching?.();
      stopWatching = backend.onWatchChanged(() => void loadRepos(run, true));
      const workspace = useWorkspace.getState();
      try {
        await loadRepos(mine);
        if (!current(mine)) return;
        const id = proposalId ?? findRunDraft(workspace.proposals, item, kind)?.id;
        if (id) {
          const draft: Proposal | null = await backend.proposalsGet(id);
          if (!current(mine)) return;
          if (draft?.intent.type !== "startRun" || draft.state.type !== "pending") throw new Error("that draft can't be started any more");
          const { spec, item: of } = draft.intent;
          const ticket = of ? workspace.items[itemKey(of)] : undefined;
          set({ item: of, kind: spec.kind, title: ticket?.title ?? null, repo: spec.repo, repos: repoChoices(latestWatched, useRuns.getState().runs), proposalId: id, ownDraft: false, fromPip: draft.createdBy === "pip", choice: await backend.runsClones(spec.repo) });
          await refresh(mine);
          if (current(mine)) set({ phase: "ready", initialInstruction: get().review?.instruction ?? null });
          return;
        }
        const title = item ? (workspace.items[itemKey(item)]?.title ?? null) : null;
        const links = item ? await backend.devLinks(item).catch(() => []) : [];
        if (!current(mine)) return;
        const watched = latestWatched;
        const repos = repoChoices(watched, useRuns.getState().runs);
        const repo = defaultRepo(repos, item, useRuns.getState().runs, lastRepo(), linkedRepo(links, watched));
        set({ title, repos, repo });
        if (repo) await prepare(mine);
        else set({ phase: "ready", preflight: await backend.runsPreflight(null).catch(() => null) });
      } catch (e) {
        if (current(mine)) set({ phase: "ready", error: messageOf(e) });
      }
    },

    async reloadRepos() {
      await loadRepos(run);
    },

    async chooseRepo(repo) {
      if (repo === get().repo) return;
      writeStored(LAST_REPO_KEY, repo);
      set({ repo });
      await prepare(++run);
    },

    async chooseClone(path) {
      const { backend, proposalId, repo } = get();
      if (!backend || !proposalId || !repo) return;
      const mine = run;
      set({ busy: true, error: null });
      try {
        await backend.runsPickClone(repo, path).catch(() => {});
        await backend.proposalsEdit(proposalId, { type: "run", clonePath: path });
        await refresh(mine);
      } catch (e) {
        if (current(mine)) set({ error: messageOf(e) });
      } finally {
        if (current(mine)) set({ busy: false });
      }
    },

    async cloneFresh() {
      const { backend, repo, cloning } = get();
      if (!backend || !repo || cloning) return;
      const mine = run;
      set({ cloning: true, cloneError: null });
      try {
        await backend.runsCloneFresh(repo);
      } catch (e) {
        if (current(mine)) set({ cloning: false, cloneError: messageOf(e) });
        return;
      }
      if (!current(mine)) return;
      set({ cloning: false });
      await prepare(++run);
    },

    async saveEdit(edit) {
      const { backend, proposalId } = get();
      if (!backend || !proposalId) return;
      const mine = run;
      set({ busy: true, error: null });
      try {
        await backend.proposalsEdit(proposalId, { type: "run", ...edit });
        await refresh(mine);
      } catch (e) {
        if (current(mine)) set({ error: messageOf(e) });
      } finally {
        if (current(mine)) set({ busy: false });
      }
    },

    dismissChanged: () => set({ changed: false }),

    async start() {
      const { backend, proposalId, review, phase, busy, item } = get();
      if (!backend || !proposalId || !review || phase === "starting" || busy) return null;
      const mine = run;
      set({ phase: "starting", error: null });
      try {
        const started = await backend.runsApprove(proposalId, review.digest);
        if (!current(mine)) return started;
        get().close();
        const runs = useRuns.getState();
        void runs.reload();
        void useWorkspace.getState().refreshProposals();
        runs.select(started.id);
        useTabs.getState().setRoute("agents");
        useToasts.getState().push(`Agent started${item ? ` on ${item.key}` : ""}. It runs in the background.`, "info", { label: "Open", run: () => runs.openRun(started.id) });
        return started;
      } catch (e) {
        if (!current(mine)) return null;
        if (CHANGED.test(messageOf(e))) {
          set({ phase: "ready", changed: true });
          await refresh(mine).catch((err) => set({ error: messageOf(err) }));
        } else set({ phase: "ready", error: messageOf(e) });
        return null;
      }
    },

    async discard() {
      const { backend, proposalId } = get();
      get().close();
      if (!backend || !proposalId) return;
      try {
        await backend.proposalsSkip(proposalId);
        await useWorkspace.getState().refreshProposals();
      } catch (e) {
        useToasts.getState().push(`Couldn't discard the draft: ${messageOf(e)}`);
      }
    },

    close() {
      run++;
      stopWatching?.();
      stopWatching = null;
      set({ ...closed });
    },
  };
});
