import { describe, expect, it } from "vitest";
import { claudeSnapshot, githubSnapshot, jiraSnapshot } from "../backend/mockProbes";
import type { ConnectionInfo, ModelDefaults, Run } from "../types";
import { actingAs, addEntries, canSwitch, defaultsWith, groupedConnections, hasRealConnection, isSignedOut, isUnreadableProviders, oldestCheck, providersNeedingSignIn, providersShown, removalWarning, removesLastJira, rowAfter, shownConnections, showsCode, statusLine } from "./connectionsLogic";

const CHECKED = "2026-10-30T11:57:00Z";
const base: ConnectionInfo = { id: "github:ada", instanceId: "github", displayName: "GitHub", enabled: true, kind: "github", workspace: "ada", url: null, account: "Ada Example", lastSyncAt: null, syncing: false, error: null, transient: false, reauth: false, status: null, rechecking: false };
const github = (state: Parameters<typeof githubSnapshot>[0]): ConnectionInfo => ({ ...base, status: githubSnapshot(state, "ada", CHECKED) });
const claude = (over: Partial<ConnectionInfo> = {}): ConnectionInfo => ({ ...base, id: "claude", instanceId: "claude", displayName: "Claude", kind: "provider", driver: "claude", workspace: "", ...over });
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

  it("shows a provider's own message as the line when it is signed in, and names its binary when it is missing", () => {
    expect(statusLine(claude({ status: claudeSnapshot("ready", CHECKED) }), false)).toEqual({ text: "Authenticated · alf@acme.com", tone: "ok" });
    expect(statusLine(claude({ status: { ...claudeSnapshot("ready", CHECKED), account: null, message: "Authenticated · ChatGPT" } }), false).text).toBe("Authenticated · ChatGPT");
    expect(statusLine(claude({ status: claudeSnapshot("notFound", CHECKED) }), false)).toEqual({ text: "Not found · claude", tone: "error" });
    expect(statusLine(claude({ driver: "codex", status: claudeSnapshot("notFound", CHECKED) }), false).text).toBe("Not found · codex");
    expect(statusLine(claude({ status: claudeSnapshot("notSignedIn", CHECKED) }), false)).toEqual({ text: "Not signed in", tone: "error" });
    expect(statusLine(claude({ status: claudeSnapshot("error", CHECKED) }), false)).toEqual({ text: "Couldn't check", tone: "unsure" });
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

describe("a provider row", () => {
  it("is never signed out as far as the Jira banner goes, whatever its probe finds", () => {
    expect(isSignedOut(claude({ reauth: true }))).toBe(false);
    expect(isSignedOut(claude({ status: jiraSnapshot("notSignedIn", CHECKED) }))).toBe(false);
    expect(isSignedOut(claude({ status: githubSnapshot("notFound", "x", CHECKED) }))).toBe(false);
  });

  it("is its own instance, so it has a switch", () => {
    expect(canSwitch(claude())).toBe(true);
    expect(canSwitch({ ...base, kind: "mock" })).toBe(false);
    expect(canSwitch({ ...base, id: "github:ada", instanceId: "github:ada" })).toBe(false);
  });

  it("is shown in the list", () => {
    const rows = [jira(), claude(), github("ready")];
    expect(providersShown).toBe(true);
    expect(shownConnections(rows).map((c) => c.kind)).toEqual(["jira", "provider", "github"]);
    expect(shownConnections(rows, false).map((c) => c.kind)).toEqual(["jira", "github"]);
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
    expect(actingAs(github("ready"))).toEqual(["Drafts post as ada via GitHub.", "gh's active account is ada. Agents clone and push with your own git and gh setup, which may be a different account."]);
    expect(actingAs(base)).toEqual(["Drafts post as ada via GitHub.", "Agents clone and push with your own git and gh setup, which may be a different account."]);
    expect(actingAs(github("off"))[1]).toContain("your own git and gh setup");
    expect(actingAs(github("error"))[1]).toContain("your own git and gh setup");
    expect(actingAs(github("notSignedIn"))[1]).toContain("your own git and gh setup");
    expect(actingAs(jira())).toEqual(["Drafts post as Ada Example via Jira."]);
    expect(actingAs({ ...base, kind: "mock" })).toEqual([]);
  });
});

describe("when code shows", () => {
  it("shows code while a GitHub account is on", () => {
    expect(showsCode([jira(), base])).toBe(true);
  });

  it("hides code when every GitHub account is off, and when there is none", () => {
    expect(showsCode([jira(), { ...base, enabled: false }])).toBe(false);
    expect(showsCode([jira()])).toBe(false);
  });

  it("shows code when one of two GitHub accounts is on", () => {
    expect(showsCode([{ ...base, enabled: false }, base])).toBe(true);
  });
});

describe("removalWarning", () => {
  it("says a provider's folder and login stay on disk and mentions no tickets or token", () => {
    const text = removalWarning({ kind: "provider", displayName: "Claude", workspace: "" });
    expect(text).toContain("your login and folder stay as they are");
    expect(text).not.toMatch(/token|ticket/);
  });
});

describe("the defaults a model picker writes", () => {
  const before: ModelDefaults = { pip: { instanceId: "claude", model: "sonnet", effort: "medium" }, agents: { instanceId: "claude", model: "default" } };

  it("changes only Pip's default when Pip's picker is used", () => {
    const next = defaultsWith(before, "pip", { instanceId: "claude_2", model: "opus", effort: "medium" });
    expect(next).toEqual({ pip: { instanceId: "claude_2", model: "opus", effort: "medium" }, agents: before.agents });
  });

  it("changes only the agents' default when New agents use is used, and drops any effort", () => {
    const next = defaultsWith(before, "agents", { instanceId: "claude_2", model: "opus", effort: "high" });
    expect(next).toEqual({ pip: before.pip, agents: { instanceId: "claude_2", model: "opus" } });
  });
});

describe("the + Add entries", () => {
  const ids = (providers: boolean) => addEntries(providers).map((e) => e.id);

  it("always offers a GitHub account and a Jira account, whatever is connected", () => {
    expect(ids(false)).toEqual(["github", "jira"]);
  });

  it("offers Claude and Codex when provider rows are shown", () => {
    expect(ids(false)).not.toContain("claude");
    expect(ids(false)).not.toContain("codex");
    expect(ids(true)).toEqual(["github", "jira", "claude", "codex"]);
  });

  it("offers Codex with a Beta label without any page switch", () => {
    expect(addEntries().find((e) => e.id === "codex")?.beta).toBe(true);
    expect(addEntries().find((e) => e.id === "claude")?.beta).toBe(false);
  });

  it("puts each entry under its group", () => {
    expect(addEntries(true).map((e) => [e.id, e.group])).toEqual([["github", "Code"], ["jira", "Tickets"], ["claude", "Models"], ["codex", "Models"]]);
  });
});

describe("removing a Jira connection", () => {
  const second = jira({ id: "jira:b:u", instanceId: "jira_2" });

  it("goes back to Setup only when it was the last Jira", () => {
    expect(removesLastJira([jira()], jira())).toBe(true);
    expect(removesLastJira([jira(), second], jira())).toBe(false);
    expect(removesLastJira([jira(), second], second)).toBe(false);
  });

  it("never goes back to Setup for a GitHub connection", () => {
    expect(removesLastJira([base], base)).toBe(false);
  });
});

describe("the grouped list", () => {
  it("groups rows under Code, Tickets and Models, keeping each group's order", () => {
    const mock = { ...base, id: "mock", kind: "mock" as const };
    const groups = groupedConnections([jira(), claude(), mock, base]);
    expect(groups.map((g) => [g.group, g.rows.map((c) => c.id)])).toEqual([["Code", ["github:ada"]], ["Tickets", ["jira:c:u", "mock"]], ["Models", ["claude"]]]);
  });

  it("leaves out a group with no rows", () => {
    expect(groupedConnections([base]).map((g) => g.group)).toEqual(["Code"]);
    expect(groupedConnections([])).toEqual([]);
  });
});

describe("hasRealConnection", () => {
  it("counts GitHub and Jira, not the sample data or a provider", () => {
    expect(hasRealConnection([{ ...base, kind: "mock" }, claude()])).toBe(false);
    expect(hasRealConnection([base])).toBe(true);
    expect(hasRealConnection([jira()])).toBe(true);
  });
});

describe("the row for a providers list that can't be read", () => {
  const unreadable = claude({ id: "providers", instanceId: "providers", displayName: "Models", driver: undefined, enabled: false, error: "config.json: providers is not a list" });

  it("says the problem instead of Off", () => {
    expect(isUnreadableProviders(unreadable)).toBe(true);
    expect(isUnreadableProviders(claude())).toBe(false);
    expect(statusLine(unreadable, false)).toEqual({ text: "config.json: providers is not a list", tone: "error" });
  });

  it("has no switch", () => {
    expect(canSwitch(unreadable)).toBe(false);
    expect(canSwitch(claude())).toBe(true);
  });
});

describe("the logins the sign-in banner names", () => {
  const codex = (over: Partial<ConnectionInfo> = {}): ConnectionInfo =>
    claude({ id: "codex_2", instanceId: "codex_2", displayName: "Codex work", driver: "codex", configDir: "~/.codex-work", status: { state: "notSignedIn" } as ConnectionInfo["status"], ...over });

  it("counts a signed-out Codex that the New agents use default names, with its codex login command", () => {
    const defaults: ModelDefaults = { pip: null, agents: { instanceId: "codex_2", model: "default" } };
    expect(providersNeedingSignIn([codex()], [], defaults)).toEqual([{ id: "codex_2", kind: "provider", displayName: "Codex work", instanceId: "codex_2", signIn: "CODEX_HOME=~/.codex-work codex login" }]);
  });

  it("counts a signed-out Codex that a queued run waits on, and stays quiet when nothing uses it", () => {
    const queued = { state: "queued", runsOn: { instanceId: "codex_2", model: "default" } } as Run;
    expect(providersNeedingSignIn([codex()], [queued], null).map((l) => l.instanceId)).toEqual(["codex_2"]);
    expect(providersNeedingSignIn([codex()], [], null)).toEqual([]);
  });
});
