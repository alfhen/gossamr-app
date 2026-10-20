import { afterEach, describe, expect, it, vi } from "vitest";
import { focusAdoptButton, focusAdopted, focusAgentsList, focusWorkstreamRow } from "./focusDrawn";

/** A page that answers each selector with an element that records being focused; frames run at once. */
function page(found: Record<string, string>) {
  const focused: string[] = [];
  const active = { current: null as unknown };
  const doc = {
    get activeElement() {
      return active.current;
    },
    querySelector: (s: string) => (found[s] ? { focus: () => (focused.push(found[s]), (active.current = found[s])) } : null),
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => void run());
  return focused;
}

afterEach(() => vi.unstubAllGlobals());

describe("where the keyboard goes after the offers (G7)", () => {
  it("lands on a reopened workstream's open button in the Agents list", () => {
    const focused = page({ '[data-workstream-group="ws-1"] [data-workstream-open]': "open" });
    focusWorkstreamRow("ws-1");
    expect(focused[0]).toBe("open");
  });

  it("lands on the Agents list's first workstream once a card over it has closed, else on its heading", () => {
    expect(page({ "[data-agents-home] [data-workstream-open]": "open", "[data-agents-home] h1": "heading" }) && (focusAgentsList(), true)).toBe(true);
    const focused = page({ "[data-agents-home] h1": "heading" });
    focusAgentsList();
    expect(focused[0]).toBe("heading");
  });

  it("lands on Bring them here again once its adoption is undone", () => {
    const focused = page({ '[data-adopt-notice="ws-1"] [data-adopt]': "adopt" });
    focusAdoptButton("ws-1");
    expect(focused[0]).toBe("adopt");
  });

  it("lands on the timeline once the runs are brought in", () => {
    const focused = page({ "aside[data-pip-root] [data-timeline]": "timeline" });
    focusAdopted();
    expect(focused[0]).toBe("timeline");
  });
});
