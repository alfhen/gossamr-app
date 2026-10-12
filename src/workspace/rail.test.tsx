import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { useWorkspace } from "../workspaceStore";
import { useAgentsFlag } from "./agentsFlag";
import { HOLD_ALL_HINT, PIP_HOME_HINT } from "./commands";
import { PIP_HOME_TRAY_NOTE, Rail, RailTip } from "./Rail";

describe("the icon rail's names", () => {
  let enabled: boolean;
  beforeEach(async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    await useWorkspace.getState().init(new MockBackend());
    Object.assign(useWorkspace.getInitialState(), useWorkspace.getState());
    enabled = useAgentsFlag.getInitialState().enabled;
    Object.assign(useAgentsFlag.getInitialState(), { enabled: true });
  });
  afterEach(() => {
    Object.assign(useAgentsFlag.getInitialState(), { enabled });
    vi.unstubAllGlobals();
  });

  it("gives every button, the Agents and Pip home ones included, its own accessible name", () => {
    const out = renderToStaticMarkup(<Rail />);
    const labels = (out.match(/<button[^>]*>/g) ?? []).map((b) => /aria-label="([^"]+)"/.exec(b)?.[1]);
    expect(labels.length).toBeGreaterThan(6);
    for (const l of labels) expect(l).toBeTruthy();
    expect(new Set(labels).size).toBe(labels.length);
    for (const name of ["Search and jump", "All projects", "Views", "Activity", "Agents", "Pip home", "Settings", "Pip"]) expect(labels).toContain(name);
  });

  it("shows the name with its shortcut, where it has one, in the tooltip", () => {
    const at = { x: 60, y: 20 };
    expect(renderToStaticMarkup(<RailTip label="Search and jump" hint="⌘K" at={at} />)).toMatch(/role="tooltip"[^>]*>Search and jump<kbd[^>]*>⌘K<\/kbd>/);
    expect(renderToStaticMarkup(<RailTip label="Pip home" hint={PIP_HOME_HINT} note={PIP_HOME_TRAY_NOTE} at={at} />)).toContain(`<kbd class="ml-1.5">${PIP_HOME_HINT}</kbd>`);
    expect(renderToStaticMarkup(<RailTip label="Hold all workstreams" hint={HOLD_ALL_HINT} at={at} />)).toContain(HOLD_ALL_HINT);
    // A screen with no shortcut shows its name alone.
    expect(renderToStaticMarkup(<RailTip label="Settings" at={at} />)).not.toContain("<kbd");
  });
});
