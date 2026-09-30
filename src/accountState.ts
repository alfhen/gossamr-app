import { stopWatchingProposals, useClaude } from "./claudeStore";
import { stopClassicSync, useStore } from "./store";
import { resetPip } from "./workspace/pipStore";
import { readStored, writeStored } from "./workspace/storage";
import { useTabs } from "./workspace/tabsStore";
import { useToasts } from "./workspace/toasts";
import { useWorkspace } from "./workspaceStore";

const KEY = "gossamr-account";

const lastAccount = (): string | null => {
  const raw = readStored(KEY) as { id?: unknown } | null;
  return typeof raw?.id === "string" ? raw.id : null;
};

/**
 * Clears what belongs to one account before another (or none) is shown. Conversations, Pip's filter and the loaded
 * workspace are dropped every time. Tabs, saved views and closed suggestions refer to one account's projects, so they
 * survive a restart or a UI switch but not a different account.
 */
export function resetAccountState(accountId: string | null) {
  const changed = accountId !== lastAccount();
  stopClassicSync();
  stopWatchingProposals();
  useClaude.setState({ open: false, byTicket: {}, proposals: [] });
  resetPip(changed);
  useWorkspace.getState().dispose();
  useToasts.getState().clear();
  useStore.setState({ snap: null, backend: null, selectedId: null, overlay: null });
  if (changed) {
    useTabs.getState().reset();
    writeStored(KEY, { id: accountId });
  }
}
