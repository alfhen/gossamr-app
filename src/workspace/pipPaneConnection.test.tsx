import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claude } from "../backend/claude";
import { forgetConversations } from "../claudeStore";
import type { ConnectionInfo } from "../types";
import { useWorkspace } from "../workspaceStore";
import { PipPane } from "./PipPane";
import { usePip } from "./pipStore";

// Static rendering skips effects, and the pane loads its conversation in one.
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useEffect: (fn: () => void) => void fn() }));

const jira = (id: string) => ({ id, kind: "jira", enabled: true }) as ConnectionInfo;

describe("PipPane", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal("document", { getElementById: () => null });
    forgetConversations();
    // A static render reads the initial state.
    useWorkspace.getInitialState().connections = [jira("alpha"), jira("beta")];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    usePip.setState({ pinned: null, drawerConnection: null });
    usePip.getInitialState().pinned = null;
    usePip.getInitialState().drawerConnection = null;
    useWorkspace.getInitialState().connections = [];
  });

  const openOn = (connectionId: string) => {
    const turns = vi.spyOn(claude, "turns").mockResolvedValue([]);
    const pinned = { view: "Ticket CA-1", item: { connectionId, externalId: "CA-1", key: "CA-1" }, filter: null, selection: [] };
    usePip.setState({ pinned });
    usePip.getInitialState().pinned = pinned;
    renderToStaticMarkup(<PipPane onClose={() => {}} />);
    return turns;
  };

  it("reads General under the open second-site ticket's connection, and only that", () => {
    const turns = openOn("beta");
    expect(turns.mock.calls.map(([key]) => key)).toEqual(["beta:general"]);
  });

  it("reads the primary's General under the bare name", () => {
    const turns = openOn("alpha");
    expect(turns.mock.calls.map(([key]) => key)).toEqual(["general"]);
  });

  const openNoTicket = (picked: string | null) => {
    const turns = vi.spyOn(claude, "turns").mockResolvedValue([]);
    usePip.setState({ drawerConnection: picked, pinned: null });
    usePip.getInitialState().drawerConnection = picked;
    renderToStaticMarkup(<PipPane onClose={() => {}} />);
    return turns;
  };

  it("reads General under the connection picked in the drawer when no ticket is open, and under no other key", () => {
    const turns = openNoTicket("beta");
    expect(turns.mock.calls.map(([key]) => key)).toEqual(["beta:general"]);
  });

  it("reads General under the bare name when the drawer picked the primary", () => {
    const turns = openNoTicket("alpha");
    expect(turns.mock.calls.map(([key]) => key)).toEqual(["general"]);
  });

  it("shows the drawer's connection control only with no ticket open", () => {
    openNoTicket(null);
    expect(renderToStaticMarkup(<PipPane onClose={() => {}} />)).toContain('aria-label="Pip works in"');
    openOn("beta");
    expect(renderToStaticMarkup(<PipPane onClose={() => {}} />)).not.toContain('aria-label="Pip works in"');
  });
});
