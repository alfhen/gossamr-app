import { create } from "zustand";
import type { Backend } from "../backend/types";
import { targetOf } from "../lib/proposals";
import type { CleanupResult, ItemRef, PlanComment, Proposal, Run, RunsEnvironment } from "../types";
import { useWorkspace } from "../workspaceStore";
import { INSTALL_URL, failureHelp, type FailureAct } from "./failureHelp";
import { NO_FILTERS, agentGroups, attentionCount, stepRun, type AgentFilters } from "./agentsLogic";
import { showDraft } from "./draftTicket";
import { openTicketByKey, showMe } from "./jump";
import { planCommentMessage } from "./runSheetLogic";
import { readStored, writeStored } from "./storage";
import { messageOf, useToasts } from "./toasts";
import { usePrefs } from "./prefs";
import { useTabs } from "./tabsStore";
import { useWorkstreams } from "./workstreamsStore";

const SEEN_KEY = "gossamr-runs-seen";
/** How long the list is waited for before the view says so and offers Retry, rather than showing a spinner for good. */
export const LOAD_LIMIT_MS = 15_000;
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
  /** Runs whose answer is on its way to the agent. */
  answering: ReadonlySet<string>;
  /** Runs the person just started and has not been told the outcome of: a launch that fails is announced and opened. */
  launching: ReadonlySet<string>;
  sheet: RunSheetTarget | null;
  /** The ticket picker for starting an agent without a ticket open. */
  picking: boolean;
  init(backend: Backend): void;
  dispose(): void;
  reload(): Promise<void>;
  /** Loads again from wherever the store stands: from scratch when it has no backend (a hot reload resets it), else a re-read. */
  recover(): void;
  /** Watches a run just started until it leaves the queue; if it failed to launch, says why and opens it. */
  watchLaunch(id: string): void;
  checkEnvironment(): Promise<void>;
  setFilter(patch: Partial<AgentFilters>): void;
  clearFilters(): void;
  select(id: string | null): void;
  /** Opens the run's sheet, on the Agents view unless `stay` keeps the screen the person is on. */
  openRun(id: string, opts?: { stay?: boolean }): void;
  openSafety(): void;
  closeSheet(): void;
  /** Shows a ticket's drafts, where a draft is approved, and closes the run sheet over it. */
  showDraft(item: ItemRef | null): void;
  setPicking(open: boolean): void;
  /** False when it opened the safety sheet because the person has not seen it; callers stop there. */
  ensureAgentsIntro(): boolean;
  /** Moves the run sheet to the next (`1`) or previous (`-1`) run, in the order the Agents view lists them, grouped as it is. */
  browse(delta: 1 | -1): void;
  stop(id: string): Promise<void>;
  startNow(id: string): Promise<void>;
  /** Sends the person's answer to a run that is asking a question; the run carries on under the same id. */
  answer(id: string, text: string): Promise<void>;
  /** Takes a listed session over as the continuation of a stopped or finished run, after the person chose it. */
  adoptSession(id: string, session: string): Promise<void>;
  retryLaunch(id: string): Promise<void>;
  /** The step a failed launch needs the person for: Terminal to trust the folder or sign in, or the install page. */
  fix(id: string, act: Extract<FailureAct, "terminal" | "install">): Promise<void>;
  /** Notes that the person copied the command to run it themselves, which is as good as opening Terminal. */
  noteCopied(id: string): void;
  markSeen(): void;
  attach(id: string): Promise<void>;
  /** Drafts a comment from the run's result and takes the person to it. Nothing is posted. */
  draftComment(id: string): Promise<void>;
  /** Drafts the whole plan of a plan run as a comment, and says when it had to be cut to fit. */
  draftPlanComment(id: string): Promise<void>;
  /** Drafts the ticket's description with the plan added and opens the diff. Nothing is written. */
  draftPlanDescription(id: string): Promise<void>;
  /** Drafts a link saying the run's ticket is blocked by `blockerKey` and takes the person to it. Nothing is posted. */
  draftBlocker(id: string, blockerKey: string): Promise<void>;
  /** Drafts a new ticket from a finished run that has no ticket and opens the draft. Nothing is created. */
  draftTicket(id: string): Promise<void>;
  stopAll(): Promise<void>;
  /** Removes a finished run's worktree. Null when the call failed, which is shown as a message. */
  cleanup(id: string): Promise<CleanupResult | null>;
  /** Cleans up each run in turn and says how many Claude removed and what it kept. */
  cleanupAll(ids: readonly string[]): Promise<{ removed: number; refused: string[] }>;
  setEarlierOpen(open: boolean): void;
  setIntroOpen(open: boolean | null): void;
}

const idle = { runs: [] as Run[], launching: new Set<string>() as ReadonlySet<string>, status: "idle" as const, error: null, environment: null, selectedId: null, sheet: null as RunSheetTarget | null, picking: false };

