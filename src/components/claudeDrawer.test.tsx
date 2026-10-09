import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Turn } from "../claudeStore";
import { DrawerTurn, turnInFlight } from "./ClaudeDrawer";

const at = (requestId: string, status: Turn["status"]): Turn => ({ requestId, prompt: `Question ${requestId}`, steps: [], text: "", status, error: null });

describe("the classic drawer with Pip's queue", () => {
  it("counts a turn queued behind other Pip processes as in flight, so the input stays gated and Stop can end it", () => {
    expect(turnInFlight(undefined)).toBeNull();
    expect(turnInFlight({ sessionId: null, turns: [at("r1", "done")] })).toBeNull();
    expect(turnInFlight({ sessionId: null, turns: [at("r1", "done"), at("r2", "queued")] })?.requestId).toBe("r2");
    expect(turnInFlight({ sessionId: null, turns: [at("r1", "running")] })?.requestId).toBe("r1");
  });

  it("says a queued turn waits for Pip, and shows nothing of the sort once it runs", () => {
    expect(renderToStaticMarkup(<DrawerTurn turn={at("r1", "queued")} proposals={[]} />)).toContain("Queued, starts when Pip is free");
    const running = renderToStaticMarkup(<DrawerTurn turn={at("r1", "running")} proposals={[]} />);
    expect(running).not.toContain("Queued");
    expect(running).toContain("Working…");
  });
});
