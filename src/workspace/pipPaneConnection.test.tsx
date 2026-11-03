import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claude } from "../backend/claude";
import { forgetConversations } from "../claudeStore";
import { PipPane } from "./PipPane";
import { usePip } from "./pipStore";

// Static rendering skips effects, and the pane loads its conversation in one.
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useEffect: (fn: () => void) => void fn() }));

describe("PipPane", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal("document", { getElementById: () => null });
    forgetConversations();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    usePip.setState({ pinned: null });
    usePip.getInitialState().pinned = null;
  });

  it("reads General back under the open second-site ticket's connection", () => {
    const turns = vi.spyOn(claude, "turns").mockResolvedValue([]);
    const beta = { connectionId: "beta", externalId: "CA-1", key: "CA-1" };
    const pinned = { view: "Ticket CA-1", item: beta, filter: null, selection: [] };
    usePip.setState({ pinned });
    usePip.getInitialState().pinned = pinned;
    renderToStaticMarkup(<PipPane onClose={() => {}} />);
    expect(turns).toHaveBeenCalledWith("beta:general");
  });
});
