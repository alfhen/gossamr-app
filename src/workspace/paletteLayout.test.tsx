/// <reference types="node" />
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PaletteView } from "./Palette";

const html = renderToStaticMarkup(<PaletteView query="" results={[]} active={0} onQuery={vi.fn()} onActive={vi.fn()} onRun={vi.fn()} onClose={vi.fn()} />);
const classOf = (marker: string) => html.match(new RegExp(`<div[^>]*${marker}[^>]*class="([^"]*)"|<div class="([^"]*)"[^>]*${marker}`))?.slice(1).find(Boolean)?.split(" ") ?? [];
const wrapper = html.match(/^<div class="([^"]*)"/)?.[1].split(" ") ?? [];
const card = classOf('role="dialog"');

describe("palette placement", () => {
  it("centres the card with flex, not a grid the workspace grid rule would collapse", () => {
    expect(wrapper).toEqual(expect.arrayContaining(["fixed", "inset-0", "flex", "items-start", "justify-center"]));
    expect(wrapper).not.toContain("grid");
  });

  it("sizes the card to min(560px, 92vw)", () => {
    expect(card).toContain("w-[min(560px,92vw)]");
  });

  it("keeps the pop keyframes from shifting the card horizontally", () => {
    const css = readFileSync("src/workspace/motion.css", "utf8");
    const keyframes = css.match(/@keyframes ws-pop\s*\{[\s\S]*?\}\s*\}/)?.[0] ?? "";
    expect(keyframes).toContain("translateY");
    expect(keyframes).not.toMatch(/translate(X|3d)?\(|translate:|left|margin|width/);
  });
});
