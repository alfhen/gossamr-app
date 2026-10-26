import { describe, expect, it } from "vitest";
import type { ConnectionInfo, WatchState } from "../types";
import { connectionOfKeys } from "./jump";

describe("connectionOfKeys", () => {
  const conn = (id: string, kind: string) => ({ id, kind }) as ConnectionInfo;
  const ws = (connections: ConnectionInfo[], watch: Pick<WatchState, "connectionId">[] = []) => ({ connections, watch }) as Parameters<typeof connectionOfKeys>[0];

  it("is nothing until a work connection or a watched work ticket is there, which is what the palette's lookup waits for", () => {
    expect(connectionOfKeys(ws([conn("github:me", "github")]))).toBeUndefined();
    expect(connectionOfKeys(ws([conn("github:me", "github")], [{ connectionId: "jira:acme" }]))).toBe("jira:acme");
    expect(connectionOfKeys(ws([conn("github:me", "github"), conn("jira:acme", "jira")]))).toBe("jira:acme");
  });
});
