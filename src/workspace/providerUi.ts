import { create } from "zustand";
import type { Driver } from "../lib/models";

interface ProviderUi {
  /** The driver whose Add sheet is open. */
  adding: Driver | null;
  openAdd(driver: Driver): void;
  closeAdd(): void;
}

export const useProviderUi = create<ProviderUi>((set) => ({
  adding: null,
  openAdd: (adding) => set({ adding }),
  closeAdd: () => set({ adding: null }),
}));
