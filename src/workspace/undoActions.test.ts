import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { docFromText } from "../lib/docs";
import type { Intent, Run, WorkstreamView } from "../types";
import { HELD_ALL, HELD_BUDGET, HELD_PERSON } from "../types";
import { useWorkspace } from "../workspaceStore";
import { contextDeps } from "./contextActions";
import { draftDecisions } from "./DraftPreview";
import { useRuns } from "./runsStore";
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
  it("offers Undo, and Undo brings the draft back to pending with its own audit line", async () => {
    const ws = await backend.workstreamsOpen(CA401);
    const p = backend.proposals.draft(comment, null, "r1", ws.id);
    await useWorkspace.getState().refreshProposals();
    await useWorkspace.getState().skip(p.id);
    expect(useWorkspace.getState().proposals[p.id].state.type).toBe("skipped");
    expect(texts()).toEqual(["Skipped the draft on CA-401."]);
    undoButton()!.run();
    await vi.waitFor(() => expect(useWorkspace.getState().proposals[p.id].state.type).toBe("pending"));
    expect(texts()).toContain("The draft is back.");
    const audit = (await backend.workstreamsEvents(ws.id)).map((e) => e.action);
    expect(audit.slice(-2)).toEqual(["draft_skipped", "undone"]);
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
  const failed = { id: "r-fail", state: "failed", item: CA401, spec: { kind: "build", workstream: null } } as unknown as Run;

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

describe("holding a workstream", () => {
  const stored = (id: string): WorkstreamView["workstream"] => useWorkstreams.getState().list.find((v) => v.workstream.id === id)!.workstream;

  it("offers Undo, and Undo lifts the hold", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    await useWorkstreams.getState().refresh();
    expect(await useWorkstreams.getState().hold(id)).toBe(true);
    expect(stored(id).heldReason).toBe(HELD_PERSON);
    expect(texts()).toEqual(["Held CA-401."]);
    undoButton()!.run();
    await vi.waitFor(() => expect(stored(id).heldReason).toBeNull());
    expect((await backend.workstreamsEvents(id)).map((e) => e.action).slice(-2)).toEqual(["held", "undone"]);
  });

  it("makes no need of the hold, and Undo still lifts it", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    await useWorkstreams.getState().refresh();
    expect(currentNeeds()).toEqual([]);
    await useWorkstreams.getState().hold(id);
    expect(stored(id).heldReason).toBe(HELD_PERSON);
    expect(currentNeeds()).toEqual([]);
    undoButton()!.run();
    await vi.waitFor(() => expect(stored(id).heldReason).toBeNull());
    expect(currentNeeds()).toEqual([]);
    // Hold all is the person's too.
    await useWorkstreams.getState().holdAll();
    expect(stored(id).heldReason).toBe(HELD_ALL);
    expect(currentNeeds()).toEqual([]);
  });

  it("restores the hold the person's replaced, not just 'free'", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    backend.workstreams.hold(id, HELD_BUDGET, "supervisor");
    await useWorkstreams.getState().refresh();
    await useWorkstreams.getState().hold(id);
    expect(stored(id).heldReason).toBe(HELD_PERSON);
    undoButton()!.run();
    await vi.waitFor(() => expect(stored(id).heldReason).toBe(HELD_BUDGET));
  });

  it("offers nothing when the workstream was held by the person already, and resuming never offers Undo", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    await useWorkstreams.getState().refresh();
    await useWorkstreams.getState().hold(id);
    useToasts.getState().clear();
    await useWorkstreams.getState().hold(id);
    expect(undoButton()).toBeUndefined();
    await useWorkstreams.getState().resume(id);
    expect(undoButton()).toBeUndefined();
    expect(stored(id).heldReason).toBeNull();
  });

  it("Hold all offers one Undo that frees every workstream it held", async () => {
    const a = (await backend.workstreamsOpen(CA401)).id;
    const b = (await backend.workstreamsOpen(itemRef("CA-402"))).id;
    await useWorkstreams.getState().refresh();
    expect(await useWorkstreams.getState().holdAll()).toBe(2);
    expect([stored(a).heldReason, stored(b).heldReason]).toEqual([HELD_ALL, HELD_ALL]);
    undoButton()!.run();
    await vi.waitFor(() => expect([stored(a).heldReason, stored(b).heldReason]).toEqual([null, null]));
  });

  it("Stop keeps its confirm and offers no Undo: it reached the agents", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    await useWorkstreams.getState().refresh();
    await useWorkstreams.getState().stop(id);
    expect(undoButton()).toBeUndefined();
  });
});

