import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENTS_ON_GITHUB, FACTS } from "./githubSafety";
import { GENERAL_INTRO } from "./PipConversation";

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("what the app says about safety", () => {
  it("states two facts, that nothing is posted without approval and that agents run with the person's settings", () => {
    expect(FACTS[0]).toContain("posts nothing to Jira or GitHub until you approve it");
    expect(FACTS[0]).toContain("never merges");
    expect(FACTS[1]).toContain("your own Claude Code settings");
  });

  it("states them in Settings only, and the connection screens say nothing of their own", () => {
    expect(source("Settings.tsx")).toContain("FACTS");
    for (const f of ["WatchSettings.tsx", "ConnectGithub.tsx"]) expect(source(f)).not.toMatch(/GITHUB_SAFETY|FACTS/);
  });

  it("says agents run with the person's settings, in Pip's intro", () => {
    expect(GENERAL_INTRO).toContain(AGENTS_ON_GITHUB);
    expect(GENERAL_INTRO).not.toContain("is told to push");
    expect(AGENTS_ON_GITHUB).toContain("your own Claude Code settings");
    expect(AGENTS_ON_GITHUB).not.toContain("Build");
  });

});
