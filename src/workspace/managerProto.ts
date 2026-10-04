import { create } from "zustand";
import { readStored, writeStored } from "./storage";

export interface ManagerSettings {
  /** Pip reads each finished run and drafts what is useful. */
  reviewFinished: boolean;
  /** Pip may send a read-only run back for another pass without asking, up to `maxPasses`. */
  autoSendBack: boolean;
  maxPasses: number;
  /** Pip may propose an investigation from a request in chat. */
  proposeFromChat: boolean;
}

export const DEFAULT_SETTINGS: ManagerSettings = { reviewFinished: false, autoSendBack: false, maxPasses: 2, proposeFromChat: true };
export const MAX_PASSES = 3;

const KEY = "gossamr-manager";

interface Stored {
  on: boolean;
  settings: ManagerSettings;
}

const clampPasses = (n: unknown) => Math.min(MAX_PASSES, Math.max(1, Math.round(Number(n)) || DEFAULT_SETTINGS.maxPasses));

function load(): Stored {
  const raw = readStored(KEY) as { on?: unknown; settings?: Partial<ManagerSettings> } | null;
  const s = raw?.settings ?? {};
  return {
    on: raw?.on === true,
    settings: {
      reviewFinished: s.reviewFinished === true,
      autoSendBack: s.autoSendBack === true,
      maxPasses: clampPasses(s.maxPasses),
      proposeFromChat: s.proposeFromChat !== false,
    },
  };
}

/** `?manager=1` turns the prototype on and `?manager=0` off, and either is remembered; otherwise what Settings last chose. */
export function managerOn(): boolean {
  const asked = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("manager");
  if (asked === "1" || asked === "0") {
    const on = asked === "1";
    writeStored(KEY, { ...load(), on });
    return on;
  }
  return load().on;
}

interface ManagerState extends ManagerSettings {
  on: boolean;
  /** Where the scenario stands, 0 to the last step. */
  step: number;
  /** A step is playing out. */
  busy: boolean;
  /** Ids of finished runs the person opened, so the inbox stops listing them. */
  read: ReadonlySet<string>;
  change(patch: Partial<ManagerSettings>): void;
  setOn(on: boolean): void;
  setStep(step: number, busy?: boolean): void;
  markRead(runId: string): void;
  resetSettings(): void;
}

const initial = load();

export const useManager = create<ManagerState>((set) => ({
  ...initial.settings,
  on: managerOn(),
  step: 0,
  busy: false,
  read: new Set<string>(),
  change: (patch) => set({ ...patch, ...(patch.maxPasses !== undefined ? { maxPasses: clampPasses(patch.maxPasses) } : {}) }),
  setOn: (on) => set({ on }),
  setStep: (step, busy = false) => set({ step, busy }),
  markRead: (runId) => set((s) => (s.read.has(runId) ? s : { read: new Set([...s.read, runId]) })),
  resetSettings: () => set({ ...DEFAULT_SETTINGS, step: 0, busy: false, read: new Set<string>() }),
}));

export const managerSettings = (): ManagerSettings => {
  const { reviewFinished, autoSendBack, maxPasses, proposeFromChat } = useManager.getState();
  return { reviewFinished, autoSendBack, maxPasses, proposeFromChat };
};

useManager.subscribe((s) => writeStored(KEY, { on: s.on, settings: { reviewFinished: s.reviewFinished, autoSendBack: s.autoSendBack, maxPasses: s.maxPasses, proposeFromChat: s.proposeFromChat } }));

/** Whether the prototype is on: false for everything outside it, so the app behaves as it always has. */
export const useManagerOn = () => useManager((s) => s.on);
