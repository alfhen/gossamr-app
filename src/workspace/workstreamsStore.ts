import { create } from "zustand";
import type { Backend } from "../backend/types";
import { dismissed, flaggedGaps, gapList, gapWords, ignoredGaps, learnedDetail, LEARN_AFTER, projectOfKey } from "../lib/clarityLearning";
import { GENERAL_CONVERSATION, workstreamConversation, workstreamOfConversation } from "../lib/conversations";
import { readinessPrompt } from "../lib/needs";
import { ofItem, runWorkstream, stageText } from "../lib/workstreamStage";
import { budgetView } from "../lib/workstreamHold";
import { adoptCount, adoptedText, adoptUndoneText } from "../lib/workstreamAdopt";
import { HELD_PERSON, type AutoStartSwitches, type ItemRef, type Run, type ScreenContext, type Workstream, type WorkstreamEvent, type WorkstreamMode, type WorkstreamRule, type WorkstreamUndo, type WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { PIP_INPUT_ID } from "./draftKeys";
import { focusAdopted, focusAdoptButton, focusWorkstreamRow } from "./focusDrawn";
import { keepSelectionOpen, setPaneIntent, usePipHome } from "./pipHomeStore";
import { usePip } from "./pipStore";
import { usePrefs } from "./prefs";
import { useRuns, type RunSheetTarget } from "./runsStore";
import { useTabs } from "./tabsStore";
import { messageOf, pushLearning, useToasts } from "./toasts";
import { offerUndo, withdrawUndo } from "./undo";

interface WorkstreamsState {
  backend: Backend | null;
  /** The open workstreams, newest first, each with the stage its runs give it; Pip home sorts them for display (`byStatusRank`). */
  list: WorkstreamView[];
  /** Whether the first read of the open list has landed; false until then, so an empty `list` is not mistaken for "no workstreams". */
  loaded: boolean;
  /** The closed workstreams, as Pip home lists them read-only once asked; empty until `loadClosed` read them. */
  closed: WorkstreamView[];
  init(backend: Backend): void;
  dispose(): void;
  refresh(): Promise<void>;
  /** Reads the closed workstreams into `closed`. */
  loadClosed(): Promise<void>;
  /** Each workstream's audit, oldest first, by id, as last read by `loadEvents`; Pip home's step rail reads the selected one's. */
  events: Record<string, WorkstreamEvent[]>;
  /** Reads workstream `id`'s audit into `events`. */
  loadEvents(id: string): Promise<void>;
  /** The open workstream on the ticket `itemKey` (its key, such as `CA-401`), if there is one. */
  forItem(itemKey: string, connectionId?: string): WorkstreamView | null;
  /** Opens (or finds) the workstream on `item` and shows its conversation: on Pip home there, elsewhere in the Pip pane. Null when it couldn't. */
  start(item: ItemRef): Promise<WorkstreamView | null>;
  /** The workstream whose Close waits for the person to confirm it in the peek, if any. */
  confirmingClose: string | null;
  /** Asks the person to confirm closing workstream `id` (null takes the question back). */
  askClose(id: string | null): void;
  /** Closes workstream `id`; its runs and drafts stay as they are, and its ticket's conversation is General again. False when it couldn't. */
  close(id: string): Promise<boolean>;
  /** Reopens closed workstream `id` as it stood, from a closed row's Reopen. False when it couldn't (its ticket may have another one open by now). */
  reopen(id: string): Promise<boolean>;
  /** The person's "Bring them here": the runs and drafts on the workstream's ticket that sit under General move into it, with an Undo that puts them back. False when nothing moved. */
  adopt(id: string): Promise<boolean>;
  /** The global auto-start switches, as Settings has them, for what "as in Settings" means; null until read. */
  globals: AutoStartSwitches | null;
  /** Reads the global auto-start switches again. */
  loadGlobals(): Promise<void>;
  /** The person's Manage switch: in `manage` the supervisor wakes Pip and starts the routine steps. False when it couldn't. */
  setMode(id: string, mode: WorkstreamMode): Promise<boolean>;
  /** The person's "Run another fix round" on review `reviewRun`, which still blocks after the automatic rounds. The build it went to, null when it couldn't. */
  fixRound(reviewRun: string): Promise<Run | null>;
  /** The person's "I'll take it from here" on review `reviewRun`: workstream `id` goes to Advise. False when it couldn't. */
  takeOver(id: string, reviewRun: string): Promise<boolean>;
  /** Holds workstream `id`: no wakes and no automatic steps; its running agents carry on. False when it couldn't. */
  hold(id: string): Promise<boolean>;
  /** Lifts workstream `id`'s hold, whatever held it. False when it couldn't. */
  resume(id: string): Promise<boolean>;
  /** The person's "Allow 5 more" on workstream `id`, held for its automatic steps: its allowance goes up by 5 and it resumes. False when it couldn't. */
  allowMore(id: string): Promise<boolean>;
  /** The person's "Ask the reporter" on workstream `id`, whose triage found its ticket not ready to plan: a Jira comment to the reporter with its open questions is drafted, for them to approve like any other. False when it couldn't. */
  askReporter(id: string): Promise<boolean>;
  /** The person's "Ask the reporter now" on the clarity notice: drafts the comment to the reporter from the gaps and shows it for approval. False when it couldn't. */
  askReporterNow(id: string): Promise<boolean>;
  /** The person's "Looks fine" on the clarity notice: it doesn't show for this ticket again, and counts toward Gossamr no longer flagging the same gap in the ticket's project (`LEARN_AFTER`). False when it couldn't. */
  looksFine(id: string): Promise<boolean>;
  /** The person's "Draft a nudge" on a workstream that has waited on the reporter for days: drafts the follow-up comment and shows it for approval. False when it couldn't. */
  nudgeReporter(id: string): Promise<boolean>;
  /** The person's "I'll answer": settles the question and opens the workstream's conversation with the open questions quoted in the composer. False when it couldn't. */
  answerSelf(id: string): Promise<boolean>;
  /** The person's "Plan anyway": records the override; the Triage-to-Plan step starts the Plan under its own checks (Manage, not held, within budget). False when it couldn't. */
  planAnyway(id: string): Promise<boolean>;
  /** The workstream's own switch for one automatic step; null follows Settings again. False when it couldn't. */
  setRule(id: string, rule: WorkstreamRule, on: boolean | null): Promise<boolean>;
  /** Holds every open workstream and stops Pip's turns in them, and says how many it held. Null when it couldn't. */
  holdAll(): Promise<number | null>;
  /** Holds workstream `id` and stops each of its agents that can be stopped. False when it couldn't. */
  stop(id: string): Promise<boolean>;
}

let stop: (() => void) | null = null;
/** Bumped on every read and on dispose, so a list read for an earlier backend or account can't land. */
let seq = 0;
/** The same for reads of the closed workstreams. */
let closedSeq = 0;
/** The same for reads of each workstream's audit: the newest read of each id, from one counter, so a read from before a dispose never matches. */
const eventsSeq = new Map<string, number>();
let eventsCounter = 0;

/** The readiness stop workstream `id` waits on, if it does. */
const readinessOf = (list: readonly WorkstreamView[], id: string) => list.find((v) => v.workstream.id === id)?.readiness ?? null;

/** "1 workstream", "2 workstreams". */
const workstreams = (n: number) => `${n} ${n === 1 ? "workstream" : "workstreams"}`;

/** What Looks fine says comes next, in the same toast as what it taught when there is one: the notice asks nothing more, and the agent step is the person's to start. */
export const LOOKS_FINE_NEXT = "The agent step can be started from the conversation.";

/** Workstreams whose readiness question the person just settled with Plan anyway, until the Done line that says so has been written (`takePlannedAnyway`). */
const plannedAnyway = new Set<string>();

/** Whether `id`'s readiness question was just settled with Plan anyway; asking forgets it, so a later question on the workstream reads for itself. */
export const takePlannedAnyway = (id: string | null) => (id !== null && plannedAnyway.delete(id));

export const useWorkstreams = create<WorkstreamsState>()((set, get) => {
  /** Calls the backend for one of the person's controls, then reads the list again; a refusal is told in a toast as `failed`. */
  async function act<T>(failed: string, call: (backend: Backend) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    const backend = get().backend ?? useWorkspace.getState().backend;
    if (!backend) {
      useToasts.getState().push("Not connected yet.");
      return { ok: false };
    }
    try {
      const value = await call(backend);
      if (get().backend === backend) await get().refresh();
      return { ok: true, value };
    } catch (e) {
      useToasts.getState().push(`${failed}. ${messageOf(e)}`);
      return { ok: false };
    }
  }
  /** Shows the comment to the reporter `draftId` in the decision pane, its card focused so Post comment is not one keypress away. */
  async function showReporterDraft(id: string, draftId: string) {
    // A readiness need is gone once asked: the pane would fall to the next need. It shows the new draft instead.
    await useWorkspace.getState().refreshProposals();
    const home = usePipHome.getState();
    const key = `draft:${draftId}`;
    setPaneIntent("card");
    // The advance after the answered need may have opened this very draft already, with its Post button focused: remount it to read the intent.
    const open = home.deciding === key;
    home.decide(key, id);
    if (open) home.redecide();
    // Its words stop being true once the draft is posted or skipped: the note goes then, not after its own few seconds.
    // Nor does it hold once the workstream is closed: Undo of the close brings the workstream back, not this note.
    const waiting = () => useWorkspace.getState().proposals[draftId]?.state.type === "pending" && !get().list.some((v) => v.workstream.id === id && v.workstream.closedAt !== null);
    const toast = useToasts.getState().push("Here is the comment to the reporter. Nothing is posted until you press Post comment.", "info", undefined, { current: waiting });
    if (toast === null) return;
    reporterNotes.set(id, toast);
    const off = useWorkspace.subscribe(() => {
      if (waiting()) return;
      off();
      useToasts.getState().dismiss(toast);
    });
  }
  const ok = async (failed: string, call: (backend: Backend) => Promise<Workstream>) => (await act(failed, call)).ok;
  /** What a choice about a triage's open questions says when the workstream no longer waits for it. */
  const stale = () => {
    useToasts.getState().push("The workstream isn't waiting for that choice any more.", "info");
    return false;
  };

  /** Takes a change back through the backend, which allows it only while that change is the last thing in the audit. A refusal rejects, for the Undo to tell. */
  async function undoChange(id: string, undo: WorkstreamUndo): Promise<void> {
    const backend = get().backend ?? useWorkspace.getState().backend;
    if (!backend) throw new Error("Not connected yet.");
    await backend.workstreamsUndo(id, undo);
    if (get().backend === backend) await get().refresh();
  }
  async function reopenIt(id: string): Promise<void> {
    const backend = get().backend ?? useWorkspace.getState().backend;
    if (!backend) throw new Error("Not connected yet.");
    await backend.workstreamsReopen(id);
    if (get().backend === backend) await get().refresh();
  }
  /** Where the keyboard goes once a closed workstream is back: it opens, and its row has the keyboard. */
  const showWorkstreamRow = (id: string) => {
    usePipHome.getState().openWorkstream(id);
    focusWorkstreamRow(id);
  };
  /** The note saying a comment to the reporter is ready, by workstream, so closing the workstream takes it back. */
  const reporterNotes = new Map<string, number>();
  /** The offer of Undo for each workstream's hold, so Resume, Allow more steps or Close can take it back: it would undo what they just settled. */
  const holdOffers = new Map<string, number>();
  /** Hold all's one offer and the workstreams it would still free: one resumed, allowed more or closed since leaves it, and with none left the offer goes. */
  let batchOffer: { offer: number; ids: Set<string> } | null = null;
  const withdrawHold = (id: string) => {
    withdrawUndo(holdOffers.get(id));
    holdOffers.delete(id);
    if (!batchOffer?.ids.delete(id) || batchOffer.ids.size) return;
    withdrawUndo(batchOffer.offer);
    batchOffer = null;
  };
  /** The offer of Undo for each workstream's adoption: the backend allows it only while it is the last thing in the audit, so once the workstream moved on the offer is dead. */
  const adoptOffers = new Map<string, number>();
  /** The offer of Undo for each close, with its ticket: a new workstream on that ticket makes Reopen refuse, so starting one takes the offer back. */
  const closeOffers = new Map<string, { offer: number; itemKey: string | null }>();
  const withdrawClose = (id: string) => {
    withdrawUndo(closeOffers.get(id)?.offer);
    closeOffers.delete(id);
  };
  /** Takes back the adoption offers of workstreams that have moved on since: questions posted (waiting on the reporter), held, or closed (gone from the open list). */
  const settleAdoptions = (list: readonly WorkstreamView[]) => {
    for (const [id, offer] of [...adoptOffers]) {
      const v = list.find((x) => x.workstream.id === id);
      if (v && !v.waitingOnReporter && !v.workstream.heldReason) continue;
      withdrawUndo(offer);
      adoptOffers.delete(id);
    }
  };
  const undoAll = async (ids: readonly string[]) => {
    const results = await Promise.allSettled(ids.map((id) => undoChange(id, { type: "hold", was: null })));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length) throw new Error(`${failed.length} of ${ids.length} couldn't be freed: ${messageOf((failed[0] as PromiseRejectedResult).reason)}`);
  };

  return {
    backend: null,
    list: [],
    loaded: false,
    closed: [],
    events: {},
    confirmingClose: null,
    globals: null,

    init(backend) {
      get().dispose();
      set({ backend });
      // Every audit something read (the selected workstream's, for its step rail; a timeline's, in the Pip pane or across
      // workstreams) is read again with the list, so a draft decided meanwhile shows in its counts and lines at once.
      const selectedEvents = () => {
        const selected = usePipHome.getState().selected;
        for (const id of new Set([...(selected ? [selected] : []), ...Object.keys(get().events)])) void get().loadEvents(id);
      };
      const offWorkstreams = backend.onWorkstreamsChanged(() => (void get().refresh(), selectedEvents()));
      // A run that moved on may have moved its workstream's stage on.
      const offRuns = backend.onRunsChanged(() => (void get().refresh(), selectedEvents()));
      stop = () => (offWorkstreams(), offRuns());
      void get().refresh();
      // Settings' auto-start switches, for the Next line; it stays hidden until they are read.
      void get().loadGlobals();
    },

    dispose() {
      stop?.();
      stop = null;
      seq++;
      closedSeq++;
      eventsSeq.clear();
      set({ backend: null, list: [], loaded: false, closed: [], events: {}, confirmingClose: null, globals: null });
      usePipHome.getState().reset();
    },

    async refresh() {
      const { backend } = get();
      if (!backend) return;
      const mine = ++seq;
      const list = await backend.workstreamsList().catch(() => null);
      if (!list || mine !== seq || get().backend !== backend) return;
      set({ list, loaded: true });
      settleAdoptions(list);
      keepSelectionOpen(list.filter((v) => v.workstream.closedAt === null).map((v) => v.workstream.id));
      // What Pip home lists as closed follows the open list: one closed meanwhile moves across.
      if (usePipHome.getState().showClosed) void get().loadClosed();
    },

    async loadClosed() {
      const { backend } = get();
      if (!backend) return;
      const mine = ++closedSeq;
      const all = await backend.workstreamsList(true).catch(() => null);
      if (all && mine === closedSeq && get().backend === backend) set({ closed: all.filter((v) => v.workstream.closedAt !== null) });
    },

    async loadEvents(id) {
      const { backend } = get();
      if (!backend) return;
      const mine = ++eventsCounter;
      eventsSeq.set(id, mine);
      const events = await backend.workstreamsEvents(id).catch(() => null);
      // A newer read of the same audit, a dispose or another backend meanwhile: this one is stale.
      if (!events || eventsSeq.get(id) !== mine || get().backend !== backend) return;
      set({ events: { ...get().events, [id]: events } });
    },

    forItem: (itemKey, connectionId) => ofItem(get().list, itemKey, connectionId),

    async start(item) {
      const backend = get().backend ?? useWorkspace.getState().backend;
      if (!backend) {
        useToasts.getState().push("Not connected yet.");
        return null;
      }
      try {
        const ws = await backend.workstreamsOpen(item);
        for (const [id, c] of [...closeOffers]) if (c.itemKey !== null && c.itemKey === ws.itemKey) withdrawClose(id);
        if (get().backend === backend) await get().refresh();
        focusPip(ws.id);
        return get().list.find((v) => v.workstream.id === ws.id) ?? { workstream: ws, stage: "intake", runs: [], labels: [], budget: budgetView(ws) };
      } catch (e) {
        useToasts.getState().push(`Couldn't start a workstream on ${item.key}. ${messageOf(e)}`);
        return null;
      }
    },

    askClose: (confirmingClose) => set({ confirmingClose }),

    async close(id) {
      set({ confirmingClose: null });
      const backend = get().backend ?? useWorkspace.getState().backend;
      if (!backend) {
        useToasts.getState().push("Not connected yet.");
        return false;
      }
      try {
        const ws = await backend.workstreamsClose(id);
        withdrawHold(id);
        withdrawUndo(adoptOffers.get(id));
        adoptOffers.delete(id);
        const note = reporterNotes.get(id);
        if (note !== undefined) useToasts.getState().dismiss(note);
        reporterNotes.delete(id);
        if (get().backend === backend) await get().refresh();
        // Close is one click and a confirmation away from the person's work: Undo reopens it as it stood.
        const name = ws.itemKey ?? ws.title;
        withdrawClose(id);
        closeOffers.set(id, { offer: offerUndo({ what: "close", text: `Closed the workstream on ${name}. Its agents and drafts are kept in General.`, undone: `Reopened the workstream on ${name}.`, undo: () => reopenIt(id), refocus: () => showWorkstreamRow(id) }), itemKey: ws.itemKey ?? null });
        return true;
      } catch (e) {
        useToasts.getState().push(`Couldn't close the workstream. ${messageOf(e)}`);
        return false;
      }
    },

    async reopen(id) {
      const done = await act("Couldn't reopen the workstream", (b) => b.workstreamsReopen(id));
      if (!done.ok) return false;
      withdrawClose(id);
      showWorkstreamRow(id);
      const name = done.value.itemKey ?? done.value.title;
      // It comes back as it stood: a hold the person chose is still theirs to lift.
      useToasts.getState().push(done.value.heldReason === HELD_PERSON ? `Reopened the workstream on ${name}. It is still held by you; Resume it to carry on.` : `Reopened the workstream on ${name}.`, "info");
      return true;
    },

    async adopt(id) {
      const ws = get().list.find((v) => v.workstream.id === id)?.workstream;
      const done = await act("Couldn't bring them here", (b) => b.workstreamsAdopt(id));
      if (!done.ok) return false;
      const moved = done.value;
      const key = ws?.itemKey ?? ws?.title ?? "the ticket";
      const count = adoptCount(moved.runs.length, moved.drafts.length);
      withdrawUndo(adoptOffers.get(id));
      adoptOffers.set(id, offerUndo({ text: adoptedText(count, key), undone: adoptUndoneText(count, key), undo: () => undoChange(id, { type: "adopt", ...moved }), refocus: () => focusAdoptButton(id) }));
      focusAdopted();
      return true;
    },

    async loadGlobals() {
      const backend = get().backend ?? useWorkspace.getState().backend;
      const settings = await backend?.runsSettings().catch(() => null);
      if (settings && (get().backend ?? useWorkspace.getState().backend) === backend) set({ globals: settings.autostart });
    },

    async setMode(id, mode) {
      const before = get().list.find((v) => v.workstream.id === id)?.workstream;
      const done = await act(mode === "manage" ? "Couldn't let Pip manage the workstream" : "Couldn't stop Pip managing the workstream", (b) => b.workstreamsSetMode(id, mode));
      if (!done.ok) return false;
      // Back to Advise is the one switch that can be taken back: nothing it stopped needs restarting. It restores the mode a tripwire kept, too.
      if (before && mode === "advise" && before.mode === "manage" && done.value.mode === "advise") {
        const name = before.itemKey ?? before.title;
        offerUndo({
          text: `Switched ${name} to Advise.`,
          undone: `${name} is back in Manage.`,
          undo: () => undoChange(id, { type: "mode", was: before.mode, resumeMode: before.resumeMode ?? null }),
        });
      }
      return true;
    },

    async fixRound(reviewRun) {
      const done = await act("Couldn't send another fix round", (b) => b.workstreamsFixRound(reviewRun));
      if (!done.ok) return null;
      void useRuns.getState().reload();
      return done.value;
    },

    takeOver: (id, reviewRun) => ok("Couldn't take the workstream over", (b) => b.workstreamsTakeOver(id, reviewRun)),

    async hold(id) {
      const before = get().list.find((v) => v.workstream.id === id)?.workstream;
      const done = await act("Couldn't hold the workstream", (b) => b.workstreamsHold(id));
      if (!done.ok) return false;
      // Only a hold that changed something is offered back; Pip's turn it cancelled is not restarted, only the hold is lifted.
      if (before && before.heldReason !== done.value.heldReason && done.value.heldReason === HELD_PERSON) {
        const name = before.itemKey ?? before.title;
        withdrawHold(id);
        holdOffers.set(id, offerUndo({ what: "hold", text: `Held ${name}.`, undone: `${name} is free again.`, undo: () => undoChange(id, { type: "hold", was: before.heldReason }) }));
      }
      return true;
    },

    async resume(id) {
      const done = await ok("Couldn't resume the workstream", (b) => b.workstreamsResume(id));
      if (done) withdrawHold(id);
      return done;
    },

    async allowMore(id) {
      const done = await ok("Couldn't allow more steps", (b) => b.workstreamsAllowMore(id));
      if (done) withdrawHold(id);
      return done;
    },

    async askReporter(id) {
      const stop = readinessOf(get().list, id);
      if (!stop) return stale();
      const done = await act("Couldn't draft the comment to the reporter", (b) => b.workstreamsReadinessAsk(id, stop.triageRun));
      if (!done.ok) return false;
      await showReporterDraft(id, done.value.id);
      return true;
    },

    async askReporterNow(id) {
      const view = get().list.find((v) => v.workstream.id === id);
      const project = projectOfKey(view?.workstream.itemKey ?? "");
      const learning = usePrefs.getState().clarityLearning;
      if (!view?.clarity || !flaggedGaps(view.clarity.gaps, learning, project).length) return stale();
      // What the person taught the notice to leave out is left out of the questions, too.
      const done = await act("Couldn't draft the comment to the reporter", (b) => b.workstreamsClarityAsk(id, ignoredGaps(learning, project)));
      if (!done.ok) return false;
      await showReporterDraft(id, done.value.id);
      return true;
    },

    async looksFine(id) {
      const view = get().list.find((v) => v.workstream.id === id);
      const key = view?.workstream.itemKey;
      if (!view?.clarity || !key) return stale();
      const project = projectOfKey(key);
      // What the person said looks fine is what the notice showed them: the gaps not already taught away.
      const shown = flaggedGaps(view.clarity.gaps, usePrefs.getState().clarityLearning, project);
      if (!(await ok("Couldn't dismiss the notice", (b) => b.workstreamsClarityDismiss(id)))) return false;
      const backend = get().backend ?? useWorkspace.getState().backend;
      // The dismissal stands either way: it is the person's answer to this notice and is audited as `clarity_dismissed`.
      // What is not worth keeping without its audit line is the teaching: it changes what the page flags from now on, so it
      // is counted only once its `clarity_learned` lines are written. A failed write leaves the count where it was.
      const next = dismissed(usePrefs.getState().clarityLearning, project, shown);
      if (next.learned.length) {
        try {
          if (!backend) throw new Error("No backend");
          for (const gap of next.learned) await backend.workstreamsClarityNote(id, "clarity_learned", learnedDetail(gap, project));
        } catch {
          useToasts.getState().push("Dismissed the notice, but couldn't note what Gossamr learned from it in the audit, so it wasn't counted. Try Looks fine again on another ticket.", "error");
          void get().loadEvents(id);
          return true;
        }
      }
      usePrefs.getState().recordClarityDismissal(project, shown);
      if (next.learned.length) {
        // One word for what it learned, one audit line for each gap.
        // No longer news once it is given back, so it never comes up after (or over) the "as before" note.
        pushLearning(project, `Gossamr will stop flagging ${project} tickets that ${next.learned.map(gapWords).join(", or that ")}. Give that back in Settings, or from ⌘K. ${LOOKS_FINE_NEXT}`, () => ignoredGaps(usePrefs.getState().clarityLearning, project).length > 0);
        void get().loadEvents(id);
      } else if (shown.length) {
        // The first and second Looks fine count silently otherwise: say how far it is from Gossamr stopping.
        const counts = usePrefs.getState().clarityLearning[project] ?? {};
        const lefts = shown.map((g) => LEARN_AFTER - (counts[g] ?? 0));
        const left = Math.min(...lefts);
        // The gaps may stand at different counts: the number is for the first to stop, so say it is not all of them.
        const them = lefts.every((n) => n === left) ? "them" : "the first of them";
        // Out of date once the count moves (another Looks fine) or is given back: the newer note replaces it, never waits behind it.
        const at = JSON.stringify(shown.map((g) => counts[g] ?? 0));
        const standing = () => JSON.stringify(shown.map((g) => usePrefs.getState().clarityLearning[project]?.[g] ?? 0)) === at;
        pushLearning(project, `Noted for ${gapList(shown)}. After ${left} more Looks fine on ${project} tickets like this, Gossamr stops flagging ${them} (Settings > Unclear tickets). ${LOOKS_FINE_NEXT}`, standing);
      } else {
        // Nothing was taught, so nothing else says what comes next: the notice would only go.
        useToasts.getState().push(`${key} marked as clear enough. ${LOOKS_FINE_NEXT}`, "info");
      }
      return true;
    },

    async nudgeReporter(id) {
      const done = await act("Couldn't draft the nudge", (b) => b.workstreamsNudgeReporter(id));
      if (!done.ok) return false;
      await showReporterDraft(id, done.value.id);
      return true;
    },

    async answerSelf(id) {
      const view = get().list.find((v) => v.workstream.id === id);
      const stop = view?.readiness;
      if (!view || !stop) return stale();
      const done = await act("Couldn't settle the open questions", (b) => b.workstreamsReadinessAnswer(id, stop.triageRun));
      if (!done.ok) return false;
      // Pip's conversation in the workstream, with the questions quoted for the person to answer under.
      openOnPipHome(id);
      usePip.getState().openWith(readinessPrompt(stop, view.workstream.itemKey));
      focusComposer();
      return true;
    },

    async planAnyway(id) {
      const stop = readinessOf(get().list, id);
      if (!stop) return stale();
      // Marked before the call: the list that refreshes in it is what makes the question go, and its Done line reads the mark.
      plannedAnyway.add(id);
      const done = await act("Couldn't plan anyway", (b) => b.workstreamsReadinessOverride(id, stop.triageRun));
      if (!done.ok) plannedAnyway.delete(id);
      const said = stop.replied ? "Planning now with the reporter's reply on the ticket. The plan starts as soon as the workstream's checks allow." : stop.changed ? "Planning now with the ticket as it is. The plan starts as soon as the workstream's checks allow." : "Planning anyway. The plan starts as soon as the workstream's checks allow.";
      if (done.ok) useToasts.getState().push(said, "info");
      return done.ok;
    },

    setRule: (id, rule, on) => ok("Couldn't change the automatic step", (b) => b.workstreamsSetRule(id, rule, on)),

    async holdAll() {
      const done = await act("Couldn't hold the workstreams", (b) => b.workstreamsHoldAll());
      if (!done.ok) return null;
      const n = done.value.length;
      const open = get().list.length;
      const said = n ? `Held ${workstreams(n)}. ${n === 1 ? "Its" : "Their"} agents carry on; nothing starts on its own until you resume.` : open ? "Every open workstream is held already." : "There are no open workstreams to hold.";
      // Each one it held was free before, so each goes back to free; Pip's turns it cancelled are not restarted.
      if (n) {
        const ids = new Set(done.value.map((w) => w.id));
        if (batchOffer) withdrawUndo(batchOffer.offer);
        batchOffer = { ids, offer: offerUndo({ what: "hold", text: said, undone: `${workstreams(n)} ${n === 1 ? "is" : "are"} free again.`, undo: () => undoAll([...ids]) }) };
      }
      else useToasts.getState().push(said, "info");
      return n;
    },

    async stop(id) {
      const done = await act("Couldn't stop the workstream", (b) => b.workstreamsStop(id));
      if (!done.ok) return false;
      const { stopped, failed } = done.value;
      const agents = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;
      useToasts.getState().push(
        `Held the workstream${stopped ? ` and stopped ${agents(stopped)}` : ""}.${failed ? ` ${agents(failed)} couldn't be stopped; see the Agents view.` : ""}`,
        failed ? "error" : "info",
      );
      return true;
    },
  };
});

