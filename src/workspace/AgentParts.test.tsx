import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConnectionInfo, Run } from "../types";
import { RunsOnView, rowText } from "./AgentParts";
import { instanceOf, runsOnText } from "./runInstance";
import { loginsWithWaitingRuns } from "./SignInBanner";

const run = (state: Run["state"], over: Partial<Run> = {}) => ({ id: "r1", state, shortId: state === "queued" ? null : "1000a000", runsOn: { instanceId: "claude_2", model: "sonnet" }, ...over }) as Run;
const work = { name: "Claude work", signIn: "CLAUDE_CONFIG_DIR=~/.claude-work claude auth login" };

describe("what a run runs on", () => {
  it("says Runs on for a queued run and Ran on once it has started", () => {
    expect(runsOnText(run("queued"), work)).toBe("Runs on Claude work · Sonnet");
    expect(runsOnText(run("working"), work)).toBe("Ran on Claude work · Sonnet");
    expect(runsOnText(run("done"), work)).toBe("Ran on Claude work · Sonnet");
  });

  it("says Runs on for a launch that failed before it had a session, since Retry uses the same choice", () => {
    expect(runsOnText(run("failed", { shortId: null }), work)).toBe("Runs on Claude work · Sonnet");
  });

  it("shows a model id the list doesn't know as it is, and says nothing for a run with no recorded choice", () => {
    expect(runsOnText(run("queued", { runsOn: { instanceId: "claude_2", model: "claude-x-1" } }), work)).toBe("Runs on Claude work · claude-x-1");
    expect(runsOnText(run("queued", { runsOn: null }), work)).toBeNull();
  });

  it("names the instance from the provider rows, and its sign-in command only for a login in its own folder", () => {
    const rows = [
      { kind: "provider", instanceId: "claude", displayName: "Claude", driver: "claude" },
      { kind: "provider", instanceId: "claude_2", displayName: "Claude work", driver: "claude", configDir: "~/.claude-work" },
    ] as ConnectionInfo[];
    expect(instanceOf(rows, "claude_2")).toEqual(work);
    expect(instanceOf(rows, "claude")).toEqual({ name: "Claude", signIn: null });
    expect(instanceOf(rows, "gone").name).toBe("gone");
  });

  it("puts Change beside the text only when a picker is given", () => {
    expect(renderToStaticMarkup(<RunsOnView text="Runs on Claude work · Sonnet" />)).not.toContain("<button");
    const withPicker = renderToStaticMarkup(<RunsOnView text="Runs on Claude work · Sonnet" picker={<button type="button">Change</button>} />);
    expect(withPicker).toContain("Runs on Claude work · Sonnet");
    expect(withPicker).toContain("Change</button>");
  });

  it("names the login in a failed row's line", () => {
    const failed = run("failed", { shortId: null, failure: { type: "notSignedIn" } as Run["failure"] });
    expect(rowText(failed, 0, [], work)).toBe("Claude work isn't signed in.");
  });
});

describe("the signed-out login banner", () => {
  const row = (over: Partial<ConnectionInfo>) =>
    ({ id: "claude_2", instanceId: "claude_2", displayName: "Claude work", kind: "provider", driver: "claude", enabled: true, status: { state: "notSignedIn", fix: work.signIn }, ...over }) as ConnectionInfo;

  it("names a signed-out Claude that a queued run waits on, with its command", () => {
    expect(loginsWithWaitingRuns([row({})], [run("queued")])).toEqual([{ id: "claude_2", kind: "provider", displayName: "Claude work", instanceId: "claude_2", signIn: work.signIn }]);
  });

  it("stays quiet when no run needs the login, the run is on another login, or the login is signed in", () => {
    expect(loginsWithWaitingRuns([row({})], [run("working")])).toEqual([]);
    expect(loginsWithWaitingRuns([row({})], [run("queued", { runsOn: { instanceId: "claude", model: "sonnet" } })])).toEqual([]);
    expect(loginsWithWaitingRuns([row({ status: { state: "ready" } as ConnectionInfo["status"] })], [run("queued")])).toEqual([]);
  });
});
