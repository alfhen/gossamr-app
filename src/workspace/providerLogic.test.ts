import { describe, expect, it } from "vitest";
import { claudeSnapshot } from "../backend/mockProbes";
import { accountOf, ignoredLine, suggestedFolder, usualSetupOffered } from "./providerLogic";

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
