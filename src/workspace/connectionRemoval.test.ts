import { afterEach, describe, expect, it, vi } from "vitest";
import { onSignedOut } from "../accountEvents";
import { useWorkspace } from "../workspaceStore";
import { removeConnection } from "./connectionRemoval";
import { useToasts } from "./toasts";

const original = useWorkspace.getState();
const github = { instanceId: "github", kind: "github" as const, displayName: "GitHub" };
const jira = { instanceId: "jira", kind: "jira" as const, displayName: "Acme Jira" };

afterEach(() => {
  useWorkspace.setState(original, true);
  useToasts.getState().clear();
});

describe("removing a connection", () => {
  it("still says it removed GitHub when re-reading the cache afterwards fails", async () => {
    const connectionRemove = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    useWorkspace.setState({
      backend: { connectionRemove } as never,
      refreshConnections: vi.fn().mockResolvedValue(undefined),
      refreshWatch: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockRejectedValue(new Error("Jira is unreachable")),
      report,
    });
    await expect(removeConnection(github)).resolves.toBe(true);
    expect(connectionRemove).toHaveBeenCalledWith("github");
    expect(report).toHaveBeenCalledWith("Couldn't refresh after removing it", expect.any(Error));
    expect(useToasts.getState().toasts.map((t) => t.text)).toContain("Removed GitHub.");
  });

  it("sends the app back to sign-in when Jira was removed", async () => {
    useWorkspace.setState({ backend: { connectionRemove: vi.fn().mockResolvedValue(undefined) } as never });
    const heard = vi.fn();
    const off = onSignedOut(heard);
    await expect(removeConnection(jira)).resolves.toBe(true);
    off();
    expect(heard).toHaveBeenCalledOnce();
  });

  it("reports false with the reason, and changes nothing, when the backend refuses", async () => {
    const connectionRemove = vi.fn().mockRejectedValue(new Error("Gossamr is posting a draft for GitHub right now. Try again in a moment."));
    useWorkspace.setState({ backend: { connectionRemove } as never });
    const heard = vi.fn();
    const off = onSignedOut(heard);
    await expect(removeConnection(jira)).resolves.toBe(false);
    off();
    expect(heard).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts.map((t) => t.text).join()).toContain("Couldn't remove Acme Jira: Gossamr is posting a draft");
  });
});
