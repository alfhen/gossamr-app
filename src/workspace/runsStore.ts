import { create } from "zustand";
import type { Backend } from "../backend/types";
import { labelsByRun } from "../lib/workstreamStage";
import type { CleanupResult, ClearFilter, DeleteResult, ItemRef, Run } from "../types";
import { useWorkspace } from "../workspaceStore";
import { clearSentence } from "../lib/archiveRuns";
import { INSTALL_URL, failureHelp, type FailureAct } from "./failureHelp";
import { NO_FILTERS, agentGroups, stepRun, stopAllText, type AgentFilters, type NeedsScope } from "./agentsLogic";
import { openTicketByKey, showMe } from "./jump";
import { forgetSettledAnswers } from "./keptAnswers";
import { readStored, writeStored } from "./storage";
import { messageOf, useToasts } from "./toasts";
import { usePrefs } from "./prefs";
import { offerUndo } from "./undo";
import { useTabs } from "./tabsStore";
import { useWorkstreams } from "./workstreamsStore";

const DISMISSED_KEY = "gossamr-runs-dismissed";
/** How long the list is waited for before the view says so and offers Retry, rather than showing a spinner for good. */
export const LOAD_LIMIT_MS = 15_000;
const DISMISSED_KEPT = 500;

const loadDismissed = (): ReadonlySet<string> => {
  const raw = readStored(DISMISSED_KEY);
  return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
};

/** What the sheet over the screen shows; starting an agent has its own store. */
export type RunSheetTarget = { type: "run"; id: string } | { type: "safety" };

/**
 * The order j and k walk through: the one the sheet opened with (`snapshot`), runs gone from it dropped and new ones
 * added at the end, so a run that changes lane while its sheet is open keeps its place; the live order without one.
 */
export function browseList(snapshot: readonly string[] | null, live: readonly string[]): string[] {
  if (!snapshot) return [...live];
  const now = new Set(live);
  const kept = snapshot.filter((id) => now.has(id));
  const had = new Set(kept);
  return [...kept, ...live.filter((id) => !had.has(id))];
}

