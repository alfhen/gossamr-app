import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchState } from "../types";
import { useWorkspace } from "../workspaceStore";
import { appActions } from "./Palette";
import { useToasts } from "./toasts";
import { unwatchWithUndo } from "./unwatch";

const ref = { connectionId: "c", externalId: "CA" };
const target = { ref, key: "CA", name: "Cats", kind: null } as Parameters<ReturnType<typeof appActions>["watch"]>[0];
const state = (pinned: boolean): WatchState => ({
  connectionId: "c",
  chosen: true,
  needsChoice: false,
  catalogSize: null,
  watches: [{ container: ref, pinned, source: "manual", addedAt: "t", inaccessible: false, key: "CA", name: "Cats", cachedItems: 0 }],
});

describe("unwatching from the palette", () => {
  const watchContainers = vi.fn(() => Promise.resolve());
  beforeEach(() => {
    watchContainers.mockClear();
    useToasts.setState({ toasts: [] });
  });

  it("says it stopped and offers Undo, which watches it again", async () => {
    useWorkspace.setState({ watch: [state(false)], watchContainers });
    appActions().watch(target, false);
    await vi.waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    const toast = useToasts.getState().toasts[0];
    expect(watchContainers).toHaveBeenNthCalledWith(1, "c", [{ containerId: "CA", watched: false }]);
    expect(toast.text).toBe("Stopped watching Cats.");
    expect(toast.action?.label).toBe("Undo");

    toast.action?.run();
    expect(watchContainers).toHaveBeenLastCalledWith("c", [{ containerId: "CA", watched: true, source: "manual" }]);
  });

  it("restores the source it came from on Undo", async () => {
    const s = state(false);
    s.watches[0].source = "footprint";
    useWorkspace.setState({ watch: [s], watchContainers });
    appActions().watch(target, false);
    await vi.waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    useToasts.getState().toasts[0].action?.run();
    expect(watchContainers).toHaveBeenLastCalledWith("c", [{ containerId: "CA", watched: true, source: "footprint" }]);
  });

  it("offers the same Undo from Settings", async () => {
    const s = state(true);
    useWorkspace.setState({ watch: [s], watchContainers });
    await unwatchWithUndo(ref, "Cats");
    expect(useToasts.getState().toasts[0].text).toBe("Stopped watching Cats.");
    useToasts.getState().toasts[0].action?.run();
    expect(watchContainers).toHaveBeenLastCalledWith("c", [{ containerId: "CA", watched: true, source: "manual", pinned: true }]);
  });

  it("pins it again on Undo when it was pinned", async () => {
    useWorkspace.setState({ watch: [state(true)], watchContainers });
    appActions().watch(target, false);
    await vi.waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    useToasts.getState().toasts[0].action?.run();
    expect(watchContainers).toHaveBeenLastCalledWith("c", [{ containerId: "CA", watched: true, source: "manual", pinned: true }]);
  });
});
