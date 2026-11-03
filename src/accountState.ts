import type { AuthStatus } from "./backend/auth";
import { forgetConversations } from "./claudeStore";
import { useWorkView } from "./workspace/workViewStore";
import { resetPip } from "./workspace/pipStore";
import { readStored, writeStored } from "./workspace/storage";
import { useTabs } from "./workspace/tabsStore";
import { useToasts } from "./workspace/toasts";
import { useWorkspace } from "./workspaceStore";

const KEY = "gossamr-account";

/** The desktop backend runs whenever a Jira account is signed in, however many there are. */
export const isSignedInToJira = (status: AuthStatus | null) => !!(status?.site && status.me);

/** One key for every Jira sign-in, so adding or removing an account keeps the tabs and saved views. */
export const accountKey = (status: AuthStatus | null) => (isSignedInToJira(status) ? "jira" : "mock");

const lastAccount = (): string | null => {
  const raw = readStored(KEY) as { id?: unknown } | null;
  if (typeof raw?.id !== "string") return null;
  // Keys stored before one key covered every Jira sign-in were `jira:<cloudId>:<accountId>`.
  return raw.id.startsWith("jira:") ? "jira" : raw.id;
};

/**
 * Clears what belongs to one account before another (or none) is shown. Conversations, Pip's filter and the loaded
 * workspace are dropped every time. Tabs and saved views survive adding or removing Jira accounts
 * and are reset when the app moves between sample data and Jira.
 */
export function resetAccountState(accountId: string | null) {
  const changed = accountId !== lastAccount();
  forgetConversations();
  resetPip();
  // The open workstream and decision belong to the account shown before.
  useWorkView.getState().reset();
  useWorkspace.getState().dispose();
  useToasts.getState().clear();
  if (changed) {
    useTabs.getState().reset();
    writeStored(KEY, { id: accountId });
  }
}
