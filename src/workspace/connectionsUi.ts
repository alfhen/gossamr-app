import { create } from "zustand";

interface ConnectionsUi {
  /** The instance whose detail Settings shows; the first one when unset or gone. */
  selected: string | null;
  select(connectionId: string | null): void;
}

export const useConnectionsUi = create<ConnectionsUi>((set) => ({
  selected: null,
  select: (selected) => set({ selected }),
}));
