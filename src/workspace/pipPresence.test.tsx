import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { withQuote } from "../claudeStore";
import { docFromText } from "../lib/docs";
import { ALL } from "../lib/filter";
import type { Proposal, ScreenContext } from "../types";
import { useWorkspace } from "../workspaceStore";
import { DraftPreview, draftPreviewBody } from "./DraftPreview";
import { AskPipButton, askPlacement, Launcher } from "./PipExtras";
import { AppliedCard, ContextChip, escapeClosesPane, SeeingPanel } from "./PipPane";
import { typingIn } from "./PeekSheet";
import { PipAvatar } from "./PipAvatar";
import { pupilOffset } from "./pipGaze";
import { appliedState, usePip } from "./pipStore";
import { contextLabel, contextLines } from "./screenContext";
import { loadTabs, useTabs } from "./tabsStore";

const ws = () => useWorkspace.getState();

beforeEach(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  useTabs.setState(loadTabs());
  useTabs.getState().setFilter(ALL);
  usePip.setState({ filtered: null, applied: {}, pinned: null, quote: null, prefill: null });
  await ws().init(new MockBackend());
});

describe("what Pip can see", () => {
  const words = { titleOf: (r: { key: string }) => (r.key === "DEVOPS-471" ? "Rotate keys" : null), describeFilter: () => "Blocked" };
  const ref = (key: string) => ({ connectionId: "mock", externalId: key, key });

  it("lists exactly what goes with the question", () => {
    const ctx: ScreenContext = { view: "Board · DEVOPS · 4 items", item: ref("DEVOPS-471"), filter: { type: "blocked" }, selection: [ref("DEVOPS-1"), ref("DEVOPS-2")] };
    expect(contextLines(ctx, "a long\nselection", words)).toEqual([
      "Screen: Board · DEVOPS · 4 items",
      "Open ticket: DEVOPS-471 · Rotate keys",
      "Filter: Blocked",
      "Ticked tickets: DEVOPS-1, DEVOPS-2",
      "Selected text: “a long selection”",
    ]);
    expect(contextLines({ view: "Settings", item: null, filter: null, selection: [] }, null, words)).toEqual(["Screen: Settings"]);
  });

  it("labels the chip by ticket or screen and marks a selection", () => {
    expect(contextLabel({ view: "List · All projects · 3 items", item: null, filter: null, selection: [] }, null, words.titleOf)).toEqual({ kind: "Screen", label: "List · All projects · 3 items" });
    expect(contextLabel({ view: "x", item: ref("DEVOPS-471"), filter: null, selection: [] }, "abc", words.titleOf)).toEqual({ kind: "Ticket", label: "DEVOPS-471 · Rotate keys + selection" });
  });

  it("gives the assistant the selected text after the prompt", () => {
    expect(withQuote("Explain this", undefined)).toBe("Explain this");
    expect(withQuote("Explain this", "one\ntwo")).toBe("Explain this\n\nThe text I selected:\n> one\n> two");
  });

  it("renders the chip and the disclosure with its Follow switch, pinned or following", () => {
    const chip = (following: boolean) => renderToStaticMarkup(<ContextChip kind="Screen" label="List · DEVOPS" following={following} open onToggle={vi.fn()} />);
    expect(chip(true)).toContain("List · DEVOPS");
    expect(chip(true)).toContain('aria-expanded="true"');
    expect(chip(false)).toContain("Pinned: List · DEVOPS");
    const panel = (following: boolean) => renderToStaticMarkup(<SeeingPanel lines={["Screen: Settings"]} following={following} onFollow={vi.fn()} />);
    expect(panel(true)).toContain("What I can see right now");
    expect(panel(true)).toContain("Screen: Settings");
    expect(panel(true)).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(panel(false)).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(panel(false)).toContain("I keep this even as you move around");
  });
});