/**
 * Whether the rail offers Hold all: while any open workstream is in Manage and not held, or Pip is answering in a
 * workstream's conversation (`conversations`, by conversation, as claudeStore keeps them).
 */
export function holdAllVisible(list: readonly WorkstreamView[], conversations: Readonly<Record<string, { turns: readonly { status: string }[] } | undefined>>): boolean {
  if (list.some((v) => v.workstream.closedAt === null && v.workstream.mode === "manage" && v.workstream.heldReason === null)) return true;
  return Object.entries(conversations).some(([c, conv]) => workstreamOfConversation(c) !== null && !!conv?.turns.some((t) => t.status === "running"));
}

/**
 * Opens the Pip pane, or keeps it open, and puts the cursor in its composer. On Pip home there is no pane: it selects
 * workstream `id` there (when given) and puts the cursor in Pip home's composer instead.
 */
export function focusPip(id?: string) {
  if (useTabs.getState().route === "pip") {
    if (id) usePipHome.getState().openWorkstream(id);
  } else {
    usePrefs.getState().setPipOpen(true);
  }
  focusComposer();
}

/**
 * Shows workstream `id` (null: General) on Pip home, from any route: the palette's "Open the workstream on KEY", the
 * peek's "Open on Pip home", an Activity row. A peek open over Pip home closes so the workstream is what shows.
 */
