import { create } from "zustand";

interface JiraUi {
  connectOpen: boolean;
  /** The Jira row the sheet was opened from, if any. Sent with the sign-in so a row that isn't Jira is refused. */
  connectInstanceId: string | undefined;
  openConnect(instanceId?: string): void;
  closeConnect(): void;
}

export const useJiraUi = create<JiraUi>((set) => ({
  connectOpen: false,
  connectInstanceId: undefined,
  openConnect: (instanceId) => set({ connectOpen: true, connectInstanceId: instanceId }),
  closeConnect: () => set({ connectOpen: false, connectInstanceId: undefined }),
}));
