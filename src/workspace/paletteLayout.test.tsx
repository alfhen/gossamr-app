/// <reference types="node" />
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PaletteView, restoreFocus } from "./Palette";

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

describe("palette focus (G8)", () => {
  it("gives focus back to the opener, or the main area, but not when it already moved onto the page", () => {
    const focus = vi.fn();
    const main = { focus: vi.fn() };
    const body = {};
    const doc = (active: unknown) => ({ activeElement: active, body, getElementById: () => main }) as never;
    restoreFocus({ isConnected: true, focus } as never, doc(body));
    expect(focus).toHaveBeenCalledTimes(1);
    restoreFocus({ isConnected: false, focus } as never, doc(body));
    expect(main.focus).toHaveBeenCalledTimes(1);
    restoreFocus({ isConnected: true, focus } as never, doc({ isConnected: true }));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(main.focus).toHaveBeenCalledTimes(1);
  });
});

describe("palette start a workstream (G10)", () => {
  it("says it started one, and leaves a failure to the store's own toast", async () => {
    const { appActions } = await import("./Palette");
    const { useToasts } = await import("./toasts");
    const { useWorkstreams } = await import("./workstreamsStore");
    const item = { item: { key: "CA-401" } } as never;
    const start = vi.spyOn(useWorkstreams.getState(), "start");
    useToasts.setState({ toasts: [] });
    start.mockResolvedValueOnce({} as never);
    appActions().startWorkstreamOn(item);
    await Promise.resolve();
    await Promise.resolve();
    expect(useToasts.getState().toasts.map((t) => [t.text, t.tone])).toEqual([["Started a workstream on CA-401.", "info"]]);
    useToasts.setState({ toasts: [] });
    start.mockResolvedValueOnce(null);
    appActions().startWorkstreamOn(item);
    await Promise.resolve();
    await Promise.resolve();
    expect(useToasts.getState().toasts).toEqual([]);
    start.mockRestore();
  });
});
