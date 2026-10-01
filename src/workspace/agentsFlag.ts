import { isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { Backend } from "../backend/types";
import { messageOf } from "./toasts";

interface FlagState {
  /** What the backend says. Until it has answered, the desktop app is off and the browser build (whose mock owns the flag) is on. */
  enabled: boolean;
  /** The value being asked for while the backend works on it. */
  pending: boolean | null;
  error: string | null;
  /** What turning Agents off did not do, as the backend put it. */
  note: string | null;
  backend: Backend | null;
  init(backend: Backend): void;
  set(on: boolean): Promise<void>;
}

let seq = 0;

export const useAgentsFlag = create<FlagState>((set, get) => ({
  enabled: !isTauri(),
  pending: null,
  error: null,
  note: null,
  backend: null,

  init(backend) {
    const mine = ++seq;
    set({ backend, pending: null, error: null, note: null });
    backend.runsEnabled().then(
      (enabled) => mine === seq && set({ enabled }),
      () => {},
    );
  },

  async set(on) {
    const { backend, pending } = get();
    if (!backend || pending !== null) return;
    const mine = ++seq;
    set({ pending: on, error: null, note: null });
    try {
      const change = await backend.runsSetEnabled(on);
      if (mine === seq) set({ enabled: change.enabled, note: change.note, pending: null });
    } catch (e) {
      if (mine === seq) set({ error: messageOf(e), pending: null });
    }
  },
}));

export const useAgentsEnabled = () => useAgentsFlag((s) => s.enabled);
