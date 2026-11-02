import { create } from "zustand";
import type { ItemRef } from "../types";

interface KeyChooserState {
  asking: { key: string; options: ItemRef[]; resolve(picked: ItemRef | null): void } | null;
  /** Asks which of the sites that have `key` the person means; null when they cancel. */
  choose(key: string, options: ItemRef[]): Promise<ItemRef | null>;
  answer(picked: ItemRef | null): void;
}

export const keyChooserOpen = () => useKeyChooser.getState().asking !== null;

export const useKeyChooser = create<KeyChooserState>((set, get) => ({
  asking: null,
  choose: (key, options) =>
    new Promise((resolve) => {
      get().asking?.resolve(null);
      set({ asking: { key, options, resolve } });
    }),
  answer: (picked) => {
    const asking = get().asking;
    set({ asking: null });
    asking?.resolve(picked);
  },
}));
