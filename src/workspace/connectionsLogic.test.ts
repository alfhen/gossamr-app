import { describe, expect, it } from "vitest";
import { githubSnapshot, jiraSnapshot } from "../backend/mockProbes";
import type { ConnectionInfo } from "../types";
import { actingAs, isSignedOut, oldestCheck, rowAfter, statusLine } from "./connectionsLogic";

const CHECKED = "2026-10-30T11:57:00Z";
const base: ConnectionInfo = { id: "github:ada", instanceId: "github", displayName: "GitHub", enabled: true, kind: "github", workspace: "ada", url: null, account: "Ada Example", lastSyncAt: null, syncing: false, error: null, transient: false, reauth: false, status: null };
const github = (state: Parameters<typeof githubSnapshot>[0]): ConnectionInfo => ({ ...base, status: githubSnapshot(state, "ada", CHECKED) });
const jira = (over: Partial<ConnectionInfo> = {}): ConnectionInfo => ({ ...base, id: "jira:c:u", instanceId: "jira", displayName: "Acme Jira", kind: "jira", workspace: "acme.atlassian.net", ...over });

describe("a connection's line in the list", () => {
  it("says who is signed in when the check passed", () => {
    expect(statusLine(github("ready"), false)).toEqual({ text: "Authenticated · ada", tone: "ok" });
  });

  it("says Checking only while a probe runs", () => {
    expect(statusLine(github("ready"), true).text).toBe("Checking…");
    expect(statusLine(base, true)).toEqual({ text: "Checking…", tone: "busy" });
  });

  it("does not claim a check is running for a connection that has no snapshot and none pending", () => {
    expect(statusLine(base, false)).toEqual({ text: "Not checked yet", tone: "quiet" });
  });

  it("says Not signed in and Not found as an error for Jira", () => {
    expect(statusLine(jira({ status: jiraSnapshot("notSignedIn", CHECKED) }), false)).toEqual({ text: "Not signed in", tone: "error" });
    expect(statusLine(jira({ status: { ...githubSnapshot("notFound", "x", CHECKED) } }), false)).toEqual({ text: "Not found · jira", tone: "error" });
  });

  it("says Not signed in and Not found as an error for GitHub, because gh decides whether it works", () => {
    expect(statusLine(github("notSignedIn"), false)).toEqual({ text: "Not signed in", tone: "error" });
    expect(statusLine(github("notFound"), false)).toEqual({ text: "Not found · gh", tone: "error" });
  });

  it("shows how long a Jira token has left", () => {
    expect(statusLine(jira({ status: jiraSnapshot("expiresSoon", CHECKED) }), false)).toEqual({ text: "Token expires in 9 days", tone: "unsure" });
  });

  it("says Off for a connection that is off, and says nothing is sent for the sample", () => {
    expect(statusLine(github("off"), false)).toEqual({ text: "Off", tone: "quiet" });
    expect(statusLine({ ...github("ready"), enabled: false }, false).text).toBe("Off");
    expect(statusLine({ ...base, kind: "mock" }, false).text).toContain("nothing is sent");
  });
});

describe("a connection that is signed out", () => {
  it("is one that is on and that Jira turned down", () => {
    expect(isSignedOut(jira({ reauth: true }))).toBe(true);
    expect(isSignedOut(jira({ reauth: true, enabled: false }))).toBe(false);
    expect(isSignedOut(jira({ status: jiraSnapshot("notSignedIn", CHECKED) }))).toBe(true);
  });

  it("is GitHub when gh has no login for it or isn't installed", () => {
    expect(isSignedOut(github("notSignedIn"))).toBe(true);
    expect(isSignedOut(github("notFound"))).toBe(true);
  });

  it("is not Jira just because its probe found nothing to run", () => {
    expect(isSignedOut(jira({ status: githubSnapshot("notFound", "x", CHECKED) }))).toBe(false);
  });

  it("is not GitHub while gh is signed in, can't be reached, or the connection is off", () => {
    expect(isSignedOut(github("ready"))).toBe(false);
    expect(isSignedOut(github("error"))).toBe(false);
    expect(isSignedOut({ ...github("notSignedIn"), enabled: false })).toBe(false);
  });
});

describe("the list's keys and times", () => {
  const ids = ["a", "b", "c"];

  it("moves one row with the arrow keys and holds at the ends", () => {
    expect(rowAfter(ids, "a", "ArrowDown")).toBe("b");
    expect(rowAfter(ids, "c", "ArrowDown")).toBe("c");
    expect(rowAfter(ids, "a", "ArrowUp")).toBe("a");
    expect(rowAfter(ids, "b", "Enter")).toBeNull();
  });

  it("reports the oldest probe, so Checked never promises more than the list knows", () => {
    expect(oldestCheck([github("ready"), jira({ status: jiraSnapshot("expiresSoon", "2026-10-30T11:00:00Z") }), base])).toBe("2026-10-30T11:00:00Z");
    expect(oldestCheck([base])).toBeNull();
  });

  it("names the account drafts post as, and for GitHub the one agents push as", () => {
    expect(actingAs(base)).toEqual(["Drafts post as ada via GitHub.", "Agents clone and push as whichever account gh has active."]);
    expect(actingAs(jira())).toEqual(["Drafts post as Ada Example via Jira."]);
    expect(actingAs({ ...base, kind: "mock" })).toEqual([]);
  });
});
