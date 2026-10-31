import type { ConnectionInfo } from "../types";
import { useWorkspace } from "../workspaceStore";
import { messageOf, useToasts } from "./toasts";

/** Turns the connection on or off. False when the backend refused, with the reason in a toast. */
export async function setConnectionEnabled(c: Pick<ConnectionInfo, "instanceId" | "displayName">, on: boolean): Promise<boolean> {
  const { backend, refreshConnections } = useWorkspace.getState();
  if (!backend) return false;
  try {
    await backend.connectionSetEnabled(c.instanceId, on);
  } catch (e) {
    useToasts.getState().push(`Couldn't turn ${on ? "on" : "off"} ${c.displayName}: ${messageOf(e)}`);
    return false;
  }
  try {
    await refreshConnections();
  } catch (e) {
    useWorkspace.getState().report("Couldn't refresh the connections", e);
  }
  return true;
}
