import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { useWorkspace } from "../workspaceStore";
import { PipHome } from "./PipHome";
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
    expect(nav).toMatch(/^<nav[^>]*max-h-\[45%\]/);
    // The main list takes the column's height.
    expect(left).toMatch(/<section aria-label="Needs you"[^>]*flex-1/);
  });

  it("keeps the handles the keyboard and the tests find the regions by", () => {
    const out = html();
    for (const attr of ['data-pip-home-column="list"', 'data-pip-home-column="conversation"', 'data-pip-home-column="rail"', "data-needs-you-title", "data-needs-you-count", 'role="listbox"']) expect(out).toContain(attr);
  });
});
