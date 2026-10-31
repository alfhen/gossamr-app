import { announceSignedOut } from "../accountEvents";
import type { ConnectionInfo } from "../types";
import { useWorkspace } from "../workspaceStore";
import { refreshAfterGithubChange } from "./githubUi";
import { messageOf, useToasts } from "./toasts";

/** Removes the connection, and says when it did. False when the backend refused, with the reason in a toast. */
export async function removeConnection(c: Pick<ConnectionInfo, "instanceId" | "kind" | "displayName">): Promise<boolean> {
  const backend = useWorkspace.getState().backend;
  if (!backend) return false;
  try {
    await backend.connectionRemove(c.instanceId);
  } catch (e) {
    useToasts.getState().push(`Couldn't remove ${c.displayName}: ${messageOf(e)}`);
    return false;
  }
  if (c.kind === "jira") {
    announceSignedOut();
  } else {
    try {
      await refreshAfterGithubChange();
    } catch (e) {
      useWorkspace.getState().report("Couldn't refresh after removing it", e);
    }
  }
  useToasts.getState().push(`Removed ${c.displayName}.`, "info");
  return true;
}
