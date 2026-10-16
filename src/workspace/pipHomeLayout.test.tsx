import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { useWorkspace } from "../workspaceStore";
import { DayScroll, PipHome, fadeScroll, hasMoreBelow } from "./PipHome";
import { loadPrefs, usePrefs } from "./prefs";
import { loadTabs, useTabs } from "./tabsStore";
import { useWorkstreams } from "./workstreamsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  useTabs.setState(loadTabs());
  usePrefs.setState(loadPrefs());
  await useWorkspace.getState().init(new MockBackend({ runs: { seed: "empty" } }));
});

afterEach(() => {
  useWorkstreams.getState().dispose();
  vi.unstubAllGlobals();
});

describe("Pip home's layout", () => {
  const html = () => renderToStaticMarkup(<PipHome />);

  it("names itself with the screen's one h1, ahead of everything else", () => {
    const out = html();
    expect(out.match(/<h1\b/g)).toHaveLength(1);
    expect(out).toMatch(/<h1 class="[^"]*">Pip home<\/h1>/);
    expect(out.indexOf("<h1")).toBeLessThan(out.indexOf('data-pip-home-column="list"'));
  });

  it("makes Needs you the main left column, with the workstreams in a compact section under it", () => {
    const out = html();
    const left = out.slice(out.indexOf("data-pip-home-left"), out.indexOf('data-pip-home-column="conversation"'));
    expect(left.indexOf('aria-label="Needs you"')).toBeGreaterThan(-1);
    expect(left.indexOf('aria-label="Needs you"')).toBeLessThan(left.indexOf('aria-label="Workstreams"'));
    // Needs you is a section of its own, no longer inside the workstreams' navigation.
    const nav = left.slice(left.indexOf('<nav aria-label="Workstreams"'));
    expect(nav).not.toContain('aria-label="Needs you"');
    expect(nav).toMatch(/^<nav[^>]*min-h-0 flex-1/);
    // The main list sizes to its content up to half the column; the workstreams take the rest.
    expect(left).toMatch(/<section aria-label="Needs you"[^>]*max-h-1\/2 shrink/);
  });

  it("shows a 'more below' cue only when a scroller is cut off by more than a few pixels", () => {
    expect(hasMoreBelow({ scrollHeight: 444, scrollTop: 0, clientHeight: 301 })).toBe(true);
    expect(hasMoreBelow({ scrollHeight: 444, scrollTop: 143, clientHeight: 301 })).toBe(false);
    expect(hasMoreBelow({ scrollHeight: 303, scrollTop: 0, clientHeight: 301 })).toBe(false);
  });

  it("keeps the handles the keyboard and the tests find the regions by", () => {
    const out = html();
    for (const attr of ['data-pip-home-column="list"', 'data-pip-home-column="conversation"', 'data-pip-home-column="rail"', "data-needs-you-title", "data-needs-you-count", 'role="listbox"']) expect(out).toContain(attr);
  });
});

describe("the day card's fade", () => {
  it("scrolls most of a page, and jumps instead of gliding when the person asked for less motion", () => {
    expect(fadeScroll(200, false)).toEqual({ top: 160, behavior: "smooth" });
    expect(fadeScroll(200, true)).toEqual({ top: 160, behavior: "auto" });
  });
});

describe("the day region's room", () => {
  it("gives Plan my week nearly half the window, so its three picks show, and Start my day a third", () => {
    expect(renderToStaticMarkup(<DayScroll label="Plan my week" tall>x</DayScroll>)).toContain("max-h-[min(45vh,26rem)]");
    const start = renderToStaticMarkup(<DayScroll label="Start my day">x</DayScroll>);
    expect(start).toContain("max-h-[30vh]");
    expect(start).not.toContain("45vh");
  });
  it("gives Start my day most of the window when the conversation below has nothing in it", () => {
    const roomy = renderToStaticMarkup(<DayScroll label="Start my day" roomy>x</DayScroll>);
    expect(roomy).toContain("max-h-[min(60vh,34rem)]");
    expect(roomy).not.toContain("max-h-[30vh]");
    // Plan my week keeps its own cap.
    expect(renderToStaticMarkup(<DayScroll label="Plan my week" tall roomy>x</DayScroll>)).toContain("45vh");
  });
});
