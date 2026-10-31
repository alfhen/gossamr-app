import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "../workspaceStore";
import { disconnectGithub } from "./githubUi";
import { useToasts } from "./toasts";

const original = useWorkspace.getState();

afterEach(() => {
  useWorkspace.setState(original, true);
  useToasts.getState().clear();
});

describe("disconnecting GitHub", () => {
  it("still says it disconnected when re-reading the cache afterwards fails", async () => {
    const githubDisconnect = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    useWorkspace.setState({
      backend: { githubDisconnect } as never,
      refreshConnections: vi.fn().mockResolvedValue(undefined),
      refreshWatch: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockRejectedValue(new Error("Jira is unreachable")),
      report,
    });
    await expect(disconnectGithub("github:ada", "ada")).resolves.toBe(true);
    expect(githubDisconnect).toHaveBeenCalledWith("github:ada");
    expect(report).toHaveBeenCalledWith("Couldn't refresh after disconnecting", expect.any(Error));
    expect(useToasts.getState().toasts.map((t) => t.text)).toContain("Disconnected ada. Its token and cached pull requests are gone.");
  });

  it("reports false and keeps the connection when the disconnect itself fails", async () => {
    useWorkspace.setState({ backend: { githubDisconnect: vi.fn().mockRejectedValue(new Error("locked")) } as never });
    await expect(disconnectGithub("github:ada", "ada")).resolves.toBe(false);
  });
});