interface RunsState {
  backend: Backend | null;
  /** The runs on the Agents view; archived ones are in `archived`, so nothing that counts or lists runs sees them. */
  runs: Run[];
  archived: Run[];
  archivedOpen: boolean;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  filters: AgentFilters;
  selectedId: string | null;
  /**
   * Ids of runs whose failure, stop or unclear state the person dismissed, so they leave Needs you. Looking at a run never
   * adds one: a failure leaves only when it is dealt with (a retry or a fix) or dismissed.
   */
  dismissed: ReadonlySet<string>;
  /** Ids of failed runs the person has taken the step in Terminal for, or copied its command; Retry waits for this. */
  terminalOpened: ReadonlySet<string>;
  /** Whether the person has the explainer open. */
  introOpen: boolean;
  earlierOpen: boolean;
  stopping: boolean;
  /** The run a draft is being made from, so its buttons wait. */
  drafting: string | null;
  /** Runs whose answer is on its way to the agent. */
  answering: ReadonlySet<string>;
  /** Runs Pip started that have not left the queue: a launch that fails is announced. */
  launching: ReadonlySet<string>;
  sheet: RunSheetTarget | null;
  /** The order the run sheet browses in, taken when it opened; see `browseList`. */
  browseOrder: readonly string[] | null;
  /** Runs whose answer went through, with the progress time they had then: "Answer sent" shows until it moves on. */
  answered: Readonly<Record<string, string>>;
  init(backend: Backend): void;
  dispose(): void;
  reload(): Promise<void>;
  /** Loads again from wherever the store stands: from scratch when it has no backend (a hot reload resets it), else a re-read. */
  recover(): void;
  setFilter(patch: Partial<AgentFilters>): void;
  clearFilters(): void;
  select(id: string | null): void;
  /** Opens the run's sheet, on the Agents view unless `stay` keeps the screen the person is on. */
  openRun(id: string, opts?: { stay?: boolean }): void;
  openSafety(): void;
  closeSheet(): void;
  /** Shows a ticket's drafts, where a draft is approved, and closes the run sheet over it. */
  showDraft(item: ItemRef | null): void;
  /** Moves the run sheet to the next (`1`) or previous (`-1`) run, in the order the Agents view lists them, grouped as it is. */
  browse(delta: 1 | -1): void;
  stop(id: string): Promise<void>;
  startNow(id: string): Promise<void>;
  /** Sends the person's answer to a run that is asking a question; the run carries on under the same id. */
  answer(id: string, text: string): Promise<boolean>;
  /** Takes a listed session over as the continuation of a stopped or finished run, after the person chose it. */
  adoptSession(id: string, session: string): Promise<void>;
  retryLaunch(id: string): Promise<void>;
  /** The step a failed launch needs the person for: Terminal to trust the folder or sign in, or the install page. */
  fix(id: string, act: Extract<FailureAct, "terminal" | "install">): Promise<void>;
  /** Notes that the person copied the command to run it themselves, which is as good as opening Terminal. */
  noteCopied(id: string): void;
  /**
   * Takes run `id` out of Needs you: the person's explicit Dismiss of its failure, unclear state or possible
   * continuation. It is local (nothing reaches the run), so it offers Undo; `undismiss` is what Undo calls.
   */
  dismiss(id: string): void;
  /** Puts run `id` back in Needs you if it is dismissed, leaving every other dismissal as it is. */
  undismiss(id: string, before?: ReadonlySet<string>): void;
  attach(id: string): Promise<void>;
  stopAll(): Promise<void>;
  /** Removes a finished run's worktree. Null when the call failed, which is shown as a message. */
  cleanup(id: string): Promise<CleanupResult | null>;
  /** Cleans up each run in turn and says how many Claude removed and what it kept. */
  cleanupAll(ids: readonly string[]): Promise<{ removed: number; refused: string[] }>;
  setEarlierOpen(open: boolean): void;
  setArchivedOpen(open: boolean): void;
  /** Archives runs that are over, with an Undo that restores them. */
  archive(ids: readonly string[]): Promise<boolean>;
  restore(id: string): Promise<void>;
  /** Archives what `filter` selects, with an Undo; says how many. */
  clearFinished(filter: ClearFilter): Promise<number>;
  /** Deletes an archived run for good, and its worktree when asked. Null when the call failed, which is shown as a message. */
  deleteArchived(id: string, removeWorktree: boolean): Promise<DeleteResult | null>;
  setIntroOpen(open: boolean): void;
}

const idle = { runs: [] as Run[], archived: [] as Run[], launching: new Set<string>() as ReadonlySet<string>, status: "idle" as const, error: null, selectedId: null, sheet: null as RunSheetTarget | null, browseOrder: null };

// Set by needsActions, which can read Needs you; this store cannot import it without a cycle.
let noticeOpener: ((runId: string) => void) | null = null;
let scopeSource: () => NeedsScope | undefined = () => undefined;
export const setNoticeOpener = (open: (runId: string) => void, scope?: () => NeedsScope) => {
  noticeOpener = open;
  if (scope) scopeSource = scope;
};

/** Which runs and workstreams hold a need right now, for the Needs you filter. */
export const currentNeedsScope = () => scopeSource();

/** The order the Agents view lists runs in right now, grouped as it is. */
const liveOrder = (s: Pick<RunsState, "runs" | "filters" | "earlierOpen">) => agentGroups(usePrefs.getState().agentsGroup, s.runs, useWorkstreams.getState().list, s.filters, s.earlierOpen, Date.now(), currentNeedsScope()).order;

/** A run that was dismissed and has moved on (it retried, was resumed, carried on) starts over: if it fails or stops again, Needs you has it again. */
const DISMISSABLE: readonly Run["state"][] = ["failed", "stopped", "unknown"];

function forgetRecovered(dismissed: ReadonlySet<string>, runs: readonly Run[]): ReadonlySet<string> {
  const recovered = runs.filter((r) => !DISMISSABLE.includes(r.state) && dismissed.has(r.id));
  if (!recovered.length) return dismissed;
  const kept = new Set([...dismissed].filter((id) => !recovered.some((r) => r.id === id)));
  writeStored(DISMISSED_KEY, [...kept]);
  return kept;
}

