import { create } from "zustand";
import type { Backend } from "../backend/types";
import type { Run, RunsEnvironment } from "../types";
import { NO_FILTERS, attentionCount, type AgentFilters } from "./agentsLogic";
import { readStored, writeStored } from "./storage";
import { messageOf, useToasts } from "./toasts";
import { useTabs } from "./tabsStore";

const SEEN_KEY = "gossamr-runs-seen";
const SEEN_KEPT = 500;

const loadSeen = (): ReadonlySet<string> => {
  const raw = readStored(SEEN_KEY);
  return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
};

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
  /** Null until the person opens or closes the explainer, when it shows for a first visit with no runs. */
  introOpen: boolean | null;
  earlierOpen: boolean;
  stopping: boolean;
  init(backend: Backend): void;
  dispose(): void;
  reload(): Promise<void>;
  checkEnvironment(): Promise<void>;
  setFilter(patch: Partial<AgentFilters>): void;
  clearFilters(): void;
  select(id: string | null): void;
  /** Shows the Agents view with the run selected. The run sheet that opens from here arrives later. */
  openRun(id: string): void;
  markSeen(): void;
  attach(id: string): Promise<void>;
  stopAll(): Promise<void>;
  setEarlierOpen(open: boolean): void;
  setIntroOpen(open: boolean | null): void;
}

const idle = { runs: [] as Run[], status: "idle" as const, error: null, environment: null, selectedId: null };

let stop: (() => void) | null = null;
let seq = 0;

export const useRuns = create<RunsState>((set, get) => ({
  backend: null,
  filters: NO_FILTERS,
  seenFailed: loadSeen(),
  introOpen: null,
  earlierOpen: false,
  stopping: false,
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
      if (mine === seq) set({ runs, status: "ready", error: null });
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

  openRun(id) {
    set({ selectedId: id, filters: NO_FILTERS });
    useTabs.getState().setRoute("agents");
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

  setEarlierOpen: (earlierOpen) => set({ earlierOpen }),
  setIntroOpen: (introOpen) => set({ introOpen }),
}));

/** The count on the rail's Agents button. */
export const useAttention = () => useRuns((s) => attentionCount(s.runs, s.seenFailed));
