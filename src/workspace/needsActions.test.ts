import { beforeEach, describe, expect, it } from "vitest";
import type { Need } from "../lib/needs";
import { itemRef } from "../backend/mockConnector";
import { docFromText } from "../lib/docs";
import type { Proposal } from "../types";
import { useWorkspace } from "../workspaceStore";
import { setLiveDraft } from "./draftLive";
import { keepEditsOfDraft, keepEditsOnLeave, keptEditsOfDraft } from "./DraftCard";
import { OPENED_NOT_POSTED, keyPlan, openNeed, sayOpenNote, setPaneIntent, takePaneIntent } from "./needsActions";
import { useToasts } from "./toasts";
import { useWorkView } from "./workViewStore";
import { useTabs } from "./tabsStore";
import { lastReadHeldTimes, currentNeeds, setLastReadHeldTimes } from "./useNeeds";
import { useWorkstreams } from "./workstreamsStore";

const need = (key: string) => ({ key, workstreamId: null }) as unknown as Need;

describe("opening a need with an intent", () => {
  beforeEach(() => {
    useWorkView.getState().reset();
    setPaneIntent(null);
    useTabs.setState({ route: "agents" });
  });

  it("remounts a decision that is already open, so Edit is pressed", () => {
    openNeed(need("a"));
    const rev = useWorkView.getState().paneRev;
    openNeed(need("a"), { edit: true });
    expect(useWorkView.getState().paneRev).toBe(rev + 1);
    expect(takePaneIntent()).toBe("edit");
  });

  it("does not remount for a need that is not open yet, or when not editing", () => {
    openNeed(need("a"));
    const rev = useWorkView.getState().paneRev;
    openNeed(need("b"), { edit: true });
    openNeed(need("b"));
    expect(useWorkView.getState().paneRev).toBe(rev);
  });

  it("clears a stale intent when the next action is not Edit", () => {
    openNeed(need("a"), { edit: true });
    openNeed(need("b"));
    expect(takePaneIntent()).toBeNull();
  });
});

describe("hold times Pip is told", () => {
  it("are the ones the list last read", () => {
    const held = { workstream: { id: "ws-1", closedAt: null, heldReason: "restart", createdAt: "2026-01-01T00:00:00Z" }, stage: "intake", runs: [], labels: [] };
    useWorkstreams.setState({ list: [held] as never });
    const before = currentNeeds().find((n) => n.key === "held:ws-1");
    setLastReadHeldTimes({ "ws-1": "2026-06-01T00:00:00Z" });
    expect(lastReadHeldTimes()).toEqual({ "ws-1": "2026-06-01T00:00:00Z" });
    const after = currentNeeds().find((n) => n.key === "held:ws-1");
    expect(before?.at).toBe("2026-01-01T00:00:00.000Z".replace(".000", ""));
    expect(after?.at).toBe("2026-06-01T00:00:00Z");
    setLastReadHeldTimes({});
  });
});

describe("a then Enter on a comment draft (G1)", () => {
  const draft = (label: string | null = null, createdBy: "user" | "pip" = "user", text = "Original text"): Proposal => ({
    id: "p1",
    createdAt: "2026-09-30T10:00:00Z",
    updatedAt: "2026-09-30T10:00:00Z",
    origin: { type: "board" },
    createdBy,
    intent: { type: "comment", item: itemRef("CA-412"), body: docFromText(text) },
    label,
    basis: null,
    state: { type: "pending" },
    revisions: [],
    created: [],
    error: null,
    run: null,
  });
  const draftNeed = { key: "draft:p1", kind: "draft", workstreamId: null, target: { type: "draft", id: "p1" }, primary: { id: "approve", label: "Post" }, secondary: [] } as unknown as Need;
  const plan = () => keyPlan(draftNeed, "approve")?.type;
  beforeEach(() => {
    useWorkspace.setState({ proposals: { p1: draft() } } as never);
    setLiveDraft("p1", null);
  });

  it("asks for Enter while the card holds nothing the draft doesn't", () => {
    expect(plan()).toBe("ask");
    setLiveDraft("p1", { edited: false, risky: false });
    expect(plan()).toBe("ask");
  });

  it("opens the card when it holds an unsaved edit, so the edit is what is posted", () => {
    setLiveDraft("p1", { edited: true, risky: false });
    expect(keyPlan(draftNeed, "approve")).toEqual({ type: "open", edit: false, note: OPENED_NOT_POSTED });
  });

  it("opens the card when its words would stop at the posting pause, and says why nothing was posted (G27)", () => {
    setLiveDraft("p1", { edited: false, risky: true });
    expect(plan()).toBe("open");
    useToasts.getState().clear();
    sayOpenNote(keyPlan(draftNeed, "approve")!);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Not posted. This draft holds an edit or would pause, so its card opens to read first."]);
    // A plain open (nothing to explain) and an ask say nothing.
    setLiveDraft("p1", null);
    sayOpenNote(keyPlan(draftNeed, "approve")!);
    sayOpenNote({ type: "open", edit: true });
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("opens the card when words typed into it were kept after it closed", () => {
    keepEditsOfDraft("p1", { body: { text: "Edited text", mentions: [] } });
    try {
      expect(plan()).toBe("open");
    } finally {
      keepEditsOfDraft("p1", {});
    }
    expect(plan()).toBe("ask");
  });

  it("opens the card when an edit finished with Done editing was kept as the card went, and not for one with nothing typed or no longer pending (G1)", () => {
    keepEditsOnLeave("p1", "pending", {});
    expect(keptEditsOfDraft("p1")).toBeUndefined();
    keepEditsOnLeave("p1", "applied", { body: { text: "Edited text", mentions: [] } });
    expect(keptEditsOfDraft("p1")).toBeUndefined();
    try {
      keepEditsOnLeave("p1", "pending", { body: { text: "Edited text", mentions: [] } });
      expect(keptEditsOfDraft("p1")?.body?.text).toBe("Edited text");
      expect(keyPlan(draftNeed, "approve")).toEqual({ type: "open", edit: false, note: OPENED_NOT_POSTED });
    } finally {
      keepEditsOfDraft("p1", {});
    }
  });

  it("keeps the edits of sibling drafts apart (G1)", () => {
    keepEditsOnLeave("p1", "pending", { body: { text: "One", mentions: [] } });
    keepEditsOnLeave("p2", "pending", { message: "Two" });
    try {
      expect(keptEditsOfDraft("p1")?.body?.text).toBe("One");
      expect(keptEditsOfDraft("p2")?.message).toBe("Two");
    } finally {
      keepEditsOfDraft("p1", {});
      keepEditsOfDraft("p2", {});
    }
  });

  it("opens an answers draft whose card is not on screen when its text would stop at the pause", () => {
    useWorkspace.setState({ proposals: { p1: draft("Answers to the open questions", "pip", "Ask @here about it") } } as never);
    expect(plan()).toBe("open");
  });
});
