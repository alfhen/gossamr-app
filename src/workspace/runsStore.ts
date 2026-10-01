import { create } from "zustand";
import type { Backend } from "../backend/types";
import { targetOf } from "../lib/proposals";
import type { CleanupResult, Proposal, Run, RunsEnvironment } from "../types";
import { useWorkspace } from "../workspaceStore";
import { INSTALL_URL, failureHelp, type FailureAct } from "./failureHelp";
import { NO_FILTERS, attentionCount, groupRuns, navOrder, stepRun, type AgentFilters } from "./agentsLogic";
import { openTicketByKey, showMe } from "./jump";
import { readStored, writeStored } from "./storage";
import { messageOf, useToasts } from "./toasts";
import { useTabs } from "./tabsStore";

const SEEN_KEY = "gossamr-runs-seen";
const SEEN_KEPT = 500;

const loadSeen = (): ReadonlySet<string> => {
  const raw = readStored(SEEN_KEY);
  return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
};

/** What the sheet over the screen shows; starting an agent has its own store. */
export type RunSheetTarget = { type: "run"; id: string } | { type: "safety" };

interface RunsState {
  backend: Backend | null;
  runs: Run[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  environment: RunsEnvironment | null;
  filters: AgentFilters;
  selectedId: string | null;
  /** Ids of failed runs the person has had on screen; the rail badge counts the others. */
  seenFailed: ReadonlySet<string>;
  /** Ids of failed runs the person has taken the step in Terminal for, or copied its command; Retry waits for this. */
  terminalOpened: ReadonlySet<string>;
  /** Null until the person opens or closes the explainer, when it shows for a first visit with no runs. */
  introOpen: boolean | null;
  earlierOpen: boolean;
  stopping: boolean;
  /** The run a draft is being made from, so its buttons wait. */
  drafting: string | null;
  sheet: RunSheetTarget | null;
  /** The ticket picker for starting an agent without a ticket open. */
  picking: boolean;
  init(backend: Backend): void;
  dispose(): void;
  reload(): Promise<void>;
  checkEnvironment(): Promise<void>;
  setFilter(patch: Partial<AgentFilters>): void;
  clearFilters(): void;
  select(id: string | null): void;
  /** Opens the run's sheet, on the Agents view unless `stay` keeps the screen the person is on. */
  openRun(id: string, opts?: { stay?: boolean }): void;
  openSafety(): void;
  closeSheet(): void;
  setPicking(open: boolean): void;
  /** Moves the run sheet to the next (`1`) or previous (`-1`) run, in the order the Agents view lists them. */
  browse(delta: 1 | -1): void;
  stop(id: string): Promise<void>;
  startNow(id: string): Promise<void>;
  retryLaunch(id: string): Promise<void>;
  /** The step a failed launch needs the person for: Terminal to trust the folder or sign in, or the install page. */
  fix(id: string, act: Extract<FailureAct, "terminal" | "install">): Promise<void>;
  /** Notes that the person copied the command to run it themselves, which is as good as opening Terminal. */
  noteCopied(id: string): void;
  markSeen(): void;
  attach(id: string): Promise<void>;
  /** Drafts a comment from the run's result and takes the person to it. Nothing is posted. */
  draftComment(id: string): Promise<void>;
  /** Drafts a link saying the run's ticket is blocked by `blockerKey` and takes the person to it. Nothing is posted. */
  draftBlocker(id: string, blockerKey: string): Promise<void>;
  stopAll(): Promise<void>;
  /** Removes a finished run's worktree. Null when the call failed, which is shown as a message. */
  cleanup(id: string): Promise<CleanupResult | null>;
  /** Cleans up each run in turn and says how many Claude removed and what it kept. */
  cleanupAll(ids: readonly string[]): Promise<{ removed: number; refused: string[] }>;
  setEarlierOpen(open: boolean): void;
  setIntroOpen(open: boolean | null): void;
}

const idle = { runs: [] as Run[], status: "idle" as const, error: null, environment: null, selectedId: null, sheet: null as RunSheetTarget | null, picking: false };

/** A run that was failed and is not any more starts over: if it fails again, the rail badge counts it again. */
function forgetRecovered(seen: ReadonlySet<string>, runs: readonly Run[]): ReadonlySet<string> {
  const recovered = runs.filter((r) => r.state !== "failed" && seen.has(r.id));
  if (!recovered.length) return seen;
  const kept = new Set([...seen].filter((id) => !recovered.some((r) => r.id === id)));
  writeStored(SEEN_KEY, [...kept]);
  return kept;
}

const READY = "Draft ready. Nothing is posted until you approve it.";

/** Makes a draft from a run and shows it where it is approved: on the ticket it is about. */
async function draftFromRun(get: () => RunsState, set: (patch: Partial<RunsState>) => void, id: string, what: "comment" | "link", make: (backend: Backend) => Promise<Proposal>) {
  const { backend, drafting } = get();
  if (!backend || drafting) return;
  set({ drafting: id });
  try {
    const draft = await make(backend);
    await useWorkspace.getState().refreshProposals();
    const target = targetOf(draft.intent);
    const open = () => target && (showMe(target, { peek: true }) || void openTicketByKey(target.key));
    get().closeSheet();
    useToasts.getState().push(READY, "info", target ? { label: `Open ${target.key}`, run: open } : undefined);
    open();
  } catch (e) {
    useToasts.getState().push(`Couldn't draft the ${what === "comment" ? "comment" : "blocker"}: ${messageOf(e)}`);
  } finally {
    set({ drafting: null });
  }
}

let stop: (() => void) | null = null;
let seq = 0;

export const useRuns = create<RunsState>((set, get) => ({
  backend: null,
  filters: NO_FILTERS,
  seenFailed: loadSeen(),
  terminalOpened: new Set<string>(),
  introOpen: null,
  earlierOpen: false,
  stopping: false,
  drafting: null,
  ...idle,

  init(backend) {
    get().dispose();
    set({ backend, ...idle, status: "loading" });
    const offChanged = backend.onRunsChanged(() => void get().reload());
    const offOpen = backend.onOpenRun((id) => get().openRun(id));
    stop = () => (offChanged(), offOpen());
    void get().reload();
    void get().checkEnvironment();
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
    try {
      const runs = await backend.runsList();
      if (mine === seq) set({ runs, status: "ready", error: null, seenFailed: forgetRecovered(get().seenFailed, runs) });
    } catch (e) {
      if (mine === seq) set({ status: "error", error: messageOf(e) });
    }
  },

  async checkEnvironment() {
    const { backend } = get();
    if (!backend) return;
    const environment = await backend.runsEnvironment();
    if (get().backend === backend) set({ environment });
  },

  setFilter: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  clearFilters: () => set({ filters: NO_FILTERS }),
  select: (selectedId) => set({ selectedId }),

  openRun(id, opts) {
    set({ selectedId: id, filters: opts?.stay ? get().filters : NO_FILTERS, sheet: { type: "run", id } });
    const tabs = useTabs.getState();
    if (!opts?.stay || tabs.route === "settings" || tabs.route === "activity") tabs.setRoute("agents");
  },

  openSafety: () => set({ sheet: { type: "safety" } }),
  closeSheet: () => set({ sheet: null }),
  setPicking: (picking) => set({ picking }),

  browse(delta) {
    const { sheet, runs, filters, earlierOpen } = get();
    if (sheet?.type !== "run") return;
    const order = navOrder(groupRuns(runs, filters, Date.now()), earlierOpen, filters);
    const next = stepRun(order, sheet.id, delta);
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
      await backend.runsStartNow(id);
    } catch (e) {
      useToasts.getState().push(`Couldn't start it: ${messageOf(e)}`);
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
      const kind = get().runs.find((r) => r.id === id)?.failure?.type;
      await (kind === "notSignedIn" ? backend.runsSignIn(id) : backend.runsTrustFolder(id));
      get().noteCopied(id);
    } catch (e) {
      useToasts.getState().push(`Couldn't open ${act === "install" ? "the install page" : "Terminal"}: ${messageOf(e)}`);
    }
  },

  noteCopied(id) {
    if (!get().terminalOpened.has(id)) set({ terminalOpened: new Set([...get().terminalOpened, id]) });
  },

  markSeen() {
    const fresh = get().runs.filter((r) => r.state === "failed" && !get().seenFailed.has(r.id));
    if (!fresh.length) return;
    const seen = new Set([...get().seenFailed, ...fresh.map((r) => r.id)]);
    const kept = new Set([...seen].slice(-SEEN_KEPT));
    writeStored(SEEN_KEY, [...kept]);
    set({ seenFailed: kept });
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

  async draftComment(id) {
    await draftFromRun(get, set, id, "comment", (backend) => backend.runsDraftComment(id));
  },

  async draftBlocker(id, blockerKey) {
    await draftFromRun(get, set, id, "link", (backend) => backend.runsDraftBlocker(id, blockerKey));
  },

  async stopAll() {
    const { backend, stopping } = get();
    if (!backend || stopping) return;
    set({ stopping: true });
    try {
      const { stopped, failed } = await backend.runsStopAll();
      const text = `Stopped ${stopped} ${stopped === 1 ? "agent" : "agents"}`;
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
  setIntroOpen: (introOpen) => set({ introOpen }),
}));

/** The count on the rail's Agents button. */
export const useAttention = () => useRuns((s) => attentionCount(s.runs, s.seenFailed));
