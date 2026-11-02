import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";

const home = "/Users/sample";

describe("adding a provider instance in the mock", () => {
  it("lists it after the default with its folder as typed, signed out, and names the next id", async () => {
    const b = new MockBackend();
    const row = await b.providerAdd("claude", " Claude personal ", "~/.claude-personal");
    expect(row).toMatchObject({ id: "claude_2", instanceId: "claude_2", kind: "provider", driver: "claude", displayName: "Claude personal", enabled: true, configDir: "~/.claude-personal" });
    expect(row.status).toMatchObject({ state: "notSignedIn", fix: "CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login" });
    expect((await b.connectionsList()).filter((c) => c.kind === "provider").map((c) => c.instanceId)).toEqual(["claude", "claude_2"]);
  });

  it("opens Terminal on the sign-in with the folder, and the default's has none", async () => {
    const b = new MockBackend({ claudeProbe: "notSignedIn" });
    await b.providerAdd("claude", "Work", "~/My Claude");
    await b.connectionOpenTerminal("claude_2");
    await b.connectionOpenTerminal("claude");
    expect(b.terminals).toEqual(["CLAUDE_CONFIG_DIR='~/My Claude' claude auth login", "claude auth login"]);
  });

  it("adds a Codex instance whose models are Codex's and whose sign-in is codex login", async () => {
    const b = new MockBackend();
    const row = await b.providerAdd("codex", "Codex", "~/.codex-work");
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
});
