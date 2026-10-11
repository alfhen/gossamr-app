import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeedsYouTray, needsYouText, openNeedsYou } from "./NeedsYouTray";
import type { NeedsYouItem } from "./pipHomeLogic";
import { usePipHome } from "./pipHomeStore";
import { useRuns } from "./runsStore";
import { loadTabs, useTabs } from "./tabsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

const NOW = new Date("2026-09-30T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const items: NeedsYouItem[] = [
  { key: "draft:d1", kind: "draft", workstreamId: "ws-1", label: "CA-401 · Draft comment", at: ago(12), target: { type: "draft", id: "d1" } },
  { key: "run:r2", kind: "question", workstreamId: "ws-1", label: "R2 asks a question", at: ago(5), target: { type: "run", id: "r2" } },
  { key: "held:ws-2", kind: "held", workstreamId: "ws-2", label: "Held: budget", at: ago(2), target: { type: "workstream" } },
  { key: "draft:d9", kind: "draft", workstreamId: null, label: "CA-500 · Draft move", at: ago(1), target: { type: "draft", id: "d9" } },
];

beforeEach(() => {
  vi.stubGlobal("localStorage", memory());
  useTabs.setState(loadTabs());
});

afterEach(() => {
  usePipHome.getState().reset();
  useRuns.setState({ sheet: null, selectedId: null });
  useTabs.getState().setRoute("workspace");
  vi.unstubAllGlobals();
});

describe("the Needs you tray", () => {
  it("shows the count and each item in the order given, with how long it has waited", () => {
    const html = renderToStaticMarkup(<NeedsYouTray items={items} now={NOW} />);
    expect(html).toContain('<section aria-label="Needs you"');
    expect(html).toMatch(/data-needs-you-count[^>]*>4</);
    const lines = [...html.matchAll(/data-needs-you-item="[^"]+"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(lines).toEqual(["CA-401 · Draft comment · 12m", "R2 asks a question · 5m", "Held: budget", "CA-500 · Draft move · 1m"]);
  });

  it("says so when nothing waits", () => {
    const html = renderToStaticMarkup(<NeedsYouTray items={[]} now={NOW} />);
    expect(html).toMatch(/data-needs-you-count[^>]*>0</);
    expect(html).toContain("Nothing needs you.");
  });

  it("ages a hold not at all: the hold says what it is", () => {
    expect(needsYouText(items[2], NOW)).toBe("Held: budget");
  });
});

describe("activating an item", () => {
  it("on Pip home selects its workstream and asks for its card, staying on the route", () => {
    useTabs.getState().setRoute("pip");
    openNeedsYou(items[0]);
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState().selected).toBe("ws-1");
    expect(usePipHome.getState().focusTarget).toEqual({ type: "draft", id: "d1" });
    expect(useRuns.getState().sheet).toBeNull();
  });

  it("from another route goes to Pip home first", () => {
    useTabs.getState().setRoute("workspace");
    openNeedsYou(items[2]);
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState().selected).toBe("ws-2");
    expect(usePipHome.getState().focusTarget).toEqual({ type: "workstream" });
  });

  it("opens a run's sheet over Pip home, where its question is answered", () => {
    useTabs.getState().setRoute("agents");
    openNeedsYou(items[1]);
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState().focusTarget).toEqual({ type: "run", id: "r2" });
    expect(useRuns.getState().sheet).toEqual({ type: "run", id: "r2" });
  });

  it("goes to General for an item in no workstream", () => {
    usePipHome.getState().openWorkstream("ws-1");
    openNeedsYou(items[3]);
    expect(usePipHome.getState().selected).toBeNull();
    expect(usePipHome.getState().focusTarget).toEqual({ type: "draft", id: "d9" });
  });
});
