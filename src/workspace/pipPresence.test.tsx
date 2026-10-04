import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { withQuote } from "../claudeStore";
import { docFromText } from "../lib/docs";
import { ALL } from "../lib/filter";
import type { Proposal, ScreenContext } from "../types";
import { useWorkspace } from "../workspaceStore";
import { DraftPreview, draftPreviewBody } from "./DraftPreview";
import { AskPipButton, askPlacement, fireNudge, Launcher, Nudge } from "./PipExtras";
import { AppliedCard, ContextChip, escapeClosesPane, SeeingPanel } from "./PipPane";
import { PipAvatar } from "./PipAvatar";
import { pupilOffset } from "./pipGaze";
import { itemScene, STALE_DAYS } from "./pipScene";
import { appliedState, usePip } from "./pipStore";
import { contextLabel, contextLines } from "./screenContext";
import { suggestionsFor, type SuggestionScene } from "./suggestions";
import { loadTabs, useTabs } from "./tabsStore";

const ws = () => useWorkspace.getState();
const world = (now = Date.now()) => ({ items: ws().items, needsMe: ws().needsMe, names: ws().names, me: ws().me, now });

beforeEach(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  useTabs.setState(loadTabs());
  useTabs.getState().setFilter(ALL);
  usePip.setState({ filtered: null, applied: {}, dismissed: [], seen: [], nudge: null, lastNudgeAt: 0, pinned: null, quote: null, prefill: null });
  await ws().init(new MockBackend());
});

describe("what Pip can tell about a ticket", () => {
  it("knows what holds a ticket up and that a finished one has nothing to say", () => {
    const blocked = itemScene(ws().items["mock:DEVOPS-473"], world());
    expect(blocked.blockedBy).toBe("DEVOPS-490");
    expect(blocked.linked).toBe(true);
    const done = Object.values(ws().items).find((i) => i.status.category === "done")!;
    expect(itemScene(done, world())).toMatchObject({ open: false, staleDays: null, blockedBy: null, waitingOn: null, unassigned: false });
  });

  it("counts quiet days from the last update once they reach the stale limit", () => {
    const item = Object.values(ws().items).find((i) => i.status.category !== "done")!;
    const day = 86_400_000;
    const at = Date.parse(item.updated);
    expect(itemScene(item, world(at + (STALE_DAYS - 1) * day)).staleDays).toBeNull();
    expect(itemScene(item, world(at + (STALE_DAYS + 2) * day)).staleDays).toBe(STALE_DAYS + 2);
  });

  it("says who is waiting when the ticket needs the user, naming the last commenter", () => {
    const item = Object.values(ws().items).find((i) => i.status.category !== "done" && i.lastCommenter)!;
    const key = `${item.item.connectionId}:${item.item.externalId}`;
    const scene = itemScene(item, { ...world(), needsMe: new Set([key]), me: [] });
    expect(scene.waitingOn).toBe(ws().names[item.lastCommenter!.accountId] ?? item.lastCommenter!.accountId);
    expect(itemScene(item, { ...world(), needsMe: new Set(), me: [] }).waitingOn).toBeNull();
  });
});

describe("suggestion chips", () => {
  const base: SuggestionScene = { route: "workspace", quote: false, marked: 0, item: null, pendingDrafts: 0, itemDrafts: 0, unassignedInView: 0, shown: 10, filtered: false };
  const item = { key: "DEVOPS-9", open: true, staleDays: null, blockedBy: null, waitingOn: null, unassigned: false, linked: false };

  it("offers the usual view questions, and more when drafts wait or tickets have no owner", () => {
    expect(suggestionsFor(base)).toEqual(["Show stale tickets", "What is blocked?", "Show my tickets", "Catch me up"]);
    expect(suggestionsFor({ ...base, pendingDrafts: 2, unassignedInView: 1 })).toEqual(["Show stale tickets", "What is blocked?", "Show unassigned tickets", "Which drafts are safe to approve?", "Catch me up"]);
    expect(suggestionsFor({ ...base, shown: 0, filtered: true })[0]).toBe("Why is this empty?");
  });

  it("follows the open ticket's state", () => {
    expect(suggestionsFor({ ...base, item })).toEqual(["What do I need to do here?", "Draft a comment on this one", "Break into subtasks", "Draft a description update", "Create a follow-up ticket"]);
    const busy = suggestionsFor({ ...base, itemDrafts: 1, item: { ...item, waitingOn: "Byron", blockedBy: "X-1", unassigned: true } });
    expect(busy).toContain("Draft a reply");
    expect(busy).toContain("Show the dependency chain");
    expect(busy).toContain("Suggest an owner");
    expect(busy.length).toBeLessThanOrEqual(6);
    expect(suggestionsFor({ ...base, item: { ...item, staleDays: 8 } })).toContain("Draft a nudge");
    expect(suggestionsFor({ ...base, item: { ...item, open: false } })).not.toContain("Break into subtasks");
    expect(suggestionsFor({ ...base, item: { ...item, open: false } })).not.toContain("Draft a description update");
    expect(busy).not.toContain("Draft a description update");
  });

  it("switches to questions about selected text, the feed, settings and ticked cards", () => {
    expect(suggestionsFor({ ...base, quote: true, item })).toEqual(["Explain this", "Turn this into a ticket", "Turn this into a subtask"]);
    expect(suggestionsFor({ ...base, route: "activity", pendingDrafts: 1 })).toEqual(["Which drafts are safe to approve?", "What happened today?", "What needs my reply?"]);
    expect(suggestionsFor({ ...base, route: "settings", item })).toEqual(["What can you do for me?"]);
    expect(suggestionsFor({ ...base, marked: 2 })[0]).toBe("Summarise the ticked tickets");
  });
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

  it("hangs the launcher from a thread, with a count of waiting drafts", () => {
    const out = renderToStaticMarkup(<Launcher drafts={3} onOpen={vi.fn()} nudge={null} />);
    expect(out).toContain("pip-thread");
    expect(out).toContain("pip-dangle");
    expect(out).toContain("3 drafts waiting");
  });

  it("shows a suggestion bubble that can be opened or closed", () => {
    const out = renderToStaticMarkup(<Nudge text="DEVOPS-9 has been quiet for 9 days." onOpen={vi.fn()} onDismiss={vi.fn()} />);
    expect(out).toContain("DEVOPS-9 has been quiet for 9 days.");
    expect(out).toContain("Dismiss suggestion");
  });
});

describe("showing a suggestion", () => {
  const nudge = (text: string) => ({ id: "unassigned-view", kind: "unassigned-view" as const, text, action: { type: "open" as const } });

  it("shows the candidate it is given, with the text it has now, and counts it as seen", () => {
    fireNudge([nudge("5 tickets here have no owner. Want me to show them?")], 100, false);
    expect(usePip.getState()).toMatchObject({ nudge: { text: "5 tickets here have no owner. Want me to show them?" }, lastNudgeAt: 100, seen: ["unassigned-view"] });
  });

  it("stays quiet while one is up, while the page is hidden and for one the person closed", () => {
    fireNudge([nudge("a")], 1, true);
    expect(usePip.getState().nudge).toBeNull();
    usePip.getState().dismiss("unassigned-view");
    fireNudge([nudge("a")], 1, false);
    expect(usePip.getState().nudge).toBeNull();
    usePip.setState({ dismissed: [] });
    fireNudge([nudge("first")], 2, false);
    fireNudge([{ ...nudge("second"), id: "other" }], 3, false);
    expect(usePip.getState().nudge?.text).toBe("first");
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
});
