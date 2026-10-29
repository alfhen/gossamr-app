import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchState } from "../types";
import { useWorkspace } from "../workspaceStore";
import { appActions } from "./Palette";
import { useToasts } from "./toasts";

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
    expect(toast.text).toBe("Stopped watching Cats.");
    expect(toast.action?.label).toBe("Undo");

    toast.action?.run();
    expect(watchContainers).toHaveBeenLastCalledWith("c", [{ containerId: "CA", watched: true, source: "manual" }]);
  });

  it("pins it again on Undo when it was pinned", async () => {
    useWorkspace.setState({ watch: [state(true)], watchContainers });
    appActions().watch(target, false);
    await vi.waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    useToasts.getState().toasts[0].action?.run();
    expect(watchContainers).toHaveBeenLastCalledWith("c", [{ containerId: "CA", watched: true, source: "manual", pinned: true }]);
  });
});