export function openOnPipHome(id: string | null) {
  const tabs = useTabs.getState();
  if (tabs.route !== "pip") tabs.setRoute("pip");
  else if (tabs.selected !== null) tabs.select(null);
  const home = usePipHome.getState();
  if (id) home.openWorkstream(id);
  else home.openGeneral();
}

/** Puts the cursor in Pip's composer, the pane's or Pip home's, whichever is on screen. */
export function focusComposer() {
  if (typeof document === "undefined") return;
  // The composer may only mount on this render; its input is there on the next frame.
  const focus = () => document.getElementById(PIP_INPUT_ID)?.focus();
  focus();
  const was = document.activeElement;
  // Focused now: focusing again a frame later could only take a key typed since (F6, say) back to the input.
  if (was && was === document.getElementById(PIP_INPUT_ID)) return;
  requestAnimationFrame(() => {
    // Only if focus hasn't moved since: a key pressed in between (F6 to the rail, say) keeps where it took it.
    const at = document.activeElement;
    if (at === was || !at || at === document.body) focus();
  });
}

/** ⌘J and the rail's Pip button: on Pip home they go to its composer; elsewhere they open or close the Pip pane. */
export function togglePip() {
  if (useTabs.getState().route === "pip") return focusComposer();
  const prefs = usePrefs.getState();
  prefs.setPipOpen(!prefs.pipOpen);
}