/** A run Pip started that failed before it got a session: say why, with the way on. Once it has moved on it is no longer watched. */
function announceFailedLaunches(get: () => RunsState, set: (patch: Partial<RunsState>) => void) {
  const { launching, runs } = get();
  const watching = new Set(launching);
  for (const r of runs) if (r.createdBy === "pip" && (r.state === "queued" || r.state === "launching")) watching.add(r.id);
  if (!watching.size) return;
  const still = new Set<string>();
  for (const id of watching) {
    const run = runs.find((r) => r.id === id);
    if (!run) continue;
    if (run.state === "queued" || run.state === "launching") {
      still.add(id);
      continue;
    }
    if (run.state !== "failed") continue;
    const reason = failureHelp(run)?.summary ?? run.error ?? "no reason was given";
    const where = run.item?.key ? ` on ${run.item.key}` : "";
    useToasts.getState().push(`The agent${where} didn't start. ${reason}`, "error", { label: "Fix it", run: () => get().openRun(id) });
  }
  set({ launching: still });
}


const openDraftsOn = (target: ItemRef) => showMe(target, { peek: true }) || void openTicketByKey(target.key);

/** The toast for archived runs, with an Undo that brings them all back. */
function offerRestore(get: () => RunsState, ids: readonly string[], text: string) {
  offerUndo({
    what: "archive",
    text,
    undone: ids.length === 1 ? "Restored." : `Restored ${ids.length} runs.`,
    undo: async () => {
      const { backend } = get();
      if (!backend) return false;
      for (const id of ids) await backend.runsRestore(id);
      void get().reload();
    },
  });
}


let stop: (() => void) | null = null;
let seq = 0;

