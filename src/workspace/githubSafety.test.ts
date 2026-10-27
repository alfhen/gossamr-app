import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENTS_ON_GITHUB, GITHUB_SAFETY } from "./githubSafety";
import { GENERAL_INTRO } from "./PipConversation";

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("what the app says it does on GitHub (G5, G6)", () => {
  it("admits the review it posts, and says it never merges and that agents run with the person's settings", () => {
    expect(GITHUB_SAFETY).toContain("posts a review only when you approve a review draft");
    expect(GITHUB_SAFETY).toContain("never merges");
    expect(GITHUB_SAFETY).not.toContain("never comments");
    expect(GITHUB_SAFETY).toContain("Agents run with your own Claude Code settings");
  });

  it("is the one line Settings, WatchSettings and ConnectGithub use, with no claim of its own that nothing is commented", () => {
    for (const f of ["Settings.tsx", "WatchSettings.tsx", "ConnectGithub.tsx"]) {
      const text = source(f);
      expect(text).toContain("GITHUB_SAFETY");
      expect(text).not.toContain("never comments, merges or pushes");
    }
  });

  it("says agents run with the person's settings, in Pip's intro", () => {
    expect(GENERAL_INTRO).toContain(AGENTS_ON_GITHUB);
    expect(GENERAL_INTRO).not.toContain("is told to push");
    expect(AGENTS_ON_GITHUB).toContain("your own Claude Code settings");
    expect(AGENTS_ON_GITHUB).not.toContain("Build");
  });

  it("says What Jira saw lists only what Gossamr posted", () => {
    expect(source("JiraSentView.tsx")).toContain("It lists only what Gossamr posted. A Build runs with your Claude settings and could reach Jira on its own; see Agent safety.");
  });
});