/** The ticket the peek shows (selected or peeked), when one is open on a screen that shows it. */
function shownTicket(selected: string | null, route: string, bulk: boolean): ItemRef | null {
  if (!selected || route === "settings" || bulk) return null;
  const ws = useWorkspace.getState();
  return (ws.items[selected] ?? ws.peeked[selected]?.item)?.item ?? null;
}

/** The run in focus: the one whose sheet is open, or on the Agents view the selected one. */
function focusedRunId(route: string, sheet: RunSheetTarget | null, selectedId: string | null): string | null {
  if (route === "settings") return null;
  if (sheet?.type === "run") return sheet.id;
  return route === "agents" ? selectedId : null;
}

export { runWorkstream };

/**
 * The workstream in focus for the Pip pane: the open one on the ticket the peek shows; otherwise the one of the run in
 * focus (its sheet open, or selected on the Agents view), so starting a run from a workstream's conversation keeps it.
 */
function focusedWorkstream(list: readonly WorkstreamView[], ticket: ItemRef | null, run: Run | null | undefined): WorkstreamView | null {
  return (ticket ? ofItem(list, ticket.key, ticket.connectionId) : null) ?? runWorkstream(list, run);
}

/** The run in focus right now, as `focusedRunId` picks it. */
function focusedRun(route: string): Run | null {
  const runs = useRuns.getState();
  const id = focusedRunId(route, runs.sheet, runs.selectedId);
  return id ? (runs.runs.find((r) => r.id === id) ?? null) : null;
}

