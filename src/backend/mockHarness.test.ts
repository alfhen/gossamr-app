import { describe, expect, it } from "vitest";
import { MOCK_HARNESS_BUILD, MOCK_HARNESS_FAILURE, MockHarness } from "./mockHarness";

describe("the mock harness", () => {
  it("runs the bundled build and stays stopped once stopped, until started", () => {
    const h = new MockHarness();
    expect(h.act()).toMatchObject({ state: "running", build: MOCK_HARNESS_BUILD, update: false });
    expect(h.act("stop")).toMatchObject({ state: "stopped", build: null });
    expect(h.act().state).toBe("stopped");
    expect(h.act("start")).toMatchObject({ state: "running", build: MOCK_HARNESS_BUILD, message: null });
  });

  it("offers a restart for an older build, which updates it", () => {
    const h = new MockHarness("older");
    const kept = h.act();
    expect(kept.update).toBe(true);
    expect(kept.build).not.toBe(MOCK_HARNESS_BUILD);
    expect(h.act("restart")).toMatchObject({ state: "running", build: MOCK_HARNESS_BUILD, update: false, message: "Restarted." });
  });

  it("fails every read while unreachable, then answers", () => {
    const h = new MockHarness("unreachable");
    expect(() => h.act()).toThrow();
    expect(() => h.act()).toThrow();
    h.reach();
    expect(h.act().state).toBe("running");
  });

  it("says why it can't start until you try again", () => {
    const h = new MockHarness("failed");
    expect(h.act()).toMatchObject({ state: "failed", message: MOCK_HARNESS_FAILURE });
    expect(h.act().state).toBe("failed");
    expect(h.act("start")).toMatchObject({ state: "running", message: null });
  });
});
