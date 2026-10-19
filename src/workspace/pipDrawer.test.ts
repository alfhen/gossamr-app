import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claude } from "../backend/claude";
import { askPip } from "./askPip";
import { loadPrefs, usePrefs } from "./prefs";
import { usePip } from "./pipStore";
import { loadTabs, useTabs } from "./tabsStore";
import { focusPip, togglePip } from "./workstreamsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

const open = () => usePrefs.getState().pipOpen;

beforeEach(() => {
  vi.stubGlobal("localStorage", memory());
  useTabs.setState(loadTabs());
  usePrefs.getState().setPipOpen(false);
  usePip.setState({ quote: null, prefill: null });
});

afterEach(() => {
  useTabs.getState().setRoute("workspace");
  vi.unstubAllGlobals();
});

describe("the Pip drawer's open state", () => {
  it("toggles with ⌘J from every screen, Pip home included", () => {
    for (const route of ["workspace", "activity", "agents", "settings", "pip"] as const) {
      useTabs.getState().setRoute(route);
      togglePip();
      expect(open()).toBe(true);
      togglePip();
      expect(open()).toBe(false);
    }
  });

  it("is not remembered across sessions", () => {
    usePrefs.getState().setPipOpen(true);
    usePrefs.getState().setTheme("dark");
    expect(JSON.parse(localStorage.getItem("gossamr-prefs") ?? "{}")).not.toHaveProperty("pipOpen");
    expect(loadPrefs().pipOpen).toBe(false);
  });
});

describe("everything that links to Pip opens the drawer", () => {
  it.each(["workspace", "pip"] as const)("a question asked of Pip, on %s", async (route) => {
    useTabs.getState().setRoute(route);
    const ask = vi.spyOn(claude, "ask").mockResolvedValue({ queued: false, ahead: 0 });
    try {
      askPip("Catch me up");
      await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    } finally {
      ask.mockRestore();
    }
    expect(open()).toBe(true);
    expect(useTabs.getState().route).toBe(route);
  });

  it.each(["workspace", "pip"] as const)("a prompt put in its composer, on %s", (route) => {
    useTabs.getState().setRoute(route);
    usePip.getState().openWith("Draft a reply");
    expect(open()).toBe(true);
    expect(usePip.getState().prefill?.text).toBe("Draft a reply");
  });

  it.each(["workspace", "pip"] as const)("a quoted selection, on %s", (route) => {
    useTabs.getState().setRoute(route);
    usePip.getState().askAbout("some words");
    expect(open()).toBe(true);
    expect(usePip.getState().quote).toBe("some words");
  });

  it("the peek's Open in Pip, on Pip home too", () => {
    useTabs.getState().setRoute("pip");
    focusPip();
    expect(open()).toBe(true);
    useTabs.getState().setRoute("workspace");
    usePrefs.getState().setPipOpen(false);
    focusPip();
    expect(open()).toBe(true);
  });
});
