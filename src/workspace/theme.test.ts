import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function blockAfter(selector: string): string {
  const start = css.indexOf(selector);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`no block for ${selector}`);
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("the theme tokens", () => {
  const light = tokens(blockAfter("@theme"));
  const auto = tokens(blockAfter(':root:not([data-theme="light"])'));
  const forced = tokens(blockAfter(':root[data-theme="dark"]'));

  it("gives the system dark block and the chosen dark block the same values", () => {
    expect(forced).toEqual(auto);
  });

  it("passes AA for body, secondary, indigo, Pip, Done, blocked and review text on the window in both themes", () => {
    for (const [theme, set] of [["light", light], ["dark", { ...light, ...auto }]] as const) {
      for (const name of ["ink", "ink2", "accent", "pip", "done", "blocked", "review"]) {
        const ratio = contrast(set[`--color-ws-${name}`], set["--color-ws-win"]);
        expect(ratio, `${name} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the label on a Pip fill readable in both themes", () => {
    for (const [theme, set] of [["light", light], ["dark", { ...light, ...auto }]] as const) {
      const ratio = contrast(set["--color-ws-on-pip"], set["--color-ws-pip"]);
      expect(ratio, `on-pip in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps white labels readable on the prominent indigo, which no dark block overrides", () => {
    const root = tokens(blockAfter(":root {"));
    expect(auto["--prominent"]).toBeUndefined();
    expect(contrast("#ffffff", root["--prominent"])).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the label on a danger fill readable in both themes", () => {
    for (const [theme, set] of [["light", light], ["dark", { ...light, ...auto }]] as const) {
      const ratio = contrast(set["--color-ws-on-blocked"], set["--color-ws-blocked"]);
      expect(ratio, `on-blocked in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("makes a card differ from its lane and a lane from the window in both themes", () => {
    for (const set of [light, { ...light, ...auto }]) {
      expect(set["--color-ws-card"]).not.toBe(set["--color-ws-side"]);
      expect(set["--color-ws-side"]).not.toBe(set["--color-ws-win"]);
      expect(luminance(set["--color-ws-card"])).toBeGreaterThan(luminance(set["--color-ws-side"]));
    }
  });

  it("tints stale cards over the card colour, with a darker tint in dark", () => {
    const board = readFileSync(new URL("./board.css", import.meta.url), "utf8");
    expect(board).toMatch(/\.ws-wither \{\s*background-color: color-mix\(in srgb, var\(--color-ws-card\), var\(--wither-tint\) var\(--wmix\)\)/);
    expect(board).toMatch(/--wither-tint: #c9a66b/);
    expect(board).toMatch(/--wither-tint: #8a7248/);
  });
});
