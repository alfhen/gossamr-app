import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const ALLOWED = ["src/workspace/PipImages.tsx:View image larger", "src/workspace/Rail.tsx:onManage", "src/workspace/DevelopmentSection.tsx:onToggle"];

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });

it("no raw button carries its own border or fill unless it is a listed exception", () => {
  const found = sources("src").flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => /<button\b[^>]*className="[^"]*(?<![:\w-])(border|bg-ws-|bg-black)/.test(line))
      .filter((line) => !ALLOWED.some((a) => a.startsWith(file + ":") && line.includes(a.slice(file.length + 1))))
      .map((line) => `${file}: ${line.trim().slice(0, 100)}`),
  );
  expect(found).toEqual([]);
});
