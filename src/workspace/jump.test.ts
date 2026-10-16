import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionInfo, WatchState } from "../types";
import { connectionOfKeys, focusComment } from "./jump";

afterEach(() => vi.unstubAllGlobals());

describe("focusComment", () => {
  it("takes the keyboard to the comment in the peek, making it focusable without scrolling the page", () => {
    const attrs = new Map<string, string>();
    const el = { hasAttribute: (n: string) => attrs.has(n), setAttribute: (n: string, v: string) => void attrs.set(n, v), focus: vi.fn() };
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "comment-c1" ? el : null) });
    expect(focusComment("c1")).toBe(true);
    expect(attrs.get("tabindex")).toBe("-1");
    expect(el.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does nothing for a comment that isn't shown", () => {
    vi.stubGlobal("document", { getElementById: () => null });
    expect(focusComment("gone")).toBe(false);
  });
});

describe("connectionOfKeys", () => {
  const conn = (id: string, kind: string) => ({ id, kind }) as ConnectionInfo;
  const ws = (connections: ConnectionInfo[], watch: Pick<WatchState, "connectionId">[] = []) => ({ connections, watch }) as Parameters<typeof connectionOfKeys>[0];

  it("is nothing until a work connection or a watched work ticket is there, which is what the palette's lookup waits for", () => {
    expect(connectionOfKeys(ws([conn("github:me", "github")]))).toBeUndefined();
    expect(connectionOfKeys(ws([conn("github:me", "github")], [{ connectionId: "jira:acme" }]))).toBe("jira:acme");
    expect(connectionOfKeys(ws([conn("github:me", "github"), conn("jira:acme", "jira")]))).toBe("jira:acme");
  });
});
