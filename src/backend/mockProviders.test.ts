import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";

const home = "/Users/sample";

describe("adding a provider instance in the mock", () => {
  it("lists it after the default with its folder as typed, unchecked until the next list, and names the next id", async () => {
    const b = new MockBackend();
    const row = await b.providerAdd("claude", " Claude personal ", "~/.claude-personal");
    expect(row).toMatchObject({ id: "claude_2", instanceId: "claude_2", kind: "provider", driver: "claude", displayName: "Claude personal", enabled: true, configDir: "~/.claude-personal", status: null });
    const listed = (await b.connectionsList()).filter((c) => c.kind === "provider");
    expect(listed.map((c) => c.instanceId)).toEqual(["claude", "claude_2"]);
    expect(listed[1]!.status).toMatchObject({ state: "notSignedIn", fix: "CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login" });
  });

  it("opens Terminal on the sign-in with the folder, and the default's has none", async () => {
    const b = new MockBackend({ claudeProbe: "notSignedIn" });
    await b.providerAdd("claude", "Work", "~/My Claude");
    await b.connectionsList();
    await b.connectionOpenTerminal("claude_2");
    await b.connectionOpenTerminal("claude");
    expect(b.terminals).toEqual(["CLAUDE_CONFIG_DIR=~/'My Claude' claude auth login", "claude auth login"]);
  });

  it("quotes a folder with a space or a Codex folder outside ~ the way the desktop backend shows it", async () => {
    const b = new MockBackend();
    await b.providerAdd("claude", "Work", "~/My Claude");
    await b.providerAdd("codex", "Codex", `${home}/Code Work`);
    const fixes = (await b.connectionsList()).flatMap((c) => (c.kind === "provider" && c.status?.fix ? [c.status.fix] : []));
    expect(fixes).toEqual(["CLAUDE_CONFIG_DIR=~/'My Claude' claude auth login", `CODEX_HOME='${home}/Code Work' codex login`]);
  });

  it("refuses Terminal on a just-added instance until its first check has answered", async () => {
    const b = new MockBackend();
    await b.providerAdd("claude", "Work", "~/.claude-work");
    await expect(b.connectionOpenTerminal("claude_2")).rejects.toThrow("Check it again.");
    expect(b.terminals).toEqual([]);
    await b.connectionsList();
    await b.connectionOpenTerminal("claude_2");
    expect(b.terminals).toEqual(["CLAUDE_CONFIG_DIR=~/.claude-work claude auth login"]);
  });

  it("adds and signs in nothing while the providers list can't be read", async () => {
    const b = new MockBackend({ claudeProbe: "notSignedIn" });
    b.providersProblem = "Gossamr can't read the providers in config.json.";
    await expect(b.providerAdd("claude", "Work", "~/.claude-work")).rejects.toThrow("can't add one");
    await expect(b.connectionOpenTerminal("claude")).rejects.toThrow("can't read the providers");
    expect(b.terminals).toEqual([]);
  });

  it("adds a Codex instance whose models are Codex's and whose sign-in is codex login", async () => {
    const b = new MockBackend();
    const added = await b.providerAdd("codex", "Codex", "~/.codex-work");
    const row = (await b.connectionsList()).find((c) => c.instanceId === added.instanceId)!;
    expect(row.status).toMatchObject({ state: "notSignedIn", message: "Not signed in to Codex.", fix: "CODEX_HOME=~/.codex-work codex login" });
    expect(row.id).toBe("codex");
    expect((await b.providerModels("codex")).length).toBeGreaterThan(0);
  });

  it("refuses each folder the desktop backend refuses and adds nothing", async () => {
    const b = new MockBackend();
    await b.providerAdd("claude", "Work", "~/.claude-work");
    const cases: [string, string][] = [
      ["~/.claude", "That's your usual setup"],
      ["~/.CLAUDE", "That's your usual setup"],
      [`${home}/.claude/`, "That's your usual setup"],
      ["~/.codex", "usual folder of Codex"],
      ["~/it's", "quote"],
      ["~/two\nlines", "unusual character"],
      ["~/.CLAUDE-WORK", "Another Claude already uses this folder."],
      ["~/x/../.claude-work", "Another Claude already uses this folder."],
      ["/tmp/elsewhere", "inside your home folder"],
      ["~", "inside your home folder"],
      ["~/../other", "inside your home folder"],
      ["relative/dir", "full path"],
      [`${home}/Library/Application Support/gossamr/claude`, "data folder"],
      ["  ", "empty"],
    ];
    for (const [typed, wanted] of cases) await expect(b.providerAdd("claude", "Nope", typed), typed).rejects.toThrow(wanted);
    expect((await b.connectionsList()).filter((c) => c.kind === "provider")).toHaveLength(2);
  });

  it("allows one instance per driver without a folder and refuses a bad name", async () => {
    const b = new MockBackend();
    await expect(b.providerAdd("claude", "Again")).rejects.toThrow("Your usual setup is already added as Claude.");
    await expect(b.providerAdd("claude", "  ", "~/.claude-work")).rejects.toThrow("Give the connection a name.");
    expect((await b.providerAdd("codex", "Codex")).id).toBe("codex");
    await expect(b.providerAdd("codex", "Codex 2")).rejects.toThrow("Your usual setup is already added as Codex.");
  });

  it("never gives out the id of a removed instance again, and frees its folder", async () => {
    const b = new MockBackend();
    await b.providerAdd("claude", "Work", "~/.claude-work");
    await b.connectionRemove("claude_2");
    expect((await b.providerAdd("claude", "Work", "~/.claude-work")).id).toBe("claude_3");
    await b.connectionRemove("claude");
    expect((await b.providerAdd("claude", "Usual")).id).toBe("claude_4");
  });

  it("finds the login on the next check once Terminal was opened on the sign-in, and not before", async () => {
    const b = new MockBackend();
    await b.providerAdd("claude", "Work", "~/.claude-work");
    await b.connectionsList();
    expect((await b.connectionsList(true)).find((c) => c.instanceId === "claude_2")!.status).toMatchObject({ state: "notSignedIn" });
    await b.connectionOpenTerminal("claude_2");
    expect((await b.connectionsList()).find((c) => c.instanceId === "claude_2")!.status).toMatchObject({ state: "notSignedIn" });
    const checked = (await b.connectionsList(true)).find((c) => c.instanceId === "claude_2")!;
    expect(checked.status).toMatchObject({ state: "ready", message: "Authenticated · alf@acme.com" });
  });

  it("says Authenticated with ChatGPT for a Codex once it is signed in", async () => {
    const b = new MockBackend();
    await b.providerAdd("codex", "Codex", "~/.codex-work");
    await b.connectionsList();
    await b.connectionOpenTerminal("codex");
    const row = (await b.connectionsList(true)).find((c) => c.instanceId === "codex")!;
    expect(row.status).toMatchObject({ state: "ready", message: "Authenticated · ChatGPT" });
  });

  it("names the shell key a Claude with its own folder ignores, and none for the usual setup", async () => {
    const b = new MockBackend();
    await b.providerAdd("claude", "Work", "~/.claude-work");
    const rows = await b.connectionsList();
    expect(rows.find((c) => c.instanceId === "claude_2")!.status?.ignored).toEqual(["ANTHROPIC_API_KEY"]);
    expect(rows.find((c) => c.instanceId === "claude")!.status?.ignored).toBeUndefined();
  });

  it("shows the folder of an instance that has one and refuses the usual setup", async () => {
    const b = new MockBackend();
    await b.providerAdd("claude", "Work", "~/.claude-work");
    await b.providerRevealFolder("claude_2");
    expect(b.revealedFolders).toEqual(["~/.claude-work"]);
    await expect(b.providerRevealFolder("claude")).rejects.toThrow("no folder of its own");
    await expect(b.providerRevealFolder("github")).rejects.toThrow("This isn't a provider");
  });
});
