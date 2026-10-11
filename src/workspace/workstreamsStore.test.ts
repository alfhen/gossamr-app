import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claude, type AskRequest } from "../backend/claude";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { forgetConversations, useClaude } from "../claudeStore";
import { ALL, itemKey } from "../lib/filter";
import { useWorkspace } from "../workspaceStore";
import { askPip } from "./askPip";
import { handlePipView } from "./PipExtras";
import { usePip } from "./pipStore";
import { usePrefs } from "./prefs";
import { useRuns } from "./runsStore";
import { activeTab, loadTabs, useTabs } from "./tabsStore";
import { contextFor, conversationTitle, paneConversation, paneWorkstream, useWorkstreams, workstreamTicket } from "./workstreamsStore";
import { GENERAL_CONVERSATION, workstreamConversation } from "../lib/conversations";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

const CA401 = itemRef("CA-401");
let backend: MockBackend;

beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  useTabs.setState(loadTabs());
  useTabs.getState().setFilter(ALL);
  useTabs.getState().select(null);
  usePip.setState({ filtered: null, applied: {}, pinned: null, quote: null, prefill: null });
  backend = new MockBackend({ runs: { seed: "empty" } });
  await useWorkspace.getState().init(backend);
  useWorkstreams.getState().init(backend);
});

afterEach(() => {
  useWorkstreams.getState().dispose();
  useClaude.setState({ byTicket: {} });
  vi.unstubAllGlobals();
});

