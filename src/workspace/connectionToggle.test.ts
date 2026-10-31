import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "../workspaceStore";
import { setConnectionEnabled } from "./connectionToggle";
import { useToasts } from "./toasts";

const original = useWorkspace.getState();
const github = { instanceId: "github", displayName: "GitHub" };

afterEach(() => {
  useWorkspace.setState(original, true);
  useToasts.getState().clear();
});

describe("turning a connection on or off", () => {
  it("asks the backend by instance id and re-reads the connections", async () => {
    const connectionSetEnabled = vi.fn().mockResolvedValue(undefined);
    const refreshConnections = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({ backend: { connectionSetEnabled } as never, refreshConnections });
    await expect(setConnectionEnabled(github, false)).resolves.toBe(true);
    expect(connectionSetEnabled).toHaveBeenCalledWith("github", false);
    expect(refreshConnections).toHaveBeenCalledOnce();
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it("gives the reason in a toast, and does not re-read, when the backend refuses", async () => {
    const connectionSetEnabled = vi.fn().mockRejectedValue(new Error("Gossamr is posting a draft for GitHub right now. Try again in a moment."));
    const refreshConnections = vi.fn();
    useWorkspace.setState({ backend: { connectionSetEnabled } as never, refreshConnections });
    await expect(setConnectionEnabled(github, false)).resolves.toBe(false);
    expect(refreshConnections).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Couldn't turn off GitHub: Gossamr is posting a draft for GitHub right now. Try again in a moment."]);
  });

  it("says it turned the connection on even when re-reading the list fails afterwards", async () => {
    const report = vi.fn();
    useWorkspace.setState({ backend: { connectionSetEnabled: vi.fn().mockResolvedValue(undefined) } as never, refreshConnections: vi.fn().mockRejectedValue(new Error("down")), report });
    await expect(setConnectionEnabled(github, true)).resolves.toBe(true);
    expect(report).toHaveBeenCalledWith("Couldn't refresh the connections", expect.any(Error));
  });

  it("does nothing before there is a backend", async () => {
    useWorkspace.setState({ backend: null });
    await expect(setConnectionEnabled(github, true)).resolves.toBe(false);
  });
});
