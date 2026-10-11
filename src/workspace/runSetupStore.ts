import { create } from "zustand";
import type { Backend } from "../backend/types";
import { itemKey } from "../lib/filter";
import type { CloneChoice, ContainerRef, ItemRef, Preflight, Proposal, ProposalEdit, Run, RunKind, RunReview, RunSpec } from "../types";
import { allContainers, useWorkspace } from "../workspaceStore";
import { defaultProject, defaultRepo, findRunDraft, kindBlock, linkedRepo, prChoices, repoChoices, ticketlessShape, type PrChoice } from "./runSheetLogic";
import { useRuns } from "./runsStore";
import { readStored, writeStored } from "./storage";
import { useTabs } from "./tabsStore";
import { messageOf, useToasts } from "./toasts";
import { useWorkstreams } from "./workstreamsStore";

const LAST_REPO_KEY = "gossamr-agent-repo";
const LAST_PROJECT_KEY = "gossamr-agent-project";
const CHANGED = /changed after you read it/i;

/**
 * Reads a run draft as the person is about to approve it: the review the backend would send (prompt, guard and digest),
 * then the checks for its spec. `onReview` sees the review as soon as it is read; returning false stops before the
 * checks. A failed check reads as no checks, which keeps Start off.
 */
export async function readRunDraft(backend: Backend, proposalId: string, onReview?: (review: RunReview) => boolean): Promise<{ review: RunReview; preflight: Preflight | null }> {
  const review = await backend.runsReview(proposalId);
  if (onReview && !onReview(review)) return { review, preflight: null };
  const preflight = await backend.runsPreflight(review.spec).catch(() => null);
  return { review, preflight };
}

/** What approving a run draft with the digest on screen came to: the run, a draft that changed after it was read, or another refusal. */
export type RunDraftStart = { type: "started"; run: Run } | { type: "changed" } | { type: "error"; message: string };

/** Approves run draft `proposalId` with the `digest` of the review the person read. The only way a drafted run starts. */
export async function approveRunDraft(backend: Backend, proposalId: string, digest: string): Promise<RunDraftStart> {
  try {
    return { type: "started", run: await backend.runsApprove(proposalId, digest) };
  } catch (e) {
    const message = messageOf(e);
    return CHANGED.test(message) ? { type: "changed" } : { type: "error", message };
  }
}

/**
 * What follows a start: the runs and drafts read again, the launch watched, the run selected and a toast. The setup
 * sheet goes on to the Agents view (`switchToAgents`), except over Pip home; a start inline on Pip home stays where the
 * person is too.
 */
export function afterRunStarted(run: Run, item: ItemRef | null, { switchToAgents }: { switchToAgents: boolean }) {
  const runs = useRuns.getState();
  void runs.reload();
  void useWorkspace.getState().refreshProposals();
  runs.watchLaunch(run.id);
  runs.select(run.id);
  if (switchToAgents) useTabs.getState().setRoute("agents");
  useToasts.getState().push(`Agent started${item ? ` on ${item.key}` : ""}. It runs in the background.`, "info", { label: "Open", run: () => runs.openRun(run.id) });
}

export type SetupPhase = "preparing" | "ready" | "starting";

export interface PrSearch {
  status: "idle" | "loading" | "ready" | "failed";
  query: string;
  choices: PrChoice[];
  error: string | null;
}

const NO_PRS: PrSearch = { status: "idle", query: "", choices: [], error: null };

export type RunEditFields = Omit<Extract<ProposalEdit, { type: "run" }>, "type">;

