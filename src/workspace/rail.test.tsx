import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { useWorkspace } from "../workspaceStore";
import { HOLD_ALL_HINT } from "./commands";
import { AGENTS_TRAY_NOTE, Rail, RailTip } from "./Rail";

describe("the icon rail's names", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    await useWorkspace.getState().init(new MockBackend());
    Object.assign(useWorkspace.getInitialState(), useWorkspace.getState());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives every button, the Agents one included, its own accessible name", () => {
    const out = renderToStaticMarkup(<Rail />);
    const labels = (out.match(/<button[^>]*>/g) ?? []).map((b) => /aria-label="([^"]+)"/.exec(b)?.[1]);
    expect(labels.length).toBeGreaterThan(6);
    for (const l of labels) expect(l).toBeTruthy();
    expect(new Set(labels).size).toBe(labels.length);
    for (const name of ["Search and jump", "All projects", "Views", "Activity", "Agents", "Settings", "Pip"]) expect(labels).toContain(name);
    expect(labels).not.toContain("Pip home");
  });

  it("shows the name with its shortcut, where it has one, in the tooltip", () => {
    const at = { x: 60, y: 20 };
    expect(renderToStaticMarkup(<RailTip label="Search and jump" hint="⌘K" at={at} />)).toMatch(/role="tooltip"[^>]*>Search and jump<kbd[^>]*>⌘K<\/kbd>/);
    expect(renderToStaticMarkup(<RailTip label="Agents" note={AGENTS_TRAY_NOTE} at={at} />)).toContain(AGENTS_TRAY_NOTE);
    expect(renderToStaticMarkup(<RailTip label="Hold all workstreams" hint={HOLD_ALL_HINT} at={at} />)).toContain(HOLD_ALL_HINT);
    // A screen with no shortcut shows its name alone.
    expect(renderToStaticMarkup(<RailTip label="Settings" at={at} />)).not.toContain("<kbd");
  });

  it("hides a tooltip while the pointer is on another rail button, so the hovered one wins", () => {
    // The rail's tips hide by CSS (a markup test can't hover), so check the selectors that do it are in place.
    expect(renderToStaticMarkup(<Rail />)).toMatch(/<aside[^>]*class="[^"]*group\/rail/);
    const tip = renderToStaticMarkup(<RailTip label="Settings" at={{ x: 60, y: 20 }} />);
    expect(tip).toContain("not-group-has-[button:hover]/btn:group-has-[button:hover]/rail:hidden");
  });
});