describe("filters Pip applied, in the conversation", () => {
  it("undoes and redoes a filter on the tab it went to, and stops offering once the tab changed", () => {
    const tab = useTabs.getState().tabs[0];
    usePip.getState().applyFilter({ type: "blocked" }, "Blocked", "r1");
    const applied = () => usePip.getState().applied.r1;
    expect(appliedState(applied(), useTabs.getState().tabs)).toBe("applied");

    usePip.getState().undoApplied("r1");
    expect(useTabs.getState().tabs[0].filter).toEqual(tab.filter);
    expect(appliedState(applied(), useTabs.getState().tabs)).toBe("undone");
    expect(usePip.getState().filtered).toBeNull();

    usePip.getState().redoApplied("r1");
    expect(useTabs.getState().tabs[0].filter).toEqual({ type: "blocked" });
    expect(usePip.getState().filtered).toMatchObject({ requestId: "r1" });

    useTabs.getState().addFilter({ type: "mine" });
    expect(appliedState(applied(), useTabs.getState().tabs)).toBe("changed");
    expect(appliedState(applied(), [])).toBe("gone");
  });

  it("renders Undo, Redo, or nothing to press", () => {
    const card = (state: Parameters<typeof AppliedCard>[0]["state"]) => renderToStaticMarkup(<AppliedCard note="Blocked tickets" state={state} onAct={vi.fn()} />);
    expect(card("applied")).toContain("View updated");
    expect(card("applied")).toContain("Undo");
    expect(card("undone")).toContain("View restored");
    expect(card("undone")).toContain("Redo");
    expect(card("changed")).not.toContain("<button");
    expect(card("changed")).toContain("You changed it since");
  });
});

describe("draft previews", () => {
  const proposal = (over: Partial<Proposal>): Proposal => ({
    id: "p1",
    createdAt: "2026-09-30T10:00:00Z",
    updatedAt: "2026-09-30T10:00:00Z",
    origin: { type: "chat", requestId: "r" },
    createdBy: "pip",
    intent: { type: "comment", item: { connectionId: "mock", externalId: "DEVOPS-471", key: "DEVOPS-471" }, body: docFromText("Looks good.") },
    label: null,
    basis: null,
    state: { type: "pending" },
    revisions: [],
    created: [],
    error: null,
    run: null,
    ...over,
  });
  const show = (p: Proposal) => renderToStaticMarkup(<DraftPreview proposal={p} statusName={null} targetTitle="Rotate keys" onOpen={vi.fn()} />);

  it("shows a pending draft with its kind, body, revision note and where to review it", () => {
    const out = show(proposal({ revisions: [{ at: "2026-09-30T11:00:00Z", note: "Byron followed up, so I extended the reply" } as never] }));
    expect(out).toContain("Comment on DEVOPS-471");
    expect(out).toContain("Draft");
    expect(out).toContain("Looks good.");
    expect(out).toContain("↻ Byron followed up");
    expect(out).toContain("Review on DEVOPS-471 →");
    expect(out).toContain("bg-ws-pip-soft");
  });

  it("colours a finished draft green, dims a skipped one and explains one that went out of date", () => {
    expect(show(proposal({ state: { type: "applied" } }))).toMatch(/bg-ws-done-soft[^>]*>.*Done/s);
    expect(show(proposal({ state: { type: "applied" } }))).toContain("Open DEVOPS-471 →");
    expect(show(proposal({ state: { type: "skipped" } }))).toContain("opacity-45");
    const retired = show(proposal({ state: { type: "retired", reason: "The ticket moved on" } }));
    expect(retired).toContain("Out of date");
    expect(retired).toContain("✕ The ticket moved on");
  });

  it("writes what each kind would do", () => {
    const item = { connectionId: "mock", externalId: "DEVOPS-471", key: "DEVOPS-471" };
    expect(draftPreviewBody(proposal({ intent: { type: "subtasks", parent: item, summaries: ["One", "Two"] } }), null)).toBe("• One\n• Two");
    expect(draftPreviewBody(proposal({ intent: { type: "transition", item, to: "done" } as never }), "Done")).toBe("Move DEVOPS-471 to Done");
  });
});

