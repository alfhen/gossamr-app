import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "./mock";

const GH = "github:ada";

describe("the mock GitHub connection", () => {
  it("is signed out until a sign-in command runs", async () => {
    const b = new MockBackend();
    expect((await b.connectionsList()).map((c) => c.kind)).toEqual(["mock"]);
    expect(await b.watchGet()).toHaveLength(1);
    expect(await b.githubSignInOptions()).toEqual({ deviceFlow: true, ghCli: true, token: true });
  });

  it("connects with a pasted token, refuses a bad one, and lists 14 repositories that wait for a choice", async () => {
    const b = new MockBackend();
    await expect(b.githubConnectToken("bad")).rejects.toThrow("didn't accept the token");
    await expect(b.githubConnectToken("  ")).rejects.toThrow();
    const connection = await b.githubConnectToken("ghp_x");
    expect([connection.id, connection.kind, connection.workspace]).toEqual([GH, "github", "ada"]);
    expect((await b.connectionsList()).map((c) => c.id)).toEqual(["mock", GH]);
    const state = (await b.watchGet()).find((s) => s.connectionId === GH)!;
    expect([state.mode, state.needsChoice, state.catalogSize]).toEqual(["unset", true, 13]);
  });

  it("connects through the gh import and the device flow, which must be started before it is polled", async () => {
    const gh = new MockBackend();
    expect((await gh.githubImportGhToken()).id).toBe(GH);

    const device = new MockBackend();
    await expect(device.githubDevicePoll()).rejects.toThrow("start signing in first");
    const start = await device.githubDeviceStart();
    expect([start.userCode, start.verificationUri]).toEqual(["WDJB-MJHT", "https://github.com/login/device"]);
    expect((await device.githubDevicePoll()).id).toBe(GH);
  });

  it("starts signed in with the requested number of repositories, at least the five samples", async () => {
    const big = new MockBackend({ githubRepos: 30 });
    expect((await big.watchCatalog(GH, "")).containers).toHaveLength(30);
    const small = new MockBackend({ githubRepos: 2 });
    expect((await small.watchCatalog(GH, "")).containers).toHaveLength(5);
    const [, state] = await small.watchGet();
    expect([state.mode, state.needsChoice]).toEqual(["everything", false]);
    const twelve = await new MockBackend({ githubRepos: 12 }).watchGet();
    expect(twelve[1].mode).toBe("everything");
    expect((await new MockBackend({ githubRepos: 13 }).watchGet())[1].mode).toBe("unset");
  });

  it("lists repositories like GitHub does: owner/name keys, permission, archived, most recently pushed first", async () => {
    const b = new MockBackend({ githubRepos: 14 });
    const first = await b.watchCatalog(GH, "");
    expect(first.containers[0]).toMatchObject({ key: "acme/webshop", name: "webshop", kind: "push", archived: false });
    expect(first.containers.find((c) => c.name === "legacy-admin")).toMatchObject({ archived: true, kind: "pull" });
    expect(first.containers.map((c) => c.lastActive)).toEqual([...first.containers.map((c) => c.lastActive)].sort().reverse());
    expect((await b.watchCatalog(GH, "gate")).containers.map((c) => c.key)).toEqual(["acme/gateway"]);
  });

  it("pages a big catalog fifty at a time", async () => {
    const b = new MockBackend({ githubRepos: 120 });
    const first = await b.watchCatalog(GH, "");
    expect([first.containers.length, first.next]).toEqual([50, "50"]);
    expect((await b.watchCatalog(GH, "", "100")).next).toBeNull();
  });

  it("watches what the person picks, without touching the Jira watch set", async () => {
    const b = new MockBackend({ githubRepos: 14 });
    const changed = vi.fn();
    const off = b.onWatchChanged(changed);
    await b.watchSetMode(GH, "selected");
    await b.watchSetContainers(GH, [{ containerId: "acme/gateway", watched: true, source: "footprint" }]);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed.mock.calls[0][0]).toEqual({ connectionId: GH });
    const [jira, github] = await b.watchGet();
    expect(jira.mode).toBe("everything");
    expect([github.mode, github.watches.map((w) => [w.container.externalId, w.name, w.source])]).toEqual(["selected", [["acme/gateway", "gateway", "footprint"]]]);
    const page = await b.watchCatalog(GH, "");
    expect(page.containers.filter((c) => c.watched).map((c) => c.key)).toEqual(["acme/gateway"]);
    off();
  });

  it("suggests the repositories the person was active in", async () => {
    const b = new MockBackend({ githubRepos: 14 });
    const rows = await b.watchSuggestions(GH);
    expect(rows.map((r) => r.key)).toEqual(["acme/webshop", "acme/gateway", "acme/infra"]);
    expect(rows[0]).toMatchObject({ reported: 2, assigned: 1 });
    expect(await b.watchUnwatchedAssigned(GH)).toEqual([]);
    expect((await b.watchSuggestions()).every((r) => !r.key.startsWith("acme/"))).toBe(true);
  });

  it("forgets the account on disconnect", async () => {
    const b = new MockBackend({ githubRepos: 14 });
    const changed = vi.fn();
    b.onWatchChanged(changed);
    await b.githubDisconnect(GH);
    expect((await b.connectionsList()).map((c) => c.id)).toEqual(["mock"]);
    expect(await b.watchGet()).toHaveLength(1);
    expect(changed).toHaveBeenCalledWith({ connectionId: GH });
  });
});
