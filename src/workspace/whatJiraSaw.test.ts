import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { jiraSent } from "../lib/jiraSent";
import { useWorkspace } from "../workspaceStore";
import { useToasts } from "./toasts";
import { useWorkstreams } from "./workstreamsStore";

// What Jira saw from me, read from the same drafts and audit the page holds.

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

let backend: MockBackend;
beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  useToasts.getState().clear();
  backend = new MockBackend({ runs: { seed: "empty", prSurfaceMs: null } });
  backend.supervisor.dispose();
  await useWorkspace.getState().init(backend);
  useWorkstreams.getState().init(backend);
});
afterEach(() => {
  useWorkstreams.getState().dispose();
  useToasts.getState().clear();
  vi.unstubAllGlobals();
});

const proposals = () => Object.values(useWorkspace.getState().proposals);
const comment = (key: string, text: string) => ({ type: "comment" as const, item: itemRef(key), body: { blocks: [{ type: "paragraph" as const, content: [{ type: "text" as const, text, marks: [] }] }] } });

describe("What Jira saw from me", () => {
  it("lists what the person approved, with who drafted it, where from, and whether they edited it first", async () => {
    const id = (await backend.workstreamsOpen(itemRef("CA-408"))).id;
    await useWorkstreams.getState().refresh();
    const pips = backend.proposals.draft(comment("CA-408", "Checking in."), null, "q1", id);
    expect(pips.origin).toMatchObject({ type: "chat", workstream: id });
    await backend.proposalsApprove(pips.id);
    const other = await backend.proposalsCreate(comment("CA-402", "On it."));
    await backend.proposalsEdit(other.id, { type: "comment", body: "On it, today.", mentions: [] });
    await backend.proposalsApprove(other.id);
    await useWorkspace.getState().refreshProposals();
    await useWorkstreams.getState().loadEvents(id);
    const sent = jiraSent({ proposals: proposals(), events: useWorkstreams.getState().events, workstreams: useWorkstreams.getState().list });
    expect(sent.map((e) => [e.ticketKey, e.kind, e.madeBy, e.edited])).toEqual([
      ["CA-402", "comment", "You", true],
      ["CA-408", "comment", "Pip", false],
    ]);
    expect(sent[0]).toMatchObject({ summary: "On it, today.", workstreamId: null, from: "the board" });
    expect(sent[1]).toMatchObject({ workstreamId: id, workstream: "CA-408", from: "Pip" });
    // A draft still waiting, or skipped, is not there.
    const waiting = await backend.proposalsCreate({ type: "comment", item: itemRef("CA-403"), body: { blocks: [] } });
    await useWorkspace.getState().refreshProposals();
    expect(jiraSent({ proposals: proposals(), events: {}, workstreams: [] }).map((e) => e.id)).not.toContain(waiting.id);
  });
});
