import { beforeEach, describe, expect, it } from "vitest";
import type { Need } from "../lib/needs";
import { openNeed, setPaneIntent, takePaneIntent } from "./needsActions";
import { usePipHome } from "./pipHomeStore";
import { useTabs } from "./tabsStore";
import { lastReadHeldTimes, currentNeeds, setLastReadHeldTimes } from "./useNeeds";
import { useWorkstreams } from "./workstreamsStore";

const need = (key: string) => ({ key, workstreamId: null }) as unknown as Need;

describe("opening a need with an intent", () => {
  beforeEach(() => {
    usePipHome.getState().reset();
    setPaneIntent(null);
    useTabs.setState({ route: "pip" });
  });

  it("remounts a decision that is already open, so Edit is pressed", () => {
    openNeed(need("a"));
    const rev = usePipHome.getState().paneRev;
    openNeed(need("a"), { edit: true });
    expect(usePipHome.getState().paneRev).toBe(rev + 1);
    expect(takePaneIntent()).toBe("edit");
  });

  it("does not remount for a need that is not open yet, or when not editing", () => {
    openNeed(need("a"));
    const rev = usePipHome.getState().paneRev;
    openNeed(need("b"), { edit: true });
    openNeed(need("b"));
    expect(usePipHome.getState().paneRev).toBe(rev);
  });

  it("clears a stale intent when the next action is not Edit", () => {
    openNeed(need("a"), { edit: true });
    openNeed(need("b"));
    expect(takePaneIntent()).toBeNull();
  });
});

describe("hold times Pip is told", () => {
  it("are the ones the list last read", () => {
    const held = { workstream: { id: "ws-1", closedAt: null, heldReason: "person", createdAt: "2026-01-01T00:00:00Z" }, stage: "intake", runs: [], labels: [] };
    useWorkstreams.setState({ list: [held] as never });
    const before = currentNeeds().find((n) => n.key === "held:ws-1");
    setLastReadHeldTimes({ "ws-1": "2026-06-01T00:00:00Z" });
    expect(lastReadHeldTimes()).toEqual({ "ws-1": "2026-06-01T00:00:00Z" });
    const after = currentNeeds().find((n) => n.key === "held:ws-1");
    expect(before?.at).toBe("2026-01-01T00:00:00.000Z".replace(".000", ""));
    expect(after?.at).toBe("2026-06-01T00:00:00Z");
    setLastReadHeldTimes({});
  });
});
