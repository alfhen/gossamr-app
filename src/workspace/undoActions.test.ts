import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { docFromText } from "../lib/docs";
import type { Intent, Run, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { draftDecisions } from "./DraftPreview";
import { keepEditsOfDraft } from "./DraftCard";
import { useWorkView } from "./workViewStore";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";
import { undoLog } from "./undo";
import { currentNeeds } from "./useNeeds";
import { useWorkstreams } from "./workstreamsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};
const CA401 = itemRef("CA-401");
const comment: Intent = { type: "comment", item: CA401, body: docFromText("Hi") };

/** The Undo button on the toast on screen, if there is one. */
const undoButton = () => useToasts.getState().toasts.find((t) => t.action?.label === "Undo")?.action;
const texts = () => useToasts.getState().toasts.map((t) => t.text);

let backend: MockBackend;
beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  useToasts.getState().clear();
  undoLog.clear();
  backend = new MockBackend({ runs: { seed: "empty" } });
  await useWorkspace.getState().init(backend);
  useWorkstreams.getState().init(backend);
});
afterEach(() => {
  useWorkstreams.getState().dispose();
  useToasts.getState().clear();
  vi.unstubAllGlobals();
});

describe("skipping a draft", () => {
  it("names the draft in the Undo, masking a secret and cutting a long text (G27)", async () => {
    const ws = await backend.workstreamsOpen(CA401);
    const long = backend.proposals.draft({ ...comment, body: docFromText("Password: hunter22secret and a long tail that goes on and on for a while") } as Intent, null, "r1", ws.id);
    await useWorkspace.getState().refreshProposals();
    await useWorkspace.getState().skip(long.id);
    const said = texts()[0];
    expect(said).toMatch(/^Skipped the draft on CA-401: “Password: hu….*…”\.$/);
    expect(said).not.toContain("hunter22secret");
  });

  it("names a rewrite by its card's title when it has no words, and says so in the undone note (G7)", async () => {
    const ws = await backend.workstreamsOpen(CA401);
    const rewrite = { type: "rewrite", item: CA401, title: null, body: { from: docFromText("a"), to: docFromText("b"), fromText: "a", toText: "b" }, flattened: [] } as unknown as Intent;
    const p = backend.proposals.draft(rewrite, null, "r1", ws.id);
    await useWorkspace.getState().refreshProposals();
    await useWorkspace.getState().skip(p.id);
    expect(texts()).toEqual(["Skipped the draft on CA-401: “Update the description of CA-401”."]);
    undoButton()!.run();
    await vi.waitFor(() => expect(texts()).toContain("The draft on CA-401 is back: “Update the description of CA-401”."));
  });

  it("keeps the toast's live region quiet only when the pane is deciding that draft (G6)", async () => {
    const ws = await backend.workstreamsOpen(CA401);
    const a = backend.proposals.draft(comment, null, "r1", ws.id);
    const b = backend.proposals.draft({ ...comment, body: docFromText("Other") } as Intent, null, "r1", ws.id);
    await useWorkspace.getState().refreshProposals();
    await useWorkspace.getState().skip(a.id);
    expect(useToasts.getState().toasts[0].spoken).toBeUndefined();
    useTabs.getState().setRoute("agents");
    useWorkView.getState().decide(`draft:${b.id}`);
    await useWorkspace.getState().skip(b.id);
    expect(useToasts.getState().toasts.find((t) => t.text.includes("Other"))?.spoken).toBe(false);
    useTabs.getState().setRoute("workspace");
  });

  it("speaks the skip away from Pip, even if Pip was last deciding that draft (the pane isn't there to say it)", async () => {
    const ws = await backend.workstreamsOpen(CA401);
    const p = backend.proposals.draft(comment, null, "r1", ws.id);
    await useWorkspace.getState().refreshProposals();
    useTabs.getState().setRoute("workspace");
    useWorkView.getState().decide(`draft:${p.id}`);
    await useWorkspace.getState().skip(p.id);
    expect(useToasts.getState().toasts[0].spoken).toBeUndefined();
  });

  it("names an edited draft by what the person typed, not by its stored text, still masked", async () => {
    const ws = await backend.workstreamsOpen(CA401);
    const p = backend.proposals.draft(comment, null, "r1", ws.id);
    await useWorkspace.getState().refreshProposals();
    keepEditsOfDraft(p.id, { body: { text: "Edited reply token=hunter22secret", mentions: [] } });
    await useWorkspace.getState().skip(p.id);
    const said = texts()[0];
    expect(said).toMatch(/^Skipped the draft on CA-401: “Edited reply /);
    expect(said).not.toContain("“Hi”");
    expect(said).not.toContain("hunter22secret");
    keepEditsOfDraft(p.id, {});
  });

  it("offers Undo, and Undo brings the draft back to pending with its own audit line", async () => {
    const ws = await backend.workstreamsOpen(CA401);
    const p = backend.proposals.draft(comment, null, "r1", ws.id);
    await useWorkspace.getState().refreshProposals();
    await useWorkspace.getState().skip(p.id);
    expect(useWorkspace.getState().proposals[p.id].state.type).toBe("skipped");
    expect(texts()).toEqual(["Skipped the draft on CA-401: “Hi”."]);
    expect(useToasts.getState().toasts[0].action).toMatchObject({ label: "Undo", what: "skip" });
    undoButton()!.run();
    await vi.waitFor(() => expect(useWorkspace.getState().proposals[p.id].state.type).toBe("pending"));
    expect(texts()).toContain("The draft on CA-401 is back: “Hi”.");
    const audit = (await backend.workstreamsEvents(ws.id)).map((e) => e.action);
    expect(audit.slice(-2)).toEqual(["draft_skipped", "undone"]);
  });

  it("opens the restored draft in the Agents decision pane, and only while Agents is the screen", async () => {
    const p = backend.proposals.draft(comment);
    await useWorkspace.getState().refreshProposals();
    await useWorkspace.getState().skip(p.id);
    useTabs.setState({ route: "agents" });
    useWorkView.getState().closeDecision();
    await undoLog.run(undoLog.latest()!.id);
    expect(useWorkView.getState().deciding).toBe(`draft:${p.id}`);
    await useWorkspace.getState().skip(p.id);
    useTabs.setState({ route: "workspace" });
    useWorkView.getState().closeDecision();
    await undoLog.run(undoLog.latest()!.id);
    expect(useWorkView.getState().deciding).toBeNull();
  });

  it("is the same from the keys and buttons: draftDecisions().skip offers it too", async () => {
    const p = backend.proposals.draft(comment);
    await useWorkspace.getState().refreshProposals();
    draftDecisions(p.id).skip();
    await vi.waitFor(() => expect(undoButton()).toBeDefined());
    undoButton()!.run();
    await vi.waitFor(() => expect(useWorkspace.getState().proposals[p.id].state.type).toBe("pending"));
  });

  it("offers nothing for a draft that was not pending, and Approve never offers Undo", async () => {
    const approved = backend.proposals.draft(comment);
    await useWorkspace.getState().refreshProposals();
    await useWorkspace.getState().approve(approved.id);
    expect(texts()).toEqual([]);
    await expect(useWorkspace.getState().skip(approved.id)).rejects.toThrow();
    expect(undoButton()).toBeUndefined();
  });

  it("tells the person when the skip can't be undone any more, and leaves it skipped", async () => {
    const p = backend.proposals.draft(comment);
    await useWorkspace.getState().refreshProposals();
    await useWorkspace.getState().skip(p.id);
    const toast = undoButton()!;
    // Another decision was taken on the draft elsewhere meanwhile.
    vi.spyOn(backend, "proposalsUnskip").mockRejectedValue(new Error("that draft was skipped too long ago to bring back"));
    toast.run();
    await vi.waitFor(() => expect(texts().some((t) => t.startsWith("Couldn't undo that."))).toBe(true));
    expect(useWorkspace.getState().proposals[p.id].state.type).toBe("skipped");
  });
});

