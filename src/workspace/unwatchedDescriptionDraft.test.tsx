import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { bodyChange } from "../backend/mockMarkdown";
import { draftsForItem, useWorkspace } from "../workspaceStore";
import { runDescriptionDraftOf } from "./runSheetLogic";

const KEY = "WEB-101";

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));

describe("a run's description update on a ticket that isn't watched", () => {
  // The live peek of an unwatched ticket is read-only; it lists exactly what `draftsForItem` returns, and no longer hides it.
  it("is among the drafts the peek lists for that ticket, and the card's chip finds it by its run", async () => {
    const backend = new MockBackend();
    await useWorkspace.getState().init(backend);
    const ref = itemRef(KEY);
    const now = backend.connector.item(ref)!;
    const made = backend.proposals.fromRun({ type: "rewrite", item: ref, title: null, body: bodyChange(now.body, "Hello\n\n## Gossamr Plan\n\nThe plan."), flattened: [] }, "From an agent run", { type: "run", runId: "r1", shortId: "ab12" });
    await useWorkspace.getState().refreshProposals();
    useWorkspace.setState((s) => ({ items: Object.fromEntries(Object.entries(s.items).filter(([k]) => k !== `mock:${KEY}`)) }));
    const state = useWorkspace.getState();
    expect(state.items[`mock:${KEY}`]).toBeUndefined();
    expect(draftsForItem(state, ref).map((p) => p.id)).toEqual([made.id]);
    expect(runDescriptionDraftOf(state.proposals, "r1")?.id).toBe(made.id);
  });
});
