import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import { useClaude, type Turn } from "../claudeStore";
import { docFromText } from "../lib/docs";
import type { Intent, Proposal, RunSpec } from "../types";
import { useWorkspace } from "../workspaceStore";
import { draftDecisions } from "./DraftPreview";
import { DRAFT_CARD, onDraftCardKey, stepDraftCards, upToNewestDraft } from "./draftKeys";
import { Composer, PipConversation, WORKSPACE_CONVERSATION } from "./PipConversation";
import { WORKSPACE_CONVERSATION as FROM_PANE, PIP_INPUT_ID } from "./PipPane";

const spec: RunSpec = { kind: "investigate", repo: "acme/web", clonePath: "/Users/sample/Code/web", base: "main", name: "ca-412-fix-ab12", instruction: "Investigate this work." };

const draft = (id: string, intent: Intent, over: Partial<Proposal> = {}): Proposal => ({
  id,
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  origin: { type: "board" },
  createdBy: "pip",
  intent,
  label: null,
  basis: null,
  state: { type: "pending" },
  revisions: [],
  created: [],
  error: null,
  run: null,
  ...over,
});

const comment = (id: string, requestId: string | null, over: Partial<Proposal> = {}) =>
  draft(id, { type: "comment", item: itemRef("CA-412"), body: docFromText(`Comment ${id}`) }, { origin: requestId ? { type: "chat", requestId } : { type: "board" }, ...over });

const turn = (requestId: string, prompt: string, text: string): Turn => ({ requestId, prompt, steps: ["Looked up CA-412"], text, status: "done", error: null });

/** The cards in the order the markup has them, as the key handlers see them. */
function cardsIn(html: string) {
  return [...html.matchAll(/<article[^>]*data-draft="([^"]+)" data-state="([^"]+)"/g)].map(([, id, state]) => ({
    id,
    focus: vi.fn(),
    scrollIntoView: vi.fn(),
    matches: (sel: string) => sel === DRAFT_CARD,
    getAttribute: (name: string) => (name === "data-state" ? state : null),
  }));
}
/** Static rendering reads a store's initial state, so what a test sets is copied there, as the other render tests do. */
const initialTurns = useClaude.getInitialState().byTicket;
const setTurns = (byTicket: ReturnType<typeof useClaude.getState>["byTicket"]) => {
  useClaude.setState({ byTicket });
  useClaude.getInitialState().byTicket = byTicket;
};

const rootOf = (cards: object[]) => ({ querySelectorAll: (sel: string) => (sel === DRAFT_CARD ? cards : []) });
const key = (k: string, target: unknown, currentTarget: unknown = target) => ({ key: k, target, currentTarget, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn() });

