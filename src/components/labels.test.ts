import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });

const linesMatching = (pattern: RegExp) =>
  sources("src").flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => pattern.test(line))
      .map((line) => `${file}: ${line.trim().slice(0, 100)}`),
  );

it("no label is all-caps or letter-spaced", () => {
  expect(linesMatching(/(?<![:\w-])(uppercase|normal-case|tracking-(wide|wider|widest|normal|\[0\.05em\]))(?![\w-])/)).toEqual([]);
});

it("every h1 and h2 title larger than a label is set in the display face", () => {
  expect(linesMatching(/<h[12]\b[^>]*className="[^"]*"/).filter((line) => !/text-(xs|sm)\b/.test(line) && !line.includes("font-display"))).toEqual([]);
});
