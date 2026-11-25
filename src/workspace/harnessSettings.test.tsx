import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HarnessAction, HarnessStatus } from "../types";
import { HarnessView } from "./HarnessSettings";

const RUNNING: HarnessStatus = { state: "running", build: "b1", bundledBuild: "b1", update: false, message: null };
const view = (failed: HarnessAction | null) => renderToStaticMarkup(<HarnessView status={RUNNING} busy={false} failed={failed} onAction={vi.fn()} />);

describe("the harness section in Settings", () => {
  it("says so when a Stop, Restart or Start didn't come back", () => {
    expect(view("stop")).toMatch(/role="alert"[^>]*>Couldn&#x27;t stop the harness\. Try again\./);
    expect(view("restart")).toContain("restart the harness. Try again.");
    expect(view("start")).toContain("start the harness. Try again.");
    expect(view(null)).not.toContain("role=\"alert\"");
  });
});
