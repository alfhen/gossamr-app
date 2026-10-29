import type { ContainerRef } from "../types";
import { useWorkspace } from "../workspaceStore";
import { UNDO_LIFETIME_MS, useToasts } from "./toasts";

/** Stops watching a container and offers Undo, which watches it again with the pin and source it had. */
export function unwatchWithUndo(ref: ContainerRef, name: string): Promise<unknown> {
  const ws = useWorkspace.getState();
  const row = ws.watch.find((w) => w.connectionId === ref.connectionId)?.watches.find((r) => r.container.externalId === ref.externalId);
  const pinned = row?.pinned ?? false;
  const source = row?.source ?? "manual";
  const undo = () =>
    useWorkspace.getState().watchContainers(ref.connectionId, [{ containerId: ref.externalId, watched: true, source, ...(pinned ? { pinned: true } : {}) }]).catch((e) => ws.report(`Couldn't watch ${name}`, e));
  return ws.watchContainers(ref.connectionId, [{ containerId: ref.externalId, watched: false }]).then(
    () => useToasts.getState().push(`Stopped watching ${name}.`, "info", { label: "Undo", run: () => void undo() }, { keep: true, lifetime: UNDO_LIFETIME_MS }),
    (e) => ws.report(`Couldn't unwatch ${name}`, e),
  );
}