/** A run that was failed and is not any more starts over: if it fails again, the rail badge counts it again. */
function forgetRecovered(seen: ReadonlySet<string>, runs: readonly Run[]): ReadonlySet<string> {
  const recovered = runs.filter((r) => r.state !== "failed" && seen.has(r.id));
  if (!recovered.length) return seen;
  const kept = new Set([...seen].filter((id) => !recovered.some((r) => r.id === id)));
  writeStored(SEEN_KEY, [...kept]);
  return kept;
}

/** A run the person started that failed before it got a session: say why, with the way on, and open it. Once it has moved on it is no longer watched. */
function announceFailedLaunches(get: () => RunsState, set: (patch: Partial<RunsState>) => void) {
  const { launching, runs } = get();
  if (!launching.size) return;
  const still = new Set<string>();
  for (const id of launching) {
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
    if (!get().sheet) get().openRun(id);
  }
  set({ launching: still });
}

const READY = "Draft ready. Nothing is posted until you approve it.";

const openDraftsOn = (target: ItemRef) => showMe(target, { peek: true }) || void openTicketByKey(target.key);

/** Makes a draft from a run and shows it where it is approved: on the ticket it is about. */
async function draftFromRun(get: () => RunsState, set: (patch: Partial<RunsState>) => void, id: string, what: "comment" | "link" | "description", make: (backend: Backend) => Promise<Proposal>, ready: () => string = () => READY) {
  const { backend, drafting } = get();
  if (!backend || drafting) return;
  set({ drafting: id });
  try {
    const draft = await make(backend);
    await useWorkspace.getState().refreshProposals();
    const target = targetOf(draft.intent);
    get().closeSheet();
    useToasts.getState().push(ready(), "info", target ? { label: `Open ${target.key}`, run: () => openDraftsOn(target) } : undefined);
    if (target) openDraftsOn(target);
  } catch (e) {
    useToasts.getState().push(`Couldn't draft the ${what === "link" ? "blocker" : what}: ${messageOf(e)}`);
  } finally {
    set({ drafting: null });
  }
}

const TICKET_READY = "Draft ticket ready. Nothing is created until you approve it.";

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
  answering: new Set<string>(),
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
    // Not a race on the call itself: an answer that arrives late still replaces the error.
    const watchdog = setTimeout(() => {
      if (mine === seq) set({ status: "error", error: "Reading your agents took too long." });
    }, LOAD_LIMIT_MS);
    try {
      const runs = await backend.runsList();
      clearTimeout(watchdog);
      if (mine === seq) {
        set({ runs, status: "ready", error: null, seenFailed: forgetRecovered(get().seenFailed, runs) });
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
    void get().checkEnvironment();
  },

  watchLaunch(id) {
    set({ launching: new Set([...get().launching, id]) });
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

  showDraft(item) {
    get().closeSheet();
    if (item) openDraftsOn(item);
  },
  ensureAgentsIntro() {
    const prefs = usePrefs.getState();
    if (prefs.agentsIntroSeen) return true;
    prefs.setAgentsIntroSeen(true);
    set({ sheet: { type: "safety" }, picking: false });
    return false;
  },

  setPicking(picking) {
    if (picking && !get().ensureAgentsIntro()) return;
    set({ picking });
  },

  browse(delta) {
    const { sheet, runs, filters, earlierOpen } = get();
    if (sheet?.type !== "run") return;
    const order = agentGroups(usePrefs.getState().agentsGroup, runs, useWorkstreams.getState().list, filters, earlierOpen, Date.now()).order;
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

  async answer(id, text) {
    const { backend, answering } = get();
    if (!backend || answering.has(id)) return;
    set({ answering: new Set([...answering, id]) });
    try {
      await backend.runsAnswer(id, text);
    } catch (e) {
      useToasts.getState().push(`Couldn't send the answer: ${messageOf(e)}`);
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

  async draftPlanComment(id) {
    let made: PlanComment | null = null;
    const message = () => (made ? planCommentMessage(made) : READY);
    await draftFromRun(
      get,
      set,
      id,
      "comment",
      async (backend) => {
        made = await backend.runsDraftPlanComment(id);
        return made.proposal;
      },
      message,
    );
  },

  async draftPlanDescription(id) {
    await draftFromRun(get, set, id, "description", (backend) => backend.runsDraftPlanDescription(id), () => "Description update ready. Nothing is written to Jira until you approve it.");
  },

  async draftBlocker(id, blockerKey) {
    await draftFromRun(get, set, id, "link", (backend) => backend.runsDraftBlocker(id, blockerKey));
  },

  async draftTicket(id) {
    const { backend, drafting } = get();
    if (!backend || drafting) return;
    set({ drafting: id });
    try {
      const draft = await backend.runsDraftTicket(id);
      await useWorkspace.getState().refreshProposals();
      get().closeSheet();
      useToasts.getState().push(TICKET_READY, "info", { label: "Open", run: () => showDraft(draft.id) });
      showDraft(draft.id);
    } catch (e) {
      useToasts.getState().push(`Couldn't draft the ticket: ${messageOf(e)}`);
    } finally {
      set({ drafting: null });
    }
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