describe("a workstream that used its automatic steps", () => {
  const stored = (id: string) => useWorkstreams.getState().list.find((v) => v.workstream.id === id)!.workstream;

  it("is a Decide need, and Allow 5 more raises the allowance, resumes it and answers the need", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    await useWorkstreams.getState().setMode(id, "manage");
    backend.workstreams.hold(id, HELD_BUDGET, "supervisor");
    await useWorkstreams.getState().refresh();
    expect(currentNeeds().map((n) => [n.key, n.group, n.title])).toEqual([[`budget:${id}`, "decide", "CA-401 used its 11 automatic steps"]]);
    expect(await useWorkstreams.getState().allowMore(id)).toBe(true);
    expect(stored(id)).toMatchObject({ heldReason: null, budget: { autoTurns: 16 } });
    expect(currentNeeds()).toEqual([]);
    // Nothing is held for its budget now, so a second press is refused and says why.
    expect(await useWorkstreams.getState().allowMore(id)).toBe(false);
    expect(texts().join(" ")).toContain("isn't held for its automatic steps");
  });

  it("is answered from the palette with the same two choices", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    await useWorkstreams.getState().setMode(id, "manage");
    backend.workstreams.hold(id, HELD_BUDGET, "supervisor");
    await useWorkstreams.getState().refresh();
    const [budget] = currentNeeds();
    contextDeps.needAct(budget, "advise");
    await vi.waitFor(() => expect(stored(id).mode).toBe("advise"));
    await useWorkstreams.getState().setMode(id, "manage");
    // Allow 5 more is asked for with Enter on the keyboard; the palette's own Enter is that step.
    contextDeps.needAct(currentNeeds()[0], "allowMore");
    await vi.waitFor(() => expect(stored(id).heldReason).toBeNull());
    expect(stored(id).budget.autoTurns).toBe(16);
  });

  it("is answered by Switch to Advise, with the hold left for Resume", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    await useWorkstreams.getState().setMode(id, "manage");
    backend.workstreams.hold(id, HELD_BUDGET, "supervisor");
    await useWorkstreams.getState().refresh();
    expect(currentNeeds()).toHaveLength(1);
    await useWorkstreams.getState().setMode(id, "advise");
    expect(currentNeeds()).toEqual([]);
    expect(stored(id).heldReason).toBe(HELD_BUDGET);
  });
});

describe("switching a workstream to Advise", () => {
  const stored = (id: string) => useWorkstreams.getState().list.find((v) => v.workstream.id === id)!.workstream;

  it("offers Undo, and Undo restores Manage", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    await useWorkstreams.getState().refresh();
    await useWorkstreams.getState().setMode(id, "manage");
    expect(undoButton()).toBeUndefined();
    await useWorkstreams.getState().setMode(id, "advise");
    expect(stored(id).mode).toBe("advise");
    expect(texts()).toEqual(["Switched CA-401 to Advise."]);
    undoButton()!.run();
    await vi.waitFor(() => expect(stored(id).mode).toBe("manage"));
    expect((await backend.workstreamsEvents(id)).map((e) => e.action).slice(-2)).toEqual(["mode_set", "undone"]);
  });

  it("offers nothing when it was Advise already", async () => {
    const id = (await backend.workstreamsOpen(CA401)).id;
    await useWorkstreams.getState().refresh();
    await useWorkstreams.getState().setMode(id, "advise");
    expect(undoButton()).toBeUndefined();
  });
});