interface SetupState {
  open: boolean;
  backend: Backend | null;
  kind: RunKind;
  /** The pull request a review reads, once chosen. */
  pr: number | null;
  /** The plan run a build is made from; the backend reads its answer. */
  planFromRun: string | null;
  /** The build run a review is made from; the backend reads its answer. */
  buildFromRun: string | null;
  /** The Agents setting that offers runs the result tool is on, so a new draft asks for it. */
  reportAvailable: boolean;
  prs: PrSearch;
  item: ItemRef | null;
  /** What the ticket is called, for naming the worktree. */
  title: string | null;
  repo: string | null;
  /** Where the ticket of an investigation with no ticket lands. */
  project: ContainerRef | null;
  /** The person chose the project, so a change of repository leaves it alone. */
  projectChosen: boolean;
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
  /** Terminal was opened to trust a folder, so the sheet checks again when the person comes back. */
  trustOpened: boolean;
  /** The checks are being made again. */
  rechecking: boolean;
  reloadRepos(): Promise<void>;
  /** `repo` says where `pr` is, so a review opens in that repository. */
  begin(opts: { item?: ItemRef | null; proposalId?: string; kind?: RunKind; pr?: number; repo?: string; planFromRun?: string; buildFromRun?: string }): Promise<void>;
  /** Reads the plan again from its run, replacing what was edited. Only this changes it. */
  refreshPlan(): Promise<void>;
  /** Reads the builder's account again from its run, replacing what was edited. Only this changes it. */
  refreshBuildAccount(): Promise<void>;
  chooseKind(kind: RunKind): Promise<void>;
  searchPrs(query: string): Promise<void>;
  choosePr(number: number): Promise<void>;
  chooseRepo(repo: string): Promise<void>;
  chooseProject(project: ContainerRef): Promise<void>;
  chooseClone(path: string): Promise<void>;
  cloneFresh(): Promise<void>;
  saveEdit(edit: RunEditFields): Promise<void>;
  dismissChanged(): void;
  /** Opens Terminal in the folder with Claude, which asks its trust question there. Claude's own settings are never touched. */
  trustFolder(path: string): Promise<void>;
  /** Runs the checks again for the draft as it stands, without touching the draft. */
  recheck(): Promise<void>;
  start(): Promise<Run | null>;
  discard(): Promise<void>;
  close(): void;
}

const closed = {
  open: false,
  kind: "investigate" as RunKind,
  pr: null,
  planFromRun: null as string | null,
  buildFromRun: null as string | null,
  reportAvailable: false,
  prs: NO_PRS,
  item: null,
  title: null,
  repo: null,
  project: null,
  projectChosen: false,
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
  trustOpened: false,
  rechecking: false,
};

let run = 0;

const lastRepo = () => {
  const stored = readStored(LAST_REPO_KEY);
  return typeof stored === "string" ? stored : null;
};

const lastProject = (): ContainerRef | null => {
  const stored = readStored(LAST_PROJECT_KEY);
  const found = stored as Partial<ContainerRef> | null;
  return found && typeof found.connectionId === "string" && typeof found.externalId === "string" ? { connectionId: found.connectionId, externalId: found.externalId } : null;
};