export const useRuns = create<RunsState>((set, get) => ({
  backend: null,
  filters: NO_FILTERS,
  dismissed: loadDismissed(),
  terminalOpened: new Set<string>(),
  introOpen: false,
  earlierOpen: false,
  archivedOpen: false,
  stopping: false,
  drafting: null,
  answering: new Set<string>(),
  answered: {},
  ...idle,

  init(backend) {
    get().dispose();
    set({ backend, ...idle, status: "loading" });
    const offChanged = backend.onRunsChanged(() => void get().reload());
    const offOpen = backend.onOpenRun((id) => (noticeOpener ? noticeOpener(id) : get().openRun(id)));
    stop = () => (offChanged(), offOpen());
    void get().reload();
  },

  dispose() {
    stop?.();
    stop = null;
    seq++;
    set({ backend: null, ...idle });
  },

  async reload() {
    const { backend } = get();
    if (!backend) return;
    const mine = ++seq;
    // Not a race on the call itself: an answer that arrives late still replaces the error.
    const watchdog = setTimeout(() => {
      if (mine === seq) set({ status: "error", error: "Reading your agents took too long." });
    }, LOAD_LIMIT_MS);
    try {
      const all = await backend.runsList();
      clearTimeout(watchdog);
      if (mine === seq) {
        const runs = all.filter((r) => !r.archivedAt);
        set({ runs, archived: all.filter((r) => r.archivedAt), status: "ready", error: null, dismissed: forgetRecovered(get().dismissed, runs) });
        forgetSettledAnswers(runs);
        announceFailedLaunches(get, set);
      }
    } catch (e) {
      clearTimeout(watchdog);
      if (mine === seq) set({ status: "error", error: messageOf(e) });
    }
  },

  recover() {
    const backend = get().backend ?? useWorkspace.getState().backend;
    if (!backend) return;
    if (get().backend !== backend) return get().init(backend);
    set({ status: "loading", error: null });
    void get().reload();
  },

  setFilter: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  clearFilters: () => set({ filters: NO_FILTERS }),
  select: (selectedId) => set({ selectedId }),

  openRun(id, opts) {
    const filters = opts?.stay ? get().filters : NO_FILTERS;
    set({ selectedId: id, filters, sheet: { type: "run", id }, browseOrder: liveOrder({ ...get(), filters }) });
    const tabs = useTabs.getState();
    if (!opts?.stay || tabs.route === "settings" || tabs.route === "activity") tabs.setRoute("agents");
  },

  openSafety: () => set({ sheet: { type: "safety" }, browseOrder: null }),
  closeSheet: () => set({ sheet: null, browseOrder: null }),

  showDraft(item) {
    get().closeSheet();
    if (item) openDraftsOn(item);
  },
  browse(delta) {
    const { sheet, browseOrder } = get();
    if (sheet?.type !== "run") return;
    const next = stepRun(browseList(browseOrder, liveOrder(get())), sheet.id, delta);
    if (next) set({ selectedId: next, sheet: { type: "run", id: next } });
  },

  async stop(id) {
    const { backend } = get();
    if (!backend) return;
    try {
      await backend.runsStop(id);
    } catch (e) {
      useToasts.getState().push(`Couldn't stop it: ${messageOf(e)}`);
    }
    void get().reload();
  },

  async startNow(id) {
    const { backend } = get();
    if (!backend) return;
    try {
      const run = await backend.runsStartNow(id);
      // Every slot is taken: it is left waiting for one rather than started.
      if (run.state === "queued" && run.slotWaitSince) useToasts.getState().push("Every slot is taken, so it waits and starts when one of the running agents finishes.", "info");
    } catch (e) {
      useToasts.getState().push(`Couldn't start it: ${messageOf(e)}`);
    }
    void get().reload();
  },

  async answer(id, text) {
    const { backend, answering } = get();
    if (!backend || answering.has(id)) return false;
    set({ answering: new Set([...answering, id]) });
    try {
      const run = await backend.runsAnswer(id, text);
      set({ answered: { ...get().answered, [id]: run.lastProgressAt } });
      useToasts.getState().push("Answer sent. Claude is picking it back up. Only the agent sees your answer; nothing goes to Jira.", "info");
      return true;
    } catch (e) {
      useToasts.getState().push(`Couldn't send the answer: ${messageOf(e)}`);
      return false;
    } finally {
      set({ answering: new Set([...get().answering].filter((x) => x !== id)) });
      void get().reload();
    }
  },

  async adoptSession(id, session) {
    const { backend } = get();
    if (!backend) return;
    try {
      await backend.runsAdoptSession(id, session);
      useToasts.getState().push(`Adopted session ${session.slice(0, 8)}. Gossamr follows that session from here.`, "info");
    } catch (e) {
      useToasts.getState().push(`Couldn't adopt the session: ${messageOf(e)}`);
    }
    void get().reload();
  },

  async retryLaunch(id) {
    const { backend } = get();
    if (!backend) return;
    try {
      const before = get().runs.find((r) => r.id === id);
      const after = await backend.runsRetryLaunch(id);
      const help = after.state === "failed" ? failureHelp(after) : null;
      const again = !!help?.retryNeedsTerminal && help.kind === before?.failure?.type;
      if (!again && get().terminalOpened.has(id)) {
        const opened = new Set(get().terminalOpened);
        opened.delete(id);
        set({ terminalOpened: opened });
      }
      if (after.state === "failed") {
        useToasts.getState().push(again ? `Still blocked: ${help.summary} Finish the step in Terminal, then retry.` : `It failed again: ${after.error ?? "no reason was given"}`);
      }
    } catch (e) {
      useToasts.getState().push(`Couldn't retry the launch: ${messageOf(e)}`);
    }
    void get().reload();
  },

  async fix(id, act) {
    const { backend } = get();
    if (!backend) return;
    try {
      if (act === "install") return await backend.openUrl(INSTALL_URL);
      const failure = get().runs.find((r) => r.id === id)?.failure;
      if (failure?.type === "modeRefused") await backend.runsAcceptMode(id, failure.mode);
      else await (failure?.type === "notSignedIn" ? backend.runsSignIn(id) : backend.runsTrustFolder(id));
      get().noteCopied(id);
    } catch (e) {
      useToasts.getState().push(`Couldn't open ${act === "install" ? "the install page" : "Terminal"}: ${messageOf(e)}`);
    }
  },

  noteCopied(id) {
    if (!get().terminalOpened.has(id)) set({ terminalOpened: new Set([...get().terminalOpened, id]) });
  },

  dismiss(id) {
    const before = get().dismissed;
    if (before.has(id)) return;
    const kept = new Set([...before, id].slice(-DISMISSED_KEPT));
    writeStored(DISMISSED_KEY, [...kept]);
    set({ dismissed: kept });
    // A quiet spell is remembered as `quiet:<run id>@<last progress>`; the run is the part between.
    const quiet = id.startsWith("quiet:");
    const runId = quiet ? id.slice("quiet:".length).split("@")[0] : id;
    const run = get().runs.find((r) => r.id === runId);
    const name = labelsByRun(get().runs).get(runId) ?? run?.item?.key ?? "the run";
    // Local only: nothing reached the run, so it can be put back exactly.
    offerUndo({ what: quiet ? "keep waiting" : "dismiss", text: quiet ? `Waiting on ${name}; it is out of Needs you for now.` : `Dismissed ${name} from Needs you.`, undone: `${name} is back in Needs you.`, undo: async () => get().undismiss(id, before) });
  },

  undismiss(id, before) {
    const now = get().dismissed;
    if (!now.has(id)) return;
    // What it was before the dismissal, plus anything dismissed since.
    const had = before ?? new Set<string>();
    const kept = new Set([...had, ...[...now].filter((x) => x !== id && !had.has(x))].slice(-DISMISSED_KEPT));
    writeStored(DISMISSED_KEY, [...kept]);
    set({ dismissed: kept });
  },

  async attach(id) {
    const { backend } = get();
    if (!backend) return;
    try {
      await backend.runsAttach(id);
    } catch (e) {
      useToasts.getState().push(`Couldn't open Terminal: ${messageOf(e)}`);
    }
  },

  async stopAll() {
    const { backend, stopping } = get();
    if (!backend || stopping) return;
    set({ stopping: true });
    try {
      const { stopped, failed, waiting = 0 } = await backend.runsStopAll();
      const text = `Stopped ${stopAllText(stopped, waiting)}`;
      useToasts.getState().push(failed ? `${text}. ${failed} couldn't be stopped.` : text, failed ? "error" : "info");
    } catch (e) {
      useToasts.getState().push(`Couldn't stop the agents: ${messageOf(e)}`);
    } finally {
      set({ stopping: false });
      void get().reload();
    }
  },

  async cleanup(id) {
    const { backend } = get();
    if (!backend) return null;
    try {
      return await backend.runsCleanup(id);
    } catch (e) {
      useToasts.getState().push(`Couldn't clean it up: ${messageOf(e)}`);
      return null;
    } finally {
      void get().reload();
    }
  },

  async cleanupAll(ids) {
    const tally = { removed: 0, refused: [] as string[] };
    for (const id of ids) {
      const result = await get().cleanup(id);
      if (result?.type === "removed") tally.removed++;
      else if (result?.type === "refused") tally.refused.push(result.message);
    }
    return tally;
  },

  setEarlierOpen: (earlierOpen) => set({ earlierOpen }),
  setArchivedOpen: (archivedOpen) => set({ archivedOpen }),

  async archive(ids) {
    const { backend } = get();
    if (!backend || !ids.length) return false;
    try {
      const done = await backend.runsArchive([...ids]);
      if (done.length) offerRestore(get, done, done.length === 1 ? `Archived ${labelsByRun(get().runs).get(done[0]) ?? get().runs.find((r) => r.id === done[0])?.item?.key ?? "the run"}.` : `Archived ${done.length} runs.`);
      return done.length > 0;
    } catch (e) {
      useToasts.getState().push(`Couldn't archive it: ${messageOf(e)}`);
      return false;
    } finally {
      void get().reload();
    }
  },

  async restore(id) {
    const { backend } = get();
    if (!backend) return;
    try {
      await backend.runsRestore(id);
    } catch (e) {
      useToasts.getState().push(`Couldn't restore it: ${messageOf(e)}`);
    }
    void get().reload();
  },

  async clearFinished(filter) {
    const { backend } = get();
    if (!backend) return 0;
    try {
      const done = await backend.runsClear(filter);
      if (done.length) offerRestore(get, done, `${clearSentence({ ids: done }, filter).replace(/^Archive/, "Archived")}.`);
      else useToasts.getState().push("Nothing was archived.", "info");
      return done.length;
    } catch (e) {
      useToasts.getState().push(`Couldn't clear them: ${messageOf(e)}`);
      return 0;
    } finally {
      void get().reload();
    }
  },

  async deleteArchived(id, removeWorktree) {
    const { backend } = get();
    if (!backend) return null;
    try {
      return await backend.runsDelete(id, removeWorktree);
    } catch (e) {
      useToasts.getState().push(`Couldn't delete it: ${messageOf(e)}`);
      return null;
    } finally {
      void get().reload();
    }
  },
  setIntroOpen: (introOpen) => set({ introOpen }),
}));