/** The workstream in focus for the Pip pane, as `focusedWorkstream` picks it. */
export function paneWorkstream(): WorkstreamView | null {
  const tabs = useTabs.getState();
  const ticket = shownTicket(tabs.selected, tabs.route, tabs.marked.length > 1);
  return focusedWorkstream(useWorkstreams.getState().list, ticket, focusedRun(tabs.route));
}

/** The conversation the Pip pane shows: the focused workstream's, otherwise General. */
export function paneConversation(): string {
  const ws = paneWorkstream();
  return ws ? workstreamConversation(ws.workstream.id) : GENERAL_CONVERSATION;
}

/** The conversation Pip home shows: its selected workstream's, or General. */
const homeConversation = (selected: string | null) => (selected ? workstreamConversation(selected) : GENERAL_CONVERSATION);

/** The conversation in focus: on Pip home the one it shows, elsewhere the one the Pip pane shows (`paneConversation`). */
export function focusedConversation(): string {
  return useTabs.getState().route === "pip" ? homeConversation(usePipHome.getState().selected) : paneConversation();
}

/** `focusedConversation`, kept current. */
export function useFocusedConversation(): string {
  const home = useTabs((s) => s.route === "pip");
  const selected = usePipHome((s) => s.selected);
  const pane = usePaneWorkstream();
  if (home) return homeConversation(selected);
  return pane ? workstreamConversation(pane.workstream.id) : GENERAL_CONVERSATION;
}

