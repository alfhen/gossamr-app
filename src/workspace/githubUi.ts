import { create } from "zustand";
import { safeGithubUrl } from "../lib/githubUrl";
import { useWorkspace } from "../workspaceStore";
import { useDev } from "./devStore";
import { useReviewAccess } from "./reviewAccess";
import { useToasts, messageOf } from "./toasts";

interface GithubUi {
  connectOpen: boolean;
  openConnect(): void;
  closeConnect(): void;
}

export const useGithubUi = create<GithubUi>((set) => ({
  connectOpen: false,
  openConnect: () => set({ connectOpen: true }),
  closeConnect: () => set({ connectOpen: false }),
}));

/** Opens a GitHub page in the system browser. Anything that isn't an https GitHub address is refused. */
export function openOnGithub(url: string): boolean {
  const safe = safeGithubUrl(url);
  if (!safe) {
    useToasts.getState().push("That isn't a GitHub address, so it wasn't opened.");
    return false;
  }
  const backend = useWorkspace.getState().backend;
  if (!backend) return false;
  backend.openUrl(safe).catch((e) => useToasts.getState().push(`Couldn't open GitHub: ${messageOf(e)}`));
  return true;
}

/** Re-reads everything a GitHub connection being added, removed or re-chosen changes. */
export async function refreshAfterGithubChange() {
  // Another token may write where the last couldn't, or not where it could.
  useReviewAccess.getState().forgetAll();
  const ws = useWorkspace.getState();
  await Promise.all([ws.refreshConnections(), ws.refreshWatch(), ws.refresh()]);
  useDev.getState().invalidate();
}

export async function disconnectGithub(connectionId: string, label: string): Promise<boolean> {
  const backend = useWorkspace.getState().backend;
  if (!backend) return false;
  try {
    await backend.githubDisconnect(connectionId);
  } catch (e) {
    useToasts.getState().push(`Couldn't disconnect ${label}: ${messageOf(e)}`);
    return false;
  }
  await refreshAfterGithubChange();
  useToasts.getState().push(`Disconnected ${label}. Its token and cached pull requests are gone.`, "info");
  return true;
}
