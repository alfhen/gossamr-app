import { describe, expect, it } from "vitest";
import type { Run } from "../types";
import { waitingText } from "./RunSheet";

const run = (over: Partial<Run>, workstream: string | null = "ws-1") => ({ proposalId: "", slotWaitSince: null, ...over, spec: { workstream } }) as unknown as Run;

describe("why a queued agent waits", () => {
  it("says Pip started an agent in a workstream, and keeps 'approved' for one a draft approved", () => {
    expect(waitingText(run({}))).toMatch(/^Pip started it, and it launches on its own/);
    expect(waitingText(run({ proposalId: "p1" }))).toMatch(/^It is approved and launches on its own/);
  });

  it("says why an instance or model can't run the agent yet, ahead of the slot and workstream words", () => {
    const waiting = run({ slotWaitSince: "2026-01-01T00:00:00Z", waitReason: "Waits for Claude personal, which is off." });
    expect(waitingText(waiting)).toBe("Waits for Claude personal, which is off. It starts on its own once that changes.");
  });
});
