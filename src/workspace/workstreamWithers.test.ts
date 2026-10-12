import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClaude } from "../claudeStore";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { workstreamConversation } from "../lib/conversations";
import type { Intent, Run, RunSpec } from "../types";
import { useWorkspace } from "../workspaceStore";
import { withersOf } from "./useWorkstreamWithers";
import { useWorkstreams } from "./workstreamsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const CA401 = itemRef("CA-401");
const CA402 = itemRef("CA-402");

let backend: MockBackend;
beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  backend = new MockBackend({ runs: { seed: "empty", prSurfaceMs: null, epoch: Date.now() }, wsManage: false });
  backend.supervisor.dispose();
  await useWorkspace.getState().init(backend);
  useWorkstreams.getState().init(backend);
  useClaude.setState({ byTicket: {} });
});
afterEach(() => {
  useWorkstreams.getState().dispose();
  useClaude.setState({ byTicket: {} });
  vi.unstubAllGlobals();
});

/** A run in workstream `ws` on `item` that has started: its start is now, in the sample's own time. */
async function started(ws: string, item = CA401): Promise<Run> {
  const spec: RunSpec = { kind: "investigate", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: `${item.key.toLowerCase()}-${Math.random().toString(16).slice(2, 7)}`, instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: ws };
  const draft = await backend.runsDraft(spec, item);
  const run = await backend.runsApprove(draft.id, (await backend.runsReview(draft.id)).digest);
  backend.runs.advance(run.id);
  backend.runs.advance(run.id);
  return backend.runs.get(run.id)!;
}

const parts = async (ids: string[]) => {
  await useWorkstreams.getState().refresh();
  await useWorkspace.getState().refreshProposals();
  for (const id of ids) await useWorkstreams.getState().loadEvents(id);
  return { events: useWorkstreams.getState().events, byTicket: useClaude.getState().byTicket, runs: backend.runs.list(), proposals: useWorkspace.getState().proposals };
};
const open = () => useWorkstreams.getState().list.filter((v) => v.workstream.closedAt === null);

describe("the cobweb of each workstream on Pip home", () => {
  it("shows on a workstream whose agents worked since the person's last post, and on none where nothing happened", async () => {
    const busy = (await backend.workstreamsOpen(CA401)).id;
    const idle = (await backend.workstreamsOpen(CA402)).id;
    backend.workstreams.seedEvent(busy, "person", "review_posted", ago(5));
    backend.workstreams.seedEvent(idle, "person", "review_posted", ago(5));
    await started(busy);
    const got = withersOf(open(), await parts([busy, idle]), Date.now());
    expect(Object.keys(got)).toEqual([busy]);
    expect(got[busy]).toMatchObject({ level: 3, runs: 1, text: expect.stringMatching(/^No Jira update for 5 days \(1 run since\)$/) });
  });

  it("measures from when the workstream opened until the person posts, and a post then clears it", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    backend.workstreams.backdate(id, 8);
    await started(id);
    expect(withersOf(open(), await parts([id]), Date.now())[id]).toMatchObject({ level: 4, days: 8, text: "No Jira update for 8 days (1 run since)" });
    // A comment the person approves is a post: it restarts the clock, and nothing is stale.
    const comment: Intent = { type: "comment", item: CA401, body: { blocks: [] } };
    const p = backend.proposals.draft(comment, null, "r1", id);
    await useWorkspace.getState().refreshProposals();
    await useWorkspace.getState().approve(p.id);
    expect(withersOf(open(), await parts([id]), Date.now())).toEqual({});
  });

  it("counts a draft the person skipped, or one that starts an agent, as no post", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    backend.workstreams.backdate(id, 6);
    await started(id);
    const skipped = backend.proposals.draft({ type: "comment", item: CA401, body: { blocks: [] } } as Intent, null, "r1", id);
    await useWorkspace.getState().refreshProposals();
    await useWorkspace.getState().skip(skipped.id);
    expect(withersOf(open(), await parts([id]), Date.now())[id]).toMatchObject({ level: 3, days: 6 });
  });

  it("counts Pip's turns of the conversation as work, once it is loaded", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    backend.workstreams.backdate(id, 6);
    expect(withersOf(open(), await parts([id]), Date.now())).toEqual({});
    const turn = { requestId: "q1", prompt: "What is next?", steps: [], text: "Triage it.", status: "done" as const, error: null, at: new Date().toISOString() };
    const stored = { ...(await parts([id])), byTicket: { [workstreamConversation(id)]: { turns: [turn] } } };
    expect(withersOf(open(), stored, Date.now())[id]).toMatchObject({ level: 3, turns: 1, runs: 0, text: "No Jira update for 6 days (1 Pip turn since)" });
  });
});
