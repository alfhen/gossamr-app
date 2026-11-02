import { describe, expect, it, vi } from "vitest";
import { claudeSnapshot } from "../backend/mockProbes";
import { accountLine, accountOf, hasLogin, ignoredLine, revealProviderFolder, signInCommand, signOutCommand, suggestedFolder, usualSetupOffered } from "./providerLogic";

const CHECKED = "2026-10-30T11:57:00Z";

describe("the folder a name suggests", () => {
  it("drops the driver's own name and joins the rest with dashes", () => {
    expect(suggestedFolder("claude", "Claude work")).toBe("~/.claude-work");
    expect(suggestedFolder("codex", "Codex  Side Project!")).toBe("~/.codex-side-project");
    expect(suggestedFolder("claude", "Personal")).toBe("~/.claude-personal");
  });

  it("suggests nothing until the name has a letter or digit", () => {
    expect(suggestedFolder("claude", "")).toBe("");
    expect(suggestedFolder("claude", "Claude")).toBe("");
    expect(suggestedFolder("codex", " -- ")).toBe("");
  });

  it("keeps a long name to a short folder with no trailing dash", () => {
    const folder = suggestedFolder("claude", `${"a".repeat(39)} ${"b".repeat(10)}`);
    expect(folder).toBe(`~/.claude-${"a".repeat(39)}`);
  });

  it("keeps a name that only starts like the driver", () => {
    expect(suggestedFolder("claude", "Claudette")).toBe("~/.claude-claudette");
  });
});

describe("the usual setup", () => {
  const row = (driver: "claude" | "codex", configDir?: string) => ({ kind: "provider" as const, driver, configDir });

  it("is offered until an instance of that driver uses it", () => {
    expect(usualSetupOffered([], "claude")).toBe(true);
    expect(usualSetupOffered([row("claude")], "claude")).toBe(false);
    expect(usualSetupOffered([row("claude")], "codex")).toBe(true);
    expect(usualSetupOffered([row("claude", "~/.claude-work")], "claude")).toBe(true);
  });
});

describe("the lines a provider's detail shows", () => {
  it("names the login of a ready provider and nothing for one that is not", () => {
    expect(accountOf({ status: claudeSnapshot("ready", CHECKED) })).toBe("alf@acme.com");
    expect(accountOf({ status: claudeSnapshot("notSignedIn", CHECKED) })).toBeNull();
    expect(accountOf({ status: null })).toBeNull();
  });

  it("lists the ignored variables in a sentence, singular or plural, and says nothing without any", () => {
    const row = (ignored?: string[]) => ({ displayName: "Claude personal", status: { ...claudeSnapshot("ready", CHECKED), ignored } });
    expect(ignoredLine(row())).toBeNull();
    expect(ignoredLine(row([]))).toBeNull();
    expect(ignoredLine(row(["ANTHROPIC_API_KEY"]))).toBe("Your shell sets ANTHROPIC_API_KEY. Claude personal doesn't use it.");
    expect(ignoredLine(row(["A", "B", "C"]))).toBe("Your shell sets A, B and C. Claude personal doesn't use them.");
  });
});

describe("a provider's account line", () => {
  const row = (state: Parameters<typeof claudeSnapshot>[0], over: { enabled?: boolean; account?: string | null } = {}) => {
    const status = { ...claudeSnapshot(state, CHECKED), ...(over.account !== undefined ? { account: over.account } : {}) };
    return { enabled: over.enabled ?? true, status };
  };

  it("names the login only when the answer found one, and says not signed in only for a missing login", () => {
    expect(accountLine(row("ready"))).toBe("alf@acme.com");
    expect(accountLine(row("notSignedIn"))).toBe("Not signed in");
    expect(accountLine({ enabled: true, status: null })).toBe("Not checked yet");
  });

  it("keeps the login Rust last saw through a failed check and while the instance is off", () => {
    expect(accountLine(row("error", { account: "alf@acme.com" }))).toBe("alf@acme.com");
    expect(accountLine(row("off", { account: "alf@acme.com" }))).toBe("alf@acme.com");
    expect(accountLine({ enabled: false, status: claudeSnapshot("ready", CHECKED) })).toBe("alf@acme.com");
  });

  it("says nothing for an off, missing or unanswered instance that has no known login", () => {
    expect(accountLine(row("off"))).toBeNull();
    expect(accountLine(row("error"))).toBeNull();
    expect(accountLine(row("notFound"))).toBeNull();
  });

  it("offers the sign-out command only where a login is known", () => {
    expect(hasLogin(row("ready"))).toBe(true);
    expect(hasLogin(row("off", { account: "alf@acme.com" }))).toBe(true);
    expect(hasLogin(row("notSignedIn"))).toBe(false);
    expect(hasLogin(row("off"))).toBe(false);
    expect(hasLogin({ enabled: true, status: null })).toBe(false);
  });
});

describe("the commands a person runs for a login", () => {
  it("puts the folder variable in front, quoted as the probe shows it", () => {
    expect(signInCommand("claude")).toBe("claude auth login");
    expect(signOutCommand("claude")).toBe("claude auth logout");
    expect(signOutCommand("claude", "~/.claude-work")).toBe("CLAUDE_CONFIG_DIR=~/.claude-work claude auth logout");
    expect(signOutCommand("codex", "~/.codex-side")).toBe("CODEX_HOME=~/.codex-side codex logout");
    expect(signOutCommand("claude", "~/My Claude")).toBe("CLAUDE_CONFIG_DIR=~/'My Claude' claude auth logout");
    expect(signOutCommand("codex", "/Users/x/Code Work")).toBe("CODEX_HOME='/Users/x/Code Work' codex logout");
  });
});

describe("Reveal in Finder", () => {
  it("asks the backend for the instance's folder", async () => {
    const providerRevealFolder = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    await revealProviderFolder({ providerRevealFolder }, "claude_2", report);
    expect(providerRevealFolder).toHaveBeenCalledWith("claude_2");
    expect(report).not.toHaveBeenCalled();
  });

  it("reports a refusal instead of throwing", async () => {
    const failure = new Error("no folder");
    const report = vi.fn();
    await revealProviderFolder({ providerRevealFolder: vi.fn().mockRejectedValue(failure) }, "claude", report);
    expect(report).toHaveBeenCalledWith("Couldn't show the folder", failure);
  });
});