describe("PipConversation", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    setTurns({});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setTurns(initialTurns);
  });

  it("is still what the pane exports for the conversation and its input", () => {
    expect(FROM_PANE).toBe(WORKSPACE_CONVERSATION);
    expect(PIP_INPUT_ID).toBe("pip-input");
  });

  it("renders its turns, the drafts they made and drafts from before, on its own", () => {
    setTurns({ [WORKSPACE_CONVERSATION]: { sessionId: "s1", turns: [turn("r1", "Draft a comment on CA-412", "I drafted a short comment.")] } });
    const proposals = [comment("p-old", null), comment("p-new", "r1")];
    const html = renderToStaticMarkup(<PipConversation conversation={WORKSPACE_CONVERSATION} proposals={proposals} />);
    expect(html).toContain("Draft a comment on CA-412");
    expect(html).toContain("I drafted a short comment.");
    expect(html).toContain('aria-label="Drafts"');
    expect(html).toMatch(/Drafts waiting <span class="font-normal">1<\/span>/);
    expect(html.indexOf('data-draft="p-old"')).toBeLessThan(html.indexOf("Draft a comment on CA-412"));
    expect(html.indexOf('data-draft="p-new"')).toBeGreaterThan(html.indexOf("I drafted a short comment."));
    expect(html).not.toContain("I follow along as you move around");
  });

  it("shows the welcome line with no turns, and reads another conversation by its key", () => {
    setTurns({ "CA-9": { sessionId: null, turns: [turn("r9", "Other question", "Other answer")] } });
    const empty = renderToStaticMarkup(<PipConversation conversation={WORKSPACE_CONVERSATION} proposals={[]} />);
    expect(empty).toContain("I follow along as you move around");
    expect(empty).not.toContain("Other question");
    expect(renderToStaticMarkup(<PipConversation conversation="CA-9" proposals={[]} />)).toContain("Other answer");
  });

  it("makes each draft card a focusable stop that names its keys, with no hint until focused", () => {
    setTurns({ [WORKSPACE_CONVERSATION]: { sessionId: null, turns: [turn("r1", "Q", "A")] } });
    const run = draft("p-run", { type: "startRun", connectionId: "mock", item: itemRef("CA-412"), spec }, { origin: { type: "chat", requestId: "r1" } });
    const html = renderToStaticMarkup(<PipConversation conversation={WORKSPACE_CONVERSATION} proposals={[comment("p1", "r1"), run]} />);
    expect(html).toMatch(/<article[^>]*data-draft="p1"[^>]*tabindex="0"[^>]*aria-keyshortcuts="a s Enter o"[^>]*class="[^"]*focus-visible:outline-ws-pip/);
    expect(html).toMatch(/<article[^>]*data-draft="p-run"[^>]*tabindex="0"/);
    expect(html).not.toContain("a approve");
    // outline-none would stop focus-visible:outline-2 from drawing the ring at all (Tailwind 4 sets the style to none).
    expect(html).not.toMatch(/<article[^>]*class="[^"]*(?<![\w:-])outline-none/);
  });

  describe("with a queue", () => {
    const at = (requestId: string, prompt: string, status: Turn["status"], error: string | null = null): Turn => ({ requestId, prompt, steps: [], text: "", status, error });
    const attached = { images: [], add: async () => {}, remove: () => {}, take: () => [] } as unknown as Parameters<typeof Composer>[0]["attached"];
    const composer = () =>
      renderToStaticMarkup(<Composer conversation={WORKSPACE_CONVERSATION} attached={attached} chips={["What is stale?"]} looking="the board" scene={{ itemKey: null, route: "workspace", runOpen: false }} />);

    it("shows a queued question with when it runs and a way to remove it", () => {
      setTurns({ [WORKSPACE_CONVERSATION]: { sessionId: null, turns: [at("r1", "First", "running"), at("r2", "Second", "queued")] } });
      const html = renderToStaticMarkup(<PipConversation conversation={WORKSPACE_CONVERSATION} proposals={[]} />);
      expect(html.match(/Queued, runs after the current answer/g)).toHaveLength(1);
      expect(html.indexOf("Queued, runs after")).toBeGreaterThan(html.indexOf("Second"));
      expect(html.match(/aria-label="Remove this question"/g)).toHaveLength(1);
      expect(html.match(/Looking at/g)).toHaveLength(1);
    });

    it("says a question queued behind another queued one runs after that one, not after the current answer", () => {
      setTurns({ [WORKSPACE_CONVERSATION]: { sessionId: null, turns: [at("r1", "First", "running"), at("r2", "Second", "queued"), at("r3", "Third", "queued")] } });
      const html = renderToStaticMarkup(<PipConversation conversation={WORKSPACE_CONVERSATION} proposals={[]} />);
      expect(html.match(/Queued, runs after the current answer/g)).toHaveLength(1);
      expect(html.match(/Queued, runs after the question before it/g)).toHaveLength(1);
      expect(html.indexOf("Queued, runs after the current answer")).toBeLessThan(html.indexOf("Third"));
      expect(html.indexOf("Queued, runs after the question before it")).toBeGreaterThan(html.indexOf("Third"));
    });

    it("says quietly that a removed question never ran, without an alert", () => {
      setTurns({ [WORKSPACE_CONVERSATION]: { sessionId: null, turns: [at("r1", "Gone", "failed", "Removed before it started"), at("r2", "Broke", "failed", "Claude isn't installed")] } });
      const html = renderToStaticMarkup(<PipConversation conversation={WORKSPACE_CONVERSATION} proposals={[]} />);
      expect(html).toContain("Removed before it started");
      expect(html.match(/role="alert"/g)).toHaveLength(1);
      expect(html).not.toContain('aria-label="Remove this question"');
    });

    it("keeps the input and Ask next to Stop while Pip answers, and the chips until a question waits", () => {
      setTurns({ [WORKSPACE_CONVERSATION]: { sessionId: null, turns: [at("r1", "First", "running")] } });
      const running = composer();
      expect(running).toMatch(/>Stop<\/button><button type="submit"[^>]*>Ask<\/button>/);
      expect(running).toContain("What is stale?");
      expect(running).not.toMatch(/<input id="pip-input"[^>]*disabled/);
      setTurns({ [WORKSPACE_CONVERSATION]: { sessionId: null, turns: [at("r1", "First", "running"), at("r2", "Second", "queued")] } });
      expect(composer()).not.toContain("What is stale?");
      setTurns({ [WORKSPACE_CONVERSATION]: { sessionId: null, turns: [at("r1", "First", "done")] } });
      const idle = composer();
      expect(idle).not.toContain(">Stop<");
      expect(idle).toContain(">Ask</button>");
    });
  });

  describe("from the keyboard", () => {
    const approve = vi.fn();
    const skip = vi.fn();
    const report = vi.fn();
    const pending = new Map<string, (p: Proposal) => void>();

    beforeEach(() => {
      approve.mockReset().mockImplementation((id: string) => new Promise<Proposal>((done) => pending.set(id, done)));
      skip.mockReset().mockImplementation(async (id: string) => comment(id, null, { state: { type: "skipped" } }));
      report.mockReset();
      useWorkspace.setState({ approve, skip, report });
    });

    const render = (proposals: Proposal[], turns: Turn[]) => {
      setTurns({ [WORKSPACE_CONVERSATION]: { sessionId: null, turns } });
      return cardsIn(renderToStaticMarkup(<PipConversation conversation={WORKSPACE_CONVERSATION} proposals={proposals} />));
    };

    it("approves a focused comment card once on a then Enter, and skips one on s then Enter", async () => {
      const p = comment("p1", "r1");
      const [card] = render([p], [turn("r1", "Q", "A")]);
      const act = { ...draftDecisions(p.id), open: vi.fn(), ask: vi.fn() };
      expect(onDraftCardKey(key("a", card), p, null, act)).toBe(true);
      expect(act.ask).toHaveBeenLastCalledWith("approve");
      expect(approve).not.toHaveBeenCalled();
      expect(onDraftCardKey(key("Enter", card), p, "approve", act)).toBe(true);
      onDraftCardKey(key("Enter", card), p, "approve", act);
      expect(approve).toHaveBeenCalledTimes(1);
      expect(approve).toHaveBeenCalledWith("p1");
      pending.get("p1")!({ ...p, state: { type: "applied" } });
      // The approval settles before the next decision on the same draft is taken.
      await new Promise((done) => setTimeout(done, 0));
      expect(onDraftCardKey(key("s", card), p, null, act)).toBe(true);
      expect(skip).not.toHaveBeenCalled();
      expect(onDraftCardKey(key("Enter", card), p, "skip", act)).toBe(true);
      expect(skip).toHaveBeenCalledTimes(1);
      expect(skip).toHaveBeenCalledWith("p1");
      expect(act.open).not.toHaveBeenCalled();
    });

    it("reports a draft that failed to apply, and a refusal, through the workspace", async () => {
      const p = comment("p2", "r1");
      approve.mockImplementationOnce(async () => ({ ...p, error: "Jira said no" }));
      draftDecisions(p.id).approve();
      await vi.waitFor(() => expect(report).toHaveBeenCalledWith("Couldn't approve that draft", "Jira said no"));
      skip.mockImplementationOnce(async () => Promise.reject(new Error("offline")));
      draftDecisions(p.id).skip();
      await vi.waitFor(() => expect(report).toHaveBeenCalledWith("Couldn't skip that draft", expect.any(Error)));
    });

    it("opens a run draft on a and approves nothing", () => {
      const run = draft("p-run", { type: "startRun", connectionId: "mock", item: itemRef("CA-412"), spec }, { origin: { type: "chat", requestId: "r1" } });
      const [card] = render([run], [turn("r1", "Q", "A")]);
      const act = { ...draftDecisions(run.id), open: vi.fn(), ask: vi.fn() };
      onDraftCardKey(key("a", card), run, null, act);
      onDraftCardKey(key("Enter", card), run, "approve", act);
      expect(act.open).toHaveBeenCalledTimes(2);
      expect(act.ask).not.toHaveBeenCalledWith("approve");
      expect(approve).not.toHaveBeenCalled();
    });

    it("leaves cards alone for keys typed in the input", () => {
      const p = comment("p1", "r1");
      const cards = render([p], [turn("r1", "Q", "A")]);
      const input = { id: PIP_INPUT_ID, matches: () => false };
      const act = { ...draftDecisions(p.id), open: vi.fn(), ask: vi.fn() };
      for (const k of ["a", "s", "Enter", "o"]) expect(onDraftCardKey(key(k, input, cards[0]), p, null, act)).toBe(false);
      expect(onDraftCardKey(key("Enter", input, cards[0]), p, "approve", act)).toBe(false);
      for (const k of ["ArrowDown", "ArrowUp", "j", "k"]) expect(stepDraftCards(key(k, input), rootOf(cards))).toBe(false);
      expect(upToNewestDraft(key("ArrowUp", input), "as", rootOf(cards))).toBe(false);
      expect(approve).not.toHaveBeenCalled();
      expect(skip).not.toHaveBeenCalled();
      expect(cards[0].focus).not.toHaveBeenCalled();
    });

    it("goes from the empty input up to the newest pending card, then between cards", () => {
      const cards = render(
        [comment("p-old", null), comment("p1", "r1"), comment("p2", "r2"), comment("p3", "r2", { state: { type: "applied" } })],
        [turn("r1", "First", "A"), turn("r2", "Second", "B")],
      );
      expect(cards.map((c) => c.id)).toEqual(["p-old", "p1", "p2", "p3"]);
      expect(upToNewestDraft(key("ArrowUp", null), "", rootOf(cards))).toBe(true);
      expect(cards[2].focus).toHaveBeenCalledTimes(1);
      stepDraftCards(key("ArrowUp", cards[2]), rootOf(cards));
      expect(cards[1].focus).toHaveBeenCalledTimes(1);
      stepDraftCards(key("k", cards[1]), rootOf(cards));
      expect(cards[0].focus).toHaveBeenCalledTimes(1);
      stepDraftCards(key("ArrowDown", cards[0]), rootOf(cards));
      expect(cards[1].focus).toHaveBeenCalledTimes(2);
      stepDraftCards(key("j", cards[1]), rootOf(cards));
      stepDraftCards(key("ArrowDown", cards[2]), rootOf(cards));
      expect(cards[3].focus).toHaveBeenCalledTimes(1);
    });
  });
});