export const useRunSetup = create<SetupState>((set, get) => {
  const current = (mine: number) => mine === run && get().open;
  let stopWatching: (() => void) | null = null;
  let repoRequest = 0;
  let prRequest = 0;
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
    const { preflight } = await readRunDraft(backend, proposalId, (review) => {
      if (current(mine)) set({ review });
      return current(mine);
    });
    if (current(mine)) set({ preflight });
  };

  /** The project for the ticket of a ticketless investigation in `repo`: the one the person chose, else the repository's usual one, else the last used, else the first watched. */
  const projectFor = async (backend: Backend, repo: string): Promise<ContainerRef | null> => {
    const { project, projectChosen } = get();
    if (projectChosen && project) return project;
    const repoProject = await backend.runsRepoProject(repo).catch(() => null);
    return defaultProject({ repoProject, last: lastProject(), projects: allContainers(useWorkspace.getState()) });
  };

  const prepare = async (mine: number) => {
    const { backend, item, repo, kind, pr, title, proposalId, ownDraft, planFromRun, buildFromRun } = get();
    if (!backend || !repo) return;
    set({ phase: "preparing", error: null, cloneError: null, cloning: false, choice: null, review: null, preflight: null, busy: false, rechecking: false });
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
      if (kindBlock(kind, item, pr)) {
        set({ phase: "ready", preflight: await backend.runsPreflight(null).catch(() => null) });
        return;
      }
      const name = await backend.runsSuggestName(clone.path, item?.key ?? repo.split("/").pop() ?? "task", title ?? "");
      const project = ticketlessShape(item, kind) ? await projectFor(backend, repo) : null;
      if (!current(mine)) return;
      set({ project });
      // A run on a ticket with an open workstream belongs to it, so the person's own runs group with Pip's.
      const workstream = item ? useWorkstreams.getState().forItem(item.key, item.connectionId)?.workstream.id : undefined;
      const spec: RunSpec = { kind, repo, clonePath: clone.path, base: clone.defaultBranch ?? clone.branch, name, instruction: "", focus: null, focusFromRun: null, ticketBlock: null, pr: kind === "review" ? pr : null, allowPush: kind === "build", report: kind === "review" || get().reportAvailable, plan: null, planFromRun: kind === "build" ? planFromRun : null, buildAccount: null, buildFromRun: kind === "review" ? buildFromRun : null, project, ...(workstream ? { workstream } : {}) };
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

    async begin({ item = null, proposalId, kind = "investigate", pr, repo: wanted, planFromRun = null, buildFromRun = null }) {
      const backend = useWorkspace.getState().backend;
      if (!backend || !useRuns.getState().ensureAgentsIntro()) return;
      const mine = ++run;
      useRuns.getState().closeSheet();
      const reportAvailable = !!(await backend.runsSettings().catch(() => null))?.reportResult;
      set({ ...closed, open: true, backend, kind, pr: pr ?? null, planFromRun, buildFromRun, reportAvailable, item, phase: "preparing" });
      latestWatched = [];
      stopWatching?.();
      stopWatching = backend.onWatchChanged(() => void loadRepos(run, true));
      const workspace = useWorkspace.getState();
      try {
        await loadRepos(mine);
        if (!current(mine)) return;
        // A build or review that follows a run opens the draft already following it, Pip's included.
        const waiting = findRunDraft(workspace.proposals, item, kind, pr, planFromRun || buildFromRun ? { planFromRun, buildFromRun } : undefined);
        // A ticketless draft from before projects existed would end as a comment with nowhere to go.
        const reusable = waiting?.intent.type === "startRun" && ticketlessShape(item, kind) && !waiting.intent.spec.project ? undefined : waiting;
        const id = proposalId ?? reusable?.id;
        if (id) {
          const draft: Proposal | null = await backend.proposalsGet(id);
          if (!current(mine)) return;
          if (draft?.intent.type !== "startRun" || draft.state.type !== "pending") throw new Error("that draft can't be started any more");
          const { spec, item: of } = draft.intent;
          const ticket = of ? workspace.items[itemKey(of)] : undefined;
          set({ item: of, kind: spec.kind, pr: spec.pr ?? null, planFromRun: spec.planFromRun ?? null, buildFromRun: spec.buildFromRun ?? null, title: ticket?.title ?? null, repo: spec.repo, project: spec.project ?? null, projectChosen: true, repos: repoChoices(latestWatched, useRuns.getState().runs), proposalId: id, ownDraft: false, fromPip: draft.createdBy === "pip", choice: await backend.runsClones(spec.repo) });
          await refresh(mine);
          if (current(mine)) set({ phase: "ready", initialInstruction: get().review?.instruction ?? null });
          return;
        }
        const title = item ? (workspace.items[itemKey(item)]?.title ?? null) : null;
        const links = item ? await backend.devLinks(item).catch(() => []) : [];
        if (!current(mine)) return;
        const watched = latestWatched;
        const repos = repoChoices(watched, useRuns.getState().runs);
        const repo = repos.find((r) => wanted && r.toLowerCase() === wanted.toLowerCase()) ?? defaultRepo(repos, item, useRuns.getState().runs, lastRepo(), linkedRepo(links, watched));
        set({ title, repos, repo, project: ticketlessShape(item, kind) ? defaultProject({ repoProject: null, last: lastProject(), projects: allContainers(workspace) }) : null });
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
      set({ repo, pr: null, prs: NO_PRS });
      await prepare(++run);
    },

    async chooseProject(project) {
      const { backend, proposalId } = get();
      writeStored(LAST_PROJECT_KEY, project);
      set({ project, projectChosen: true });
      if (backend && proposalId) await get().saveEdit({ project });
    },

    async chooseKind(kind) {
      const { kind: was, proposalId, ownDraft, repo } = get();
      if (kind === was || (proposalId && !ownDraft)) return;
      set({ kind, pr: null, prs: NO_PRS, error: null, ...(kind === "build" ? {} : { planFromRun: null }), ...(kind === "review" ? {} : { buildFromRun: null }) });
      if (repo) await prepare(++run);
    },

    async searchPrs(query) {
      const { backend, repo } = get();
      const mine = run;
      const text = query.trim();
      const request = ++prRequest;
      if (!backend || !repo || !text) return set({ prs: { ...NO_PRS, query: text } });
      set({ prs: { ...get().prs, query: text, status: "loading", error: null } });
      try {
        const found = await backend.codeSearch(text);
        if (request === prRequest && current(mine)) set({ prs: { status: "ready", query: text, choices: prChoices(found, repo), error: null } });
      } catch (e) {
        if (request === prRequest && current(mine)) set({ prs: { status: "failed", query: text, choices: [], error: messageOf(e) } });
      }
    },

    async choosePr(number) {
      if (number === get().pr) return;
      set({ pr: number });
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

    async refreshPlan() {
      const { backend, proposalId } = get();
      if (!backend || !proposalId) return;
      const mine = run;
      set({ busy: true, error: null });
      try {
        await backend.runsRefreshPlan(proposalId);
        await refresh(mine);
      } catch (e) {
        if (current(mine)) set({ error: messageOf(e) });
      } finally {
        if (current(mine)) set({ busy: false });
      }
    },

    async refreshBuildAccount() {
      const { backend, proposalId } = get();
      if (!backend || !proposalId) return;
      const mine = run;
      set({ busy: true, error: null });
      try {
        await backend.runsRefreshBuildAccount(proposalId);
        await refresh(mine);
      } catch (e) {
        if (current(mine)) set({ error: messageOf(e) });
      } finally {
        if (current(mine)) set({ busy: false });
      }
    },

    dismissChanged: () => set({ changed: false }),

    async trustFolder(path) {
      const { backend } = get();
      if (!backend) return;
      try {
        await backend.runsTrustPath(path);
        set({ trustOpened: true });
      } catch (e) {
        useToasts.getState().push(`Couldn't open Terminal: ${messageOf(e)}`);
      }
    },

    async recheck() {
      const { backend, review, rechecking, phase } = get();
      if (!backend || !review || rechecking || phase !== "ready") return;
      const mine = run;
      set({ rechecking: true });
      try {
        const preflight = await backend.runsPreflight(review.spec);
        if (current(mine)) set({ preflight });
      } catch {
        // The earlier checks stay on screen.
      } finally {
        if (current(mine)) set({ rechecking: false });
      }
    },

    async start() {
      const { backend, proposalId, review, phase, busy, item } = get();
      if (!backend || !proposalId || !review || phase === "starting" || busy) return null;
      const mine = run;
      set({ phase: "starting", error: null });
      const result = await approveRunDraft(backend, proposalId, review.digest);
      if (result.type === "started") {
        if (!current(mine)) return result.run;
        get().close();
        // Started from the sheet over Pip home, the person stays on Pip home, where the run shows on its step.
        afterRunStarted(result.run, item, { switchToAgents: useTabs.getState().route !== "pip" });
        return result.run;
      }
      if (!current(mine)) return null;
      if (result.type === "changed") {
        set({ phase: "ready", changed: true });
        await refresh(mine).catch((err) => set({ error: messageOf(err) }));
      } else set({ phase: "ready", error: result.message });
      return null;
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
