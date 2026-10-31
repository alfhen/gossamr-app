import { create } from "zustand";

interface JiraUi {
  connectOpen: boolean;
  openConnect(): void;
  closeConnect(): void;
}

export const useJiraUi = create<JiraUi>((set) => ({
  connectOpen: false,
  openConnect: () => set({ connectOpen: true }),
  closeConnect: () => set({ connectOpen: false }),
}));
