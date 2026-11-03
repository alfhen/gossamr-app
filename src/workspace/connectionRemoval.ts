import { isTauri } from "@tauri-apps/api/core";
import { announceSignedOut } from "../accountEvents";
import type { ConnectionInfo } from "../types";
import { useWorkspace } from "../workspaceStore";
import { removesLastJira } from "./connectionsLogic";
import { refreshAfterGithubChange } from "./githubUi";
import { messageOf, useToasts } from "./toasts";

/** Removes the connection, and says when it did. False when the backend refused, with the reason in a toast. */
export async function removeConnection(c: Pick<ConnectionInfo, "instanceId" | "kind" | "displayName">): Promise<boolean> {
  const { backend, connections } = useWorkspace.getState();
  if (!backend) return false;
  const lastJira = removesLastJira(connections, c);
  try {
    await backend.connectionRemove(c.instanceId);
  } catch (e) {
    useToasts.getState().push(`Couldn't remove ${c.displayName}: ${messageOf(e)}`);
    return false;
  }
  if (lastJira && isTauri()) {
    // Removing the last Jira clears the toasts and leaves the workspace that shows them, so Setup is the confirmation.
    announceSignedOut();
    return true;
  }
  try {
    await refreshAfterGithubChange();
  } catch (e) {
    useWorkspace.getState().report("Couldn't refresh after removing it", e);
  }
  useToasts.getState().push(`Removed ${c.displayName}.`, "info");
  return true;
}
