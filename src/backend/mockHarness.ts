import type { HarnessAction, HarnessStatus } from "../types";

export const MOCK_HARNESS_BUILD = "2f6c1a9e04b7";
const OLDER_BUILD = "9d0e33c41a20";
export const MOCK_HARNESS_FAILURE = "The harness can't start: the path of its folder is too long for macOS (118 bytes, at most 103).";

/** The harness beside the app, as the desktop backend reports it: running the bundled build unless told otherwise. */
export class MockHarness {
  private status: HarnessStatus;
  private stoppedByYou = false;
  private listeners = new Set<() => void>();

  /** "older" runs another build of the same protocol; "failed" can't start, and says why. */
  constructor(start?: "older" | "failed") {
    this.status =
      start === "failed"
        ? { state: "failed", build: null, bundledBuild: MOCK_HARNESS_BUILD, update: false, message: MOCK_HARNESS_FAILURE }
        : { state: "running", build: start === "older" ? OLDER_BUILD : MOCK_HARNESS_BUILD, bundledBuild: MOCK_HARNESS_BUILD, update: start === "older", message: null };
  }

  act(action?: HarnessAction): HarnessStatus {
    if (action === "stop") {
      this.stoppedByYou = true;
      this.status = { ...this.status, state: "stopped", build: null, update: false, message: "Stopped." };
    } else if (action || (!this.stoppedByYou && this.status.state === "running")) {
      if (action) this.stoppedByYou = false;
      if (action || this.status.state !== "failed") {
        const message = action === "restart" ? "Restarted." : this.status.message;
        this.status = { state: "running", build: action ? MOCK_HARNESS_BUILD : this.status.build, bundledBuild: MOCK_HARNESS_BUILD, update: action ? false : this.status.update, message };
      }
    }
    return { ...this.status };
  }

  onChanged(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}