/** The open workstream Pip home shows, kept current; null for General. */
export function useHomeWorkstream(): WorkstreamView | null {
  const selected = usePipHome((s) => s.selected);
  return useWorkstreams((s) => (selected ? (s.list.find((v) => v.workstream.id === selected && v.workstream.closedAt === null) ?? null) : null));
}

/** `paneWorkstream`, kept current as the selection, the tickets and the workstreams change. */
export function usePaneWorkstream(): WorkstreamView | null {
  const selected = useTabs((s) => s.selected);
  const route = useTabs((s) => s.route);
  const bulk = useTabs((s) => s.marked.length > 1);
  const ticket = useWorkspace((s) => (selected && route !== "settings" && !bulk ? (s.items[selected] ?? s.peeked[selected]?.item)?.item : undefined));
  const run = useRuns((s) => {
    const id = focusedRunId(route, s.sheet, s.selectedId);
    return id ? s.runs.find((r) => r.id === id) : undefined;
  });
  return useWorkstreams((s) => focusedWorkstream(s.list, ticket ?? null, run));
}

/** The open workstream on `item`, kept current. */
export function useItemWorkstream(item: ItemRef | null | undefined): WorkstreamView | null {
  return useWorkstreams((s) => (item ? ofItem(s.list, item.key, item.connectionId) : null));
}