describe("dismissing a failed run", () => {
  const failed = { id: "r-fail", state: "failed", item: CA401, spec: { role: "build", workstream: null } } as unknown as Run;

  beforeEach(() => useRuns.setState({ runs: [failed], dismissed: new Set() }));
  afterEach(() => useRuns.setState({ runs: [], dismissed: new Set() }));

  it("offers Undo, and Undo puts it back in Needs you exactly", () => {
    useRuns.setState({ dismissed: new Set(["old-1"]) });
    useRuns.getState().dismiss("r-fail");
    expect([...useRuns.getState().dismissed]).toEqual(["old-1", "r-fail"]);
    expect(texts()[0]).toMatch(/^Dismissed .* from Needs you\.$/);
    undoButton()!.run();
    return vi.waitFor(() => expect([...useRuns.getState().dismissed]).toEqual(["old-1"]));
  });

  it("keeps what was dismissed since, and does nothing for a run that is no longer dismissed", () => {
    useRuns.getState().dismiss("r-fail");
    const toast = undoButton()!;
    useRuns.getState().dismiss("r-other");
    toast.run();
    return vi.waitFor(() => {
      expect([...useRuns.getState().dismissed]).toEqual(["r-other"]);
      useRuns.getState().undismiss("r-fail");
      expect([...useRuns.getState().dismissed]).toEqual(["r-other"]);
    });
  });

  it("offers Undo once however often it is dismissed", () => {
    useRuns.getState().dismiss("r-fail");
    useRuns.getState().dismiss("r-fail");
    expect(useToasts.getState().toasts.filter((t) => t.action?.label === "Undo")).toHaveLength(1);
  });
});

describe("pausing a workstream", () => {
  const stored = (id: string): WorkstreamView["workstream"] => useWorkstreams.getState().list.find((v) => v.workstream.id === id)!.workstream;

  it("pauses with a note and no Undo, and Resume lifts it", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    await useWorkstreams.getState().refresh();
    expect(await useWorkstreams.getState().pause(id)).toBe(true);
    expect(stored(id).pausedReason).toBe("person");
    expect(texts()).toEqual(["Paused CA-401. Resume it to wake Pip there again."]);
    expect(undoButton()).toBeUndefined();
    expect(undoLog.latest()).toBeNull();
    expect(await useWorkstreams.getState().resume(id)).toBe(true);
    expect(stored(id).pausedReason).toBeNull();
    expect((await backend.workstreamsEvents(id)).map((e) => e.action).slice(-2)).toEqual(["paused", "resumed"]);
  });

  it("makes a need of the pause, which Resume answers", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    await useWorkstreams.getState().refresh();
    expect(currentNeeds()).toEqual([]);
    await useWorkstreams.getState().pause(id);
    expect(currentNeeds().map((n) => n.kind)).toEqual(["paused"]);
    await useWorkstreams.getState().resume(id);
    expect(currentNeeds()).toEqual([]);
  });

  it("Stop keeps its confirm and offers no Undo: it reached the agents", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    await useWorkstreams.getState().refresh();
    await useWorkstreams.getState().stop(id);
    expect(undoButton()).toBeUndefined();
  });
});
