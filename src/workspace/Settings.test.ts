import { describe, expect, it } from "vitest";
import { agentsPromise, PROMISES } from "./Settings";

describe("the agents promise in Settings", () => {
  it("names the Claude new agents run on", () => {
    expect(agentsPromise("Claude work")).toBe("Agents run on Claude work with its own Claude Code settings, so they can push branches and use your own tools.");
  });

  it("keeps the general wording until the instance is known", () => {
    expect(agentsPromise(null)).toBe(PROMISES[1]);
  });
});
