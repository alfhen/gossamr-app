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
import { contextFor, conversationTitle, focusComposer, focusedConversation, paneConversation, paneWorkstream, useWorkstreams, workstreamTicket } from "./workstreamsStore";
import { usePipHome } from "./pipHomeStore";
import type { WorkstreamView } from "../types";
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
  useTabs.getState().setRoute("workspace");
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

describe("Pip home's conversation", () => {
  it("is the Pip home selection's on route pip, and the pane's everywhere else", async () => {
    const ws = (await useWorkstreams.getState().start(CA401))!;
    useTabs.getState().select(itemKey(CA401));
    expect(focusedConversation()).toBe(workstreamConversation(ws.workstream.id));
    expect(focusedConversation()).toBe(paneConversation());
    useTabs.getState().setRoute("pip");
    expect(usePipHome.getState().selected).toBeNull();
    expect(focusedConversation()).toBe(GENERAL_CONVERSATION);
    usePipHome.getState().openWorkstream(ws.workstream.id);
    expect(focusedConversation()).toBe(workstreamConversation(ws.workstream.id));
    // The pane's own pick is untouched by Pip home's.
    expect(paneConversation()).toBe(GENERAL_CONVERSATION);
    useTabs.getState().setRoute("activity");
    expect(focusedConversation()).toBe(paneConversation());
  });

  it("selects a workstream started on Pip home there, and leaves the pane closed", async () => {
    usePrefs.getState().setPipOpen(false);
    useTabs.getState().setRoute("pip");
    const started = (await useWorkstreams.getState().start(CA401))!;
    expect(usePipHome.getState().selected).toBe(started.workstream.id);
    expect(usePrefs.getState().pipOpen).toBe(false);
    expect(focusedConversation()).toBe(workstreamConversation(started.workstream.id));
  });

  it("goes back to General once the selected workstream closes, or the workstreams go away", async () => {
    useTabs.getState().setRoute("pip");
    const started = (await useWorkstreams.getState().start(CA401))!;
    await useWorkstreams.getState().close(started.workstream.id);
    expect(usePipHome.getState().selected).toBeNull();
    const again = (await useWorkstreams.getState().start(CA401))!;
    expect(usePipHome.getState().selected).toBe(again.workstream.id);
    useWorkstreams.getState().dispose();
    expect(usePipHome.getState().selected).toBeNull();
  });

  it("asks there in the selection's conversation without opening the pane", async () => {
    usePrefs.getState().setPipOpen(false);
    useTabs.getState().setRoute("pip");
    const sent: AskRequest[] = [];
    const ask = vi.spyOn(claude, "ask").mockImplementation(async (req) => (sent.push(req), { queued: false, ahead: 0 }));
    try {
      askPip("Show stale tickets");
      await vi.waitFor(() => expect(sent).toHaveLength(1));
    } finally {
      ask.mockRestore();
    }
    expect(sent[0]).toMatchObject({ conversation: GENERAL_CONVERSATION });
    expect(usePrefs.getState().pipOpen).toBe(false);
    expect(useTabs.getState().route).toBe("pip");
  });

  it("lists the closed workstreams, and a read that an earlier one overtook doesn't land", async () => {
    const first = (await useWorkstreams.getState().start(CA401))!;
    await useWorkstreams.getState().close(first.workstream.id);
    await useWorkstreams.getState().loadClosed();
    expect(useWorkstreams.getState().closed.map((v) => v.workstream.id)).toEqual([first.workstream.id]);

    const stale: WorkstreamView = { ...first, workstream: { ...first.workstream, id: "ws-stale" } };
    let release: (list: WorkstreamView[]) => void = () => {};
    const read = vi.spyOn(backend, "workstreamsList").mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const slow = useWorkstreams.getState().loadClosed();
    const fresh = useWorkstreams.getState().loadClosed();
    await fresh;
    release([stale]);
    await slow;
    read.mockRestore();
    expect(useWorkstreams.getState().closed.map((v) => v.workstream.id)).toEqual([first.workstream.id]);
  });

  it("reads a workstream's audit for the step rail, again for the selected one as it changes, and drops a read overtaken or disposed", async () => {
    const ws = (await useWorkstreams.getState().start(CA401))!;
    const id = ws.workstream.id;
    await useWorkstreams.getState().loadEvents(id);
    expect(useWorkstreams.getState().events[id]?.map((e) => e.action)).toEqual((await backend.workstreamsEvents(id)).map((e) => e.action));

    // Selected on Pip home, a change to it reads the audit again.
    usePipHome.getState().openWorkstream(id);
    await backend.workstreamsHold(id);
    await vi.waitFor(() => expect(useWorkstreams.getState().events[id]?.slice(-1)[0]?.action).toBe("held"));

    let release: (events: Awaited<ReturnType<typeof backend.workstreamsEvents>>) => void = () => {};
    const read = vi.spyOn(backend, "workstreamsEvents").mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const slow = useWorkstreams.getState().loadEvents(id);
    await useWorkstreams.getState().loadEvents(id);
    release([]);
    await slow;
    read.mockRestore();
    expect(useWorkstreams.getState().events[id]?.length).toBeGreaterThan(0);

    const late = vi.spyOn(backend, "workstreamsEvents").mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const pending = useWorkstreams.getState().loadEvents(id);
    useWorkstreams.getState().dispose();
    release([]);
    await pending;
    late.mockRestore();
    expect(useWorkstreams.getState().events).toEqual({});
  });
});

describe("focusComposer", () => {
  /** A page with a body, Pip's input when `mounted`, and a rail chip; focusing one makes it the active element. */
  const page = (mounted: boolean) => {
    const doc = { activeElement: null as unknown, body: {} as unknown, getElementById: (id: string) => (id === "pip-input" && doc.mounted ? input : null), mounted };
    doc.activeElement = doc.body;
    const make = () => {
      const e = { focus: vi.fn(() => void (doc.activeElement = e)) };
      return e;
    };
    const input = make();
    const chip = make();
    return { doc, input, chip };
  };
  let frames: (() => void)[] = [];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (go: () => void) => frames.push(go));
  });

  it("focuses the input now, and on the next frame only if focus is where it left it", () => {
    const { doc, input, chip } = page(true);
    vi.stubGlobal("document", doc);
    focusComposer();
    expect(doc.activeElement).toBe(input);
    // F6 pressed before the frame: the rail keeps it.
    chip.focus();
    frames.shift()!();
    expect(doc.activeElement).toBe(chip);
    expect(input.focus).toHaveBeenCalledOnce();
  });

  it("focuses an input that mounts a frame later, unless a key took focus elsewhere first", () => {
    const later = page(false);
    vi.stubGlobal("document", later.doc);
    focusComposer();
    expect(later.doc.activeElement).toBe(later.doc.body);
    later.doc.mounted = true;
    frames.shift()!();
    expect(later.doc.activeElement).toBe(later.input);

    const moved = page(false);
    vi.stubGlobal("document", moved.doc);
    focusComposer();
    moved.chip.focus();
    moved.doc.mounted = true;
    frames.shift()!();
    expect(moved.doc.activeElement).toBe(moved.chip);
    expect(moved.input.focus).not.toHaveBeenCalled();
  });
});
