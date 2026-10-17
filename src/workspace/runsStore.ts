import { create } from "zustand";
import type { Backend } from "../backend/types";
import { targetOf } from "../lib/proposals";
import { labelsByRun } from "../lib/workstreamStage";
import type { CleanupResult, ItemRef, PlanComment, Proposal, Run, RunKind, RunsEnvironment } from "../types";
import { useWorkspace } from "../workspaceStore";
import { INSTALL_URL, failureHelp, type FailureAct } from "./failureHelp";
import { copyText } from "./AgentSheet";
import { KIND_LABEL, NO_FILTERS, agentGroups, stepRun, stopAllText, type AgentFilters } from "./agentsLogic";
import { showDraft } from "./draftTicket";
import { openTicketByKey, showMe } from "./jump";
import { planCommentMessage } from "./runSheetLogic";
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
  runs: Run[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  environment: RunsEnvironment | null;
  filters: AgentFilters;
  selectedId: string | null;
  /**
   * Ids of runs whose failure, stop or unclear state the person dismissed, so they leave Needs you. Looking at a run never
   * adds one: a failure leaves only when it is dealt with (a retry or a fix) or dismissed.
   */
  dismissed: ReadonlySet<string>;
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
  /**
   * What the person asked for when the one-time safety sheet opened instead; "Got it, continue" carries it on. Set only
   * while the safety sheet is that intro, which is how the sheet knows to offer it.
   */
  afterIntro: (() => void) | null;
  /** What `afterIntro` would start, in words ("Investigate CA-401"), for the note when the intro is closed instead. */
  afterIntroWhat: string | null;
  /** The order the run sheet browses in, taken when it opened; see `browseList`. */
  browseOrder: readonly string[] | null;
  /** Runs whose answer went through, with the progress time they had then: "Answer sent" shows until it moves on. */
  answered: Readonly<Record<string, string>>;
  /**
   * The person's last answer to each run's permission prompt, with the exact command: a denial shows its confirmation
   * until the run reports something new (`at`, its progress time then), an Allow once while the run still waits on that
   * command in Terminal. `copied` says whether the command reached the clipboard.
   */
  permissionAnswered: Readonly<Record<string, PermissionAnswered>>;
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
  /**
   * False when it opened the safety sheet because the person has not seen it; callers stop there, and `then`, what
   * they were doing, runs when the person presses "Got it, continue". Closing the sheet any other way drops it.
   */
  ensureAgentsIntro(then?: () => void, what?: string): boolean;
  /** Closes the one-time safety sheet and carries on with what the person asked for before it opened. */
  continueIntro(): void;
  /** Moves the run sheet to the next (`1`) or previous (`-1`) run, in the order the Agents view lists them, grouped as it is. */
  browse(delta: 1 | -1): void;
  stop(id: string): Promise<void>;
  startNow(id: string): Promise<void>;
  /** Sends the person's answer to a run that is asking a question; the run carries on under the same id. */
  answer(id: string, text: string): Promise<void>;
  /** The person's Deny for the permission prompt they read as `command`: Claude is told no and carries on without it. */
  denyPermission(id: string, command: string): Promise<void>;
  /** The person's Allow once for the permission prompt they read as `command`: opens the run in Terminal, where they answer Yes, and copies the command. */
  allowPermissionOnce(id: string, command: string): Promise<void>;
  /** Takes a listed session over as the continuation of a stopped or finished run, after the person chose it. */
  adoptSession(id: string, session: string): Promise<void>;
  retryLaunch(id: string): Promise<void>;
  /** The step a failed launch needs the person for: Terminal to trust the folder or sign in, or the install page. */
  fix(id: string, act: Extract<FailureAct, "terminal" | "install">): Promise<void>;
  /** Notes that the person copied the command to run it themselves, which is as good as opening Terminal. */
  noteCopied(id: string): void;
  /**
   * Takes run `id` out of Needs you: the person's explicit Dismiss of its failure, limit stop, unclear state or possible
   * continuation. It is local (nothing reaches the run), so it offers Undo; `undismiss` is what Undo calls.
   */
  dismiss(id: string): void;
  /** Puts run `id` back in Needs you if it is dismissed, leaving every other dismissal as it is. */
  undismiss(id: string, before?: ReadonlySet<string>): void;
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

/** What the person answered to a run's permission prompt (`permissionAnswered`). */
export interface PermissionAnswered {
  kind: "denied" | "allowed";
  command: string;
  at: string;
  copied: boolean;
}

/** The confirmation for a run's answered permission prompt while it still applies: a denial until the run moves on, an Allow once while it waits on that command. */
export function permissionConfirmation(run: Pick<Run, "lastProgressAt" | "permissionAllowed" | "state">, answered: PermissionAnswered | undefined): PermissionAnswered | null {
  if (!answered) return null;
  if (answered.kind === "denied") return answered.at === run.lastProgressAt ? answered : null;
  return run.state === "needsPermission" && run.permissionAllowed?.command === answered.command ? answered : null;
}

const idle = { runs: [] as Run[], launching: new Set<string>() as ReadonlySet<string>, status: "idle" as const, error: null, environment: null, selectedId: null, sheet: null as RunSheetTarget | null, afterIntro: null, afterIntroWhat: null, browseOrder: null, picking: false };

/** The order the Agents view lists runs in right now, grouped as it is. */
const liveOrder = (s: Pick<RunsState, "runs" | "filters" | "earlierOpen">) => agentGroups(usePrefs.getState().agentsGroup, s.runs, useWorkstreams.getState().list, s.filters, s.earlierOpen, Date.now()).order;

/** A run that was dismissed and has moved on (it retried, was resumed, carried on) starts over: if it fails or stops again, Needs you has it again. */
const DISMISSABLE: readonly Run["state"][] = ["failed", "stopped", "unknown"];

function forgetRecovered(dismissed: ReadonlySet<string>, runs: readonly Run[]): ReadonlySet<string> {
  const recovered = runs.filter((r) => !DISMISSABLE.includes(r.state) && dismissed.has(r.id));
  if (!recovered.length) return dismissed;
  const kept = new Set([...dismissed].filter((id) => !recovered.some((r) => r.id === id)));
  writeStored(DISMISSED_KEY, [...kept]);
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
    // A run that waits for a slot is queued, not started: the "Nothing was started" note stays until it launches.
    if (run.state === "launching" || run.state === "working") dismissCancelledNote(run);
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

/** Sends the person's Deny or Allow once and keeps the run as it came back, so the confirmation shows at once; a refusal is a toast. */
async function answerPermission(get: () => RunsState, set: (patch: Partial<RunsState>) => void, id: string, kind: PermissionAnswered["kind"], command: string) {
  const { backend, answering } = get();
  if (!backend || answering.has(id)) return;
  set({ answering: new Set([...answering, id]) });
  try {
    const run = kind === "denied" ? await backend.runsDenyPermission(id, command) : await backend.runsAllowPermissionOnce(id, command);
    // Only once Terminal is open: the command goes on the clipboard for the person to compare with Claude Code's prompt.
    const copied = kind === "allowed" && (await copyText(command));
    const at = kind === "allowed" ? (run.permissionAllowed?.at ?? run.lastProgressAt) : run.lastProgressAt;
    set({ runs: get().runs.map((r) => (r.id === id ? run : r)), permissionAnswered: { ...get().permissionAnswered, [id]: { kind, command, at, copied } } });
    // The Needs-you pane moves on before the card's own line can show; Deny reached the agent, so no Undo.
    if (kind === "denied") useToasts.getState().push(`Denied. ${labelsByRun(get().runs).get(id) ?? run.item?.key ?? "The run"} carries on without it.`, "info");
  } catch (e) {
    useToasts.getState().push(`Couldn't ${kind === "denied" ? "deny it" : "open it to allow"}: ${messageOf(e)}`);
  } finally {
    set({ answering: new Set([...get().answering].filter((x) => x !== id)) });
    void get().reload();
  }
}

const TICKET_READY = "Draft ticket ready. Nothing is created until you approve it.";

let stop: (() => void) | null = null;
let seq = 0;

/** The note when the one-time safety sheet is closed with × rather than Got it, continue: what was dropped, and that nothing ran. */
export const introCancelled = (what: string) => `Cancelled: ${what}. Nothing was started.`;

/** The note `closeSheet` pushed, while it may still be on screen or waiting: it goes the moment a run starts after all. */
let cancelledNote: { id: number; what: string } | null = null;

const GENERIC_START = "Start an agent";

/**
 * Takes the "Cancelled: … Nothing was started." note away: what it cancelled went ahead after all, so it would now say the
 * opposite of what happened. Given the run that started, only that run's own kind and ticket take it away; a note that
 * names no kind or ticket has nothing to match and goes with any run.
 */
export function dismissCancelledNote(run?: Pick<Run, "spec" | "item">) {
  if (!cancelledNote) return;
  if (run && cancelledNote.what !== GENERIC_START && startWhat(null, run.spec.kind, run.item) !== cancelledNote.what) return;
  useToasts.getState().dismiss(cancelledNote.id);
  cancelledNote = null;
}

/**
 * Takes the note away when the setup sheet opens again for what it cancelled (Review and start on the same draft): over
 * the sheet it would read as if the launch was dropped. A note about something else stays.
 */
export function dismissCancelledNoteFor(what: string) {
  if (!cancelledNote || cancelledNote.what !== what) return;
  useToasts.getState().dismiss(cancelledNote.id);
  cancelledNote = null;
}

/** A run start in words for that note: the draft's own kind and ticket when there is one ("Investigate CA-401"), else the kind and ticket asked for. */
export function startWhat(p: Proposal | null | undefined, kind?: RunKind, item?: ItemRef | null): string {
  const draft = p?.intent.type === "startRun" ? p.intent : null;
  const k = draft?.spec.kind ?? kind;
  const key = (draft ? draft.item : item)?.key;
  return k ? `${KIND_LABEL[k]}${key ? ` ${key}` : ""}` : "Start an agent";
}

export const useRuns = create<RunsState>((set, get) => ({
  backend: null,
  filters: NO_FILTERS,
  dismissed: loadDismissed(),
  terminalOpened: new Set<string>(),
  introOpen: null,
  earlierOpen: false,
  stopping: false,
  drafting: null,
  answering: new Set<string>(),
  answered: {},
  permissionAnswered: {},
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
        set({ runs, status: "ready", error: null, dismissed: forgetRecovered(get().dismissed, runs) });
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
    const filters = opts?.stay ? get().filters : NO_FILTERS;
    set({ selectedId: id, filters, sheet: { type: "run", id }, afterIntro: null, browseOrder: liveOrder({ ...get(), filters }) });
    const tabs = useTabs.getState();
    if (!opts?.stay || tabs.route === "settings" || tabs.route === "activity") tabs.setRoute("agents");
  },

  openSafety: () => set({ sheet: { type: "safety" }, afterIntro: null, afterIntroWhat: null, browseOrder: null }),
  closeSheet: () => {
    // The one-time intro closed without Got it, continue: what it stood in for is dropped, and the person is told so.
    const dropped = get().afterIntro ? (get().afterIntroWhat ?? GENERIC_START) : null;
    set({ sheet: null, afterIntro: null, afterIntroWhat: null, browseOrder: null });
    const id = dropped ? useToasts.getState().push(introCancelled(dropped), "info") : undefined;
    if (dropped && id !== undefined && id !== null) cancelledNote = { id, what: dropped };
  },

  showDraft(item) {
    get().closeSheet();
    if (item) openDraftsOn(item);
  },
  ensureAgentsIntro(then, what) {
    const prefs = usePrefs.getState();
    if (prefs.agentsIntroSeen) return true;
    prefs.setAgentsIntroSeen(true);
    set({ sheet: { type: "safety" }, picking: false, afterIntro: then ?? (() => {}), afterIntroWhat: what ?? null, browseOrder: null });
    return false;
  },

  continueIntro() {
    const then = get().afterIntro;
    set({ sheet: null, afterIntro: null, afterIntroWhat: null });
    // What the person asked for goes ahead after all, so an earlier "Nothing was started" is no longer true.
    if (then) dismissCancelledNote();
    then?.();
  },

  setPicking(picking) {
    if (picking && !get().ensureAgentsIntro(() => get().setPicking(true), "Start an agent")) return;
    set({ picking });
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
    if (!backend || answering.has(id)) return;
    const before = get().runs.find((r) => r.id === id);
    const resuming = before?.state === "stopped" && !!before.stoppedByLimit;
    set({ answering: new Set([...answering, id]) });
    try {
      const run = await backend.runsAnswer(id, text);
      set({ answered: { ...get().answered, [id]: run.lastProgressAt } });
      useToasts.getState().push(resuming ? "Resumed. Claude is picking it back up." : "Answer sent. Claude is picking it back up. Only the agent sees your answer; nothing goes to Jira.", "info");
    } catch (e) {
      useToasts.getState().push(`Couldn't send the answer: ${messageOf(e)}`);
    } finally {
      set({ answering: new Set([...get().answering].filter((x) => x !== id)) });
      void get().reload();
    }
  },

  async denyPermission(id, command) {
    await answerPermission(get, set, id, "denied", command);
  },

  async allowPermissionOnce(id, command) {
    await answerPermission(get, set, id, "allowed", command);
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
  setIntroOpen: (introOpen) => set({ introOpen }),
}));