/** "Workstream: CA-401 Retry … · Intake", or "General", for the head of the Pip pane. */
export const conversationTitle = (ws: WorkstreamView | null) => (ws ? `Workstream: ${ws.workstream.title} · ${stageText(ws.stage, ws.waitingForPr, ws.reviewBlocking)}` : "General");

/** The ticket of the workstream whose conversation `conversation` is, as the workspace knows it; null for General or a ticket it hasn't loaded. */
export function workstreamTicket(conversation: string): ItemRef | null {
  const id = workstreamOfConversation(conversation);
  const ws = id ? useWorkstreams.getState().list.find((v) => v.workstream.id === id)?.workstream : undefined;
  if (!ws?.itemKey) return null;
  const { items, peeked } = useWorkspace.getState();
  const known = [...Object.values(items), ...Object.values(peeked).map((p) => p.item)].find((w) => w?.item.key === ws.itemKey && w.item.connectionId === ws.connectionId);
  return known?.item ?? null;
}

/** What Pip is told it sees for a question in `conversation`: in a workstream's conversation with no ticket on screen, the workstream's ticket. */
export function contextFor(conversation: string, context: ScreenContext): ScreenContext {
  if (context.item) return context;
  const item = workstreamTicket(conversation);
  return item ? { ...context, item } : context;
}
