import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GITHUB_SAFETY } from "./githubSafety";
import { GENERAL_INTRO } from "./PipConversation";
import { ORIENTATION_SAFETY } from "./PipOrientation";

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("what the app says it does on GitHub (G5, G6)", () => {
  it("admits the review it posts and the branch a build pushes, and says it never merges", () => {
    expect(GITHUB_SAFETY).toContain("posts a review only when you approve a review draft");
    expect(GITHUB_SAFETY).toContain("never merges");
    expect(GITHUB_SAFETY).not.toContain("never comments");
  });

  it("is the one line Settings, WatchSettings and ConnectGithub use, with no claim of its own that nothing is commented", () => {
    for (const f of ["Settings.tsx", "WatchSettings.tsx", "ConnectGithub.tsx"]) {
      const text = source(f);
      expect(text).toContain("GITHUB_SAFETY");
      expect(text).not.toContain("never comments, merges or pushes");
    }
  });

  it("calls the build's branch rule a request, in the orientation and Pip's intro", () => {
    expect(ORIENTATION_SAFETY).toContain("a build is told to push only its own branch");
    expect(GENERAL_INTRO).toContain("a build is told to push only its own branch");
  });

  it("says What Jira saw lists only what Gossamr posted", () => {
    expect(source("JiraSentView.tsx")).toContain("It lists only what Gossamr posted. An agent run with your Claude settings could reach Jira on its own; see Agent safety.");
  });
});
