import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROMISES } from "./Settings";

const root = new URL("..", import.meta.url).pathname;

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "backend" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });

describe("the two facts the app states", () => {
  it("are said in Settings, and in no other screen", () => {
    expect(PROMISES).toEqual(["Gossamr posts nothing to Jira or GitHub until you approve it.", "Agents run with your own Claude Code settings, so they can push branches and use your own tools."]);
    const restating = sources(root)
      .filter((path) => !path.endsWith("workspace/Settings.tsx"))
      .filter((path) => /Claude Code settings|until you approve|until you choose/i.test(readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
    expect(restating.map((p) => p.slice(root.length))).toEqual([]);
  });
});
