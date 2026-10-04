import { describe, expect, it } from "vitest";
import { changedLines, diffLines, MAX_DIFF_CELLS, withGaps } from "./textDiff";

const kinds = (from: string, to: string) => diffLines(from, to).map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`);

describe("diffLines", () => {
  it("marks removed and added lines and keeps the rest", () => {
    expect(kinds("a\nb\nc", "a\nB\nc")).toEqual([" a", "-b", "+B", " c"]);
    expect(kinds("a\nb", "a\nb\nc")).toEqual([" a", " b", "+c"]);
    expect(kinds("a\nb\nc", "b")).toEqual(["-a", " b", "-c"]);
  });

  it("has no changes for equal text and handles empty sides", () => {
    expect(changedLines(diffLines("same\n\ntext", "same\n\ntext"))).toBe(0);
    expect(kinds("", "new")).toEqual(["+new"]);
    expect(kinds("old", "")).toEqual(["-old"]);
    expect(diffLines("", "")).toEqual([]);
  });

  it("finds a moved paragraph as one removal and one addition around what stayed", () => {
    expect(kinds("one\n\ntwo\n\nthree", "two\n\nthree\n\none")).toEqual(["-one", "-", " two", " ", " three", "+", "+one"]);
  });

  it("copes with a long description", () => {
    const from = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join("\n");
    const to = from.replace("line 700", "line seven hundred");
    expect(changedLines(diffLines(from, to))).toBe(2);
  });
});

describe("a diff too large for the matching table", () => {
  const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} ${i}`);

  it("returns quickly with every unmatched line removed or added, keeping what both ends share", () => {
    const from = ["head", ...many("old", 15_000), "tail"].join("\n");
    const to = ["head", ...many("new", 15_000), "tail"].join("\n");
    expect(15_001 * 15_001).toBeGreaterThan(MAX_DIFF_CELLS);
    const started = performance.now();
    const lines = diffLines(from, to);
    expect(performance.now() - started).toBeLessThan(500);
    expect(lines).toHaveLength(2 + 15_000 * 2);
    expect(lines[0]).toEqual({ kind: "same", text: "head" });
    expect(lines[lines.length - 1]).toEqual({ kind: "same", text: "tail" });
    expect(lines.slice(1, 15_001).every((l) => l.kind === "del")).toBe(true);
    expect(lines.slice(15_001, -1).every((l) => l.kind === "add")).toBe(true);
    expect(lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(many("old", 15_000));
  });

  it("still matches lines when the table fits, just under the limit", () => {
    const side = Math.floor(Math.sqrt(MAX_DIFF_CELLS)) - 5;
    const from = ["old head", ...many("line", side), "old tail"].join("\n");
    const to = ["new head", ...many("line", side), "new tail"].join("\n");
    expect((side + 3) ** 2).toBeLessThanOrEqual(MAX_DIFF_CELLS);
    expect(changedLines(diffLines(from, to))).toBe(4);
  });

  it("is only reached by text that differs: equal text and a shared prefix or suffix cost nothing", () => {
    const text = many("same", 20_000).join("\n");
    expect(changedLines(diffLines(text, text))).toBe(0);
    expect(changedLines(diffLines(text, `${text}\nextra`))).toBe(1);
  });
});

describe("withGaps", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "same" as const, text: `s${i}` }));

  it("folds a long unchanged stretch and keeps two lines beside each change", () => {
    const rows = withGaps([...lines(10), { kind: "add", text: "new" }, ...lines(10)]);
    expect(rows.map((r) => (r.kind === "gap" ? `gap ${r.count}` : r.text))).toEqual(["gap 8", "s8", "s9", "new", "s0", "s1", "gap 8"]);
  });

  it("does not fold a stretch of one or two lines", () => {
    const rows = withGaps([{ kind: "del", text: "x" }, ...lines(5), { kind: "add", text: "y" }]);
    expect(rows.map((r) => (r.kind === "gap" ? "gap" : r.text))).toEqual(["x", "s0", "s1", "s2", "s3", "s4", "y"]);
  });
});