describe("the workstreams store", () => {
  it("starts a workstream on a ticket, lists it with its stage and opens Pip", async () => {
    usePrefs.getState().setPipOpen(false);
    const started = await useWorkstreams.getState().start(CA401);
    expect(started).toMatchObject({ stage: "intake", workstream: { itemKey: "CA-401" } });
    expect(useWorkstreams.getState().forItem("CA-401")?.workstream.id).toBe(started?.workstream.id);
    expect(useWorkstreams.getState().forItem("CA-401", "jira")).toBeNull();
    expect(useWorkstreams.getState().forItem("CA-402")).toBeNull();
    expect(usePrefs.getState().pipOpen).toBe(true);
    expect(conversationTitle(started)).toMatch(/^Workstream: CA-401 .+ · Intake$/);
    expect(conversationTitle(null)).toBe("General");
    expect(conversationTitle({ ...started!, stage: "build", waitingForPr: "r4" })).toMatch(/^Workstream: CA-401 .+ · Build · waiting for PR$/);
  });

  it("refreshes when the backend says a workstream changed, and is cleared with the conversations", async () => {
    const ws = await backend.workstreamsOpen(CA401);
    await vi.waitFor(() => expect(useWorkstreams.getState().list.map((v) => v.workstream.id)).toEqual([ws.id]));
    await backend.workstreamsClose(ws.id);
    await vi.waitFor(() => expect(useWorkstreams.getState().list).toEqual([]));
    await backend.workstreamsOpen(CA401);
    await vi.waitFor(() => expect(useWorkstreams.getState().list).toHaveLength(1));
    forgetConversations();
    expect(useWorkstreams.getState()).toMatchObject({ backend: null, list: [] });
  });

  it("puts the pane on the peeked ticket's workstream, and on General otherwise", async () => {
    expect(paneConversation()).toBe("general");
    const ws = (await useWorkstreams.getState().start(CA401))!;
    expect(paneConversation()).toBe("general");
    useTabs.getState().select(itemKey(CA401));
    expect(paneWorkstream()?.workstream.id).toBe(ws.workstream.id);
    expect(paneConversation()).toBe(`ws:${ws.workstream.id}`);
    useTabs.getState().setRoute("settings");
    expect(paneConversation()).toBe("general");
    useTabs.getState().setRoute("workspace");
    useTabs.getState().select(itemKey(itemRef("CA-402")));
    expect(paneConversation()).toBe("general");
  });

  it("keeps a workstream's conversation in the pane after a run of it is started there and the Agents view opens", async () => {
    const ws = (await useWorkstreams.getState().start(CA401))!;
    useTabs.getState().select(itemKey(CA401));
    expect(paneConversation()).toBe(`ws:${ws.workstream.id}`);
    const draft = await backend.runsDraft({ kind: "investigate", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-401-pane-1a2b", instruction: "", workstream: ws.workstream.id }, CA401);
    const run = await backend.runsApprove(draft.id, (await backend.runsReview(draft.id)).digest);
    useRuns.getState().init(backend);
    await useRuns.getState().reload();
    // Starting it opens its sheet on the Agents view, where no ticket is peeked.
    useRuns.getState().openRun(run.id);
    useTabs.getState().select(null);
    expect(useTabs.getState().route).toBe("agents");
    expect(paneConversation()).toBe(`ws:${ws.workstream.id}`);
    // The sheet closed, the run is still the selected one.
    useRuns.getState().closeSheet();
    expect(paneWorkstream()?.workstream.id).toBe(ws.workstream.id);
    useRuns.getState().select(null);
    expect(paneConversation()).toBe("general");
    // A run in no workstream on a ticket that has one open brings that one.
    const loose = await backend.runsDraft({ kind: "investigate", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-401-pane-3c4d", instruction: "" }, CA401);
    const looseRun = await backend.runsApprove(loose.id, (await backend.runsReview(loose.id)).digest);
    await useRuns.getState().reload();
    useRuns.getState().select(looseRun.id);
    expect(paneConversation()).toBe(`ws:${ws.workstream.id}`);
    // Elsewhere, a run left selected on the Agents view doesn't decide the pane.
    useTabs.getState().setRoute("workspace");
    expect(paneConversation()).toBe("general");
    useRuns.getState().dispose();
  });

  it("closes a workstream after asking: the ticket's conversation is General again, and the audit says so", async () => {
    const ws = (await useWorkstreams.getState().start(CA401))!;
    useTabs.getState().select(itemKey(CA401));
    useWorkstreams.getState().askClose(ws.workstream.id);
    expect(useWorkstreams.getState().confirmingClose).toBe(ws.workstream.id);
    useWorkstreams.getState().askClose(null);
    expect(useWorkstreams.getState().confirmingClose).toBeNull();
    expect(paneConversation()).toBe(`ws:${ws.workstream.id}`);
    useWorkstreams.getState().askClose(ws.workstream.id);
    expect(await useWorkstreams.getState().close(ws.workstream.id)).toBe(true);
    expect(useWorkstreams.getState()).toMatchObject({ confirmingClose: null, list: [] });
    expect(paneConversation()).toBe("general");
    expect((await backend.workstreamsEvents(ws.workstream.id)).map((e) => e.action)).toEqual(["opened", "closed"]);
    expect(await useWorkstreams.getState().close("nope")).toBe(false);
  });

  it("asks in the focused workstream's conversation and applies only that conversation's filters", async () => {
    const ws = (await useWorkstreams.getState().start(CA401))!;
    useTabs.getState().select(itemKey(CA401));
    const conversation = `ws:${ws.workstream.id}`;
    const sent: AskRequest[] = [];
    const ask = vi.spyOn(claude, "ask").mockImplementation(async (req) => (sent.push(req), { queued: false, ahead: 0 }));
    try {
      askPip("what next?");
      await vi.waitFor(() => expect(sent).toHaveLength(1));
    } finally {
      ask.mockRestore();
    }
    expect(sent[0]).toMatchObject({ prompt: "what next?", conversation });
    const asked = sent[0].requestId;
    useClaude.setState({ byTicket: { general: { sessionId: null, turns: [{ requestId: "in-general", prompt: "", steps: [], text: "", status: "running", error: null }] }, ...useClaude.getState().byTicket } });
    handlePipView({ requestId: "in-general", filter: { type: "blocked" }, note: "x" });
    expect(activeTab(useTabs.getState()).filter).toEqual(ALL);
    handlePipView({ requestId: asked, filter: { type: "blocked" }, note: "x" });
    expect(activeTab(useTabs.getState()).filter).toEqual({ type: "blocked" });
  });
});

describe("what Pip sees in a workstream's conversation", () => {
  const empty = { view: "Board", item: null, filter: null, selection: [] };

  it("is given the workstream's ticket when no ticket is on screen", async () => {
    const started = await useWorkstreams.getState().start(CA401);
    const conversation = workstreamConversation(started!.workstream.id);
    expect(workstreamTicket(conversation)).toMatchObject({ key: "CA-401", connectionId: CA401.connectionId });
    expect(contextFor(conversation, empty).item).toMatchObject({ key: "CA-401" });
  });

  it("keeps a ticket that is on screen, and adds none in General", async () => {
    const started = await useWorkstreams.getState().start(CA401);
    const other = itemRef("CA-402");
    expect(contextFor(workstreamConversation(started!.workstream.id), { ...empty, item: other }).item).toEqual(other);
    expect(contextFor(GENERAL_CONVERSATION, empty).item).toBeNull();
    expect(workstreamTicket(workstreamConversation("ws-unknown"))).toBeNull();
  });
});