describe("the avatar and launcher", () => {
  it("has blinking lids, pupils to follow the pointer and legs in the second Pip colour", () => {
    const out = renderToStaticMarkup(<PipAvatar />);
    expect(out).toContain("pip-lids");
    expect(out.match(/pip-pup/g)).toHaveLength(2);
    expect(out).toContain("pip-legs");
    expect(out).not.toContain("data-thinking");
    expect(out).not.toContain("pip-dangle");
  });

  it("scuttles while thinking and dangles when asked to", () => {
    const out = renderToStaticMarkup(<PipAvatar thinking dangle />);
    expect(out).toContain('data-thinking=""');
    expect(out).toContain("pip-dangle");
  });

  it("hangs the launcher from a thread, with the one count of what needs the person", () => {
    const out = renderToStaticMarkup(<Launcher needs={3} onOpen={vi.fn()} />);
    expect(out).toContain("pip-thread");
    expect(out).toContain("pip-dangle");
    expect(out).toContain("Ask Pip, 3 things need you");
  });
});

describe("eyes, the Ask Pip button and Esc", () => {
  it("leans the pupils toward the target by distance, up to a limit", () => {
    const eye = { x: 100, y: 100 };
    expect(pupilOffset(eye, { x: 100, y: 100 })).toEqual({ x: 0, y: 0 });
    const right = pupilOffset(eye, { x: 130, y: 100 });
    expect(right.x).toBeCloseTo(0.5);
    expect(right.y).toBeCloseTo(0);
    const far = pupilOffset(eye, { x: 100, y: 1000 });
    expect(far.x).toBeCloseTo(0);
    expect(far.y).toBeCloseTo(1.5);
  });

  it("puts the button above the selection and keeps it on screen", () => {
    expect(askPlacement({ left: 200, top: 300 }, 1000)).toEqual({ x: 200, y: 268 });
    expect(askPlacement({ left: 990, top: 300 }, 1000)).toEqual({ x: 880, y: 268 });
    expect(askPlacement({ left: -40, top: 10 }, 1000)).toEqual({ x: 8, y: 8 });
    expect(renderToStaticMarkup(<AskPipButton x={12} y={34} onAsk={vi.fn()} />)).toContain("Ask Pip");
  });

  it("closes the pane on Esc unless a peek or ticked cards come first or someone is typing elsewhere", () => {
    const calm = { peekOpen: false, ticked: false, editing: false, inPipInput: false, handled: false };
    expect(escapeClosesPane(calm)).toBe(true);
    expect(escapeClosesPane({ ...calm, peekOpen: true })).toBe(false);
    expect(escapeClosesPane({ ...calm, ticked: true })).toBe(false);
    expect(escapeClosesPane({ ...calm, handled: true })).toBe(false);
    expect(escapeClosesPane({ ...calm, editing: true })).toBe(false);
    expect(escapeClosesPane({ ...calm, editing: true, inPipInput: true })).toBe(true);
  });

  it("lets Esc from Pip's input reach the peek over it, so the peek closes first and the next Esc closes Pip (N4)", () => {
    class FakeHTMLElement {
      constructor(readonly tagName: string, readonly id = "", readonly isContentEditable = false) {}
    }
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    try {
      expect(typingIn(new FakeHTMLElement("TEXTAREA", "pip-input") as unknown as Element)).toBe(false);
      expect(typingIn(new FakeHTMLElement("TEXTAREA", "comment-box") as unknown as Element)).toBe(true);
      expect(typingIn(new FakeHTMLElement("DIV", "", true) as unknown as Element)).toBe(true);
      expect(typingIn(new FakeHTMLElement("BUTTON") as unknown as Element)).toBe(false);
      expect(typingIn(null)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    // With the peek open the pane leaves Esc to it, from Pip's input too.
    expect(escapeClosesPane({ peekOpen: true, ticked: false, editing: true, inPipInput: true, handled: false })).toBe(false);
  });
});
