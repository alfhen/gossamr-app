import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import { useClaude, type Turn } from "../claudeStore";
import { docFromText } from "../lib/docs";
import type { Intent, Proposal, RunSpec, WorkstreamView, Run, WorkContainer, WorkItem } from "../types";
import { useWorkspace } from "../workspaceStore";
import { draftDecisions } from "./DraftPreview";
import { DRAFT_CARD, onDraftCardKey, stepDraftCards, upToNewestDraft } from "./draftKeys";
import { Composer, ComposerFooter, GENERAL_CONVERSATION, PipConversation, draftsForTicket, otherTicketsRow, openWakeRun, keepUnsentInput, unsentInputOf, wakeHeader, wakeIsLong, wakeParts, workstreamConversation, workstreamIntro } from "./PipConversation";
import { useWorkView } from "./workViewStore";
import { useTabs } from "./tabsStore";
import { useRuns } from "./runsStore";
import { useWorkstreams } from "./workstreamsStore";
import { MockBackend } from "../backend/mock";
import { GENERAL_CONVERSATION as FROM_PANE, PIP_INPUT_ID } from "./PipPane";
import { Markdown } from "../components/Markdown";
import { TicketLinksContext } from "../components/ticketLinks";
import { knownTicketTitle, workspaceTicketLinks } from "./jump";

const spec: RunSpec = { role: "investigate", repo: "acme/web", clonePath: "/Users/sample/Code/web", base: "main", name: "ca-412-fix-ab12", brief: "Investigate this work." };

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
    expect(FROM_PANE).toBe(GENERAL_CONVERSATION);
    expect(GENERAL_CONVERSATION).toBe("general");
    expect(workstreamConversation("ws-7")).toBe("ws:ws-7");
    expect(PIP_INPUT_ID).toBe("pip-input");
  });

  it("in a pane about one ticket, lists that ticket's drafts and folds the rest into one '+N drafts on other tickets' row (D22)", () => {
    const other = (id: string, key: string) => draft(id, { type: "comment", item: itemRef(key), body: docFromText(`Comment ${id}`) });
    const drafts = [comment("c1", null), other("o1", "DEVOPS-471"), comment("c2", null), other("o2", "WEB-101")];
    expect(draftsForTicket(drafts, itemRef("CA-412"))).toEqual({ shown: [drafts[0], drafts[2]], others: [drafts[1], drafts[3]] });
    expect(draftsForTicket(drafts, null)).toEqual({ shown: drafts, others: [] });
    // A ticket moved to another project keeps its id but not its key: its drafts still belong to it.
    const moved = { ...itemRef("CA-412"), key: "WEB-9" };
    expect(draftsForTicket(drafts, moved)).toEqual({ shown: [drafts[0], drafts[2]], others: [drafts[1], drafts[3]] });
    expect([otherTicketsRow(1), otherTicketsRow(2)]).toEqual(["+1 draft on other tickets", "+2 drafts on other tickets"]);

    const html = renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={drafts} ticket={itemRef("CA-412")} />);
    expect(cardsIn(html).map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(html).toMatch(/Drafts waiting <span class="font-normal">4<\/span>/);
    expect(html).toMatch(/<button type="button" data-other-tickets="true" aria-expanded="false"[^>]*><span aria-hidden="true">▸ <\/span>\+2 drafts on other tickets<\/button>/);
    // With no ticket in view, every draft is listed and nothing is folded.
    const all = renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={drafts} />);
    expect(cardsIn(all).map((c) => c.id)).toEqual(["c1", "o1", "c2", "o2"]);
    expect(all).not.toContain("data-other-tickets");
  });

  it("shows a workstream's conversation apart from General", () => {
    setTurns({ [GENERAL_CONVERSATION]: { sessionId: null, turns: [turn("g1", "A General question", "A")] }, [workstreamConversation("ws-1")]: { sessionId: null, turns: [turn("w1", "A workstream question", "B")] } });
    const general = renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={[]} />);
    const ws = renderToStaticMarkup(<PipConversation conversation={workstreamConversation("ws-1")} proposals={[]} />);
    expect(general).toContain("A General question");
    expect(general).not.toContain("A workstream question");
    expect(ws).toContain("A workstream question");
    expect(ws).not.toContain("A General question");
  });

  it("shows a wake turn under a muted line naming the run that woke Pip, with no question bubble", () => {
    const runs = new MockBackend({ runs: { seed: "busy" } }).runs.list();
    const [a, b] = runs.slice(0, 2).map((r, i) => ({ ...r, id: `run-${i + 1}`, queuedAt: `2026-09-30T1${i}:00:00Z`, spec: { ...r.spec, workstream: "ws-1" } }));
    useRuns.setState({ runs: [a, b] });
    useRuns.getInitialState().runs = [a, b];
    const wake: Turn = { requestId: "wake-1", kind: "wake", prompt: `[Event] run ${b.id} (triage) Done; plan recommended: yes`, steps: [], text: "R2 finished. I drafted a plan for you to start.", status: "done", error: null };
    setTurns({ [workstreamConversation("ws-1")]: { sessionId: "s1", turns: [turn("q1", "Investigate it", "Drafted."), wake] } });
    const html = renderToStaticMarkup(<PipConversation conversation={workstreamConversation("ws-1")} proposals={[]} />);
    useRuns.getInitialState().runs = [];
    expect(html.match(/data-turn-kind="wake"/g)).toHaveLength(1);
    expect(html.replace(/<[^>]+>/g, "")).toContain("Pip picked this up: run R2 finished");
    // The run is named by a button that opens it.
    expect(html).toMatch(/<button type="button" data-wake-run="run-2"[^>]*>run R2<\/button> finished/);
    expect(html).toContain("I drafted a plan for you to start.");
    expect(html).not.toContain("[Event]");
    expect(html.match(/bg-ws-accent-soft px-3/g)).toHaveLength(1);
  });

  it("keeps a wake turn compact: a long answer is clamped to about three lines behind Show more, then its cards", () => {
    const runs = new MockBackend({ runs: { seed: "busy" } }).runs.list();
    const r = { ...runs[0], id: "run-9", spec: { ...runs[0].spec, workstream: "ws-1" } };
    useRuns.setState({ runs: [r] });
    useRuns.getInitialState().runs = [r];
    const long = ["R1 finished.", "It found the rounding.", "Triage R2 is queued.", "Plan follows.", "Nothing needs you yet."].join("\n\n");
    const short: Turn = { requestId: "wake-s", kind: "wake", prompt: "[Event] run run-9 (investigate) Done", steps: [], text: "R1 finished.", status: "done", error: null };
    const wake: Turn = { requestId: "wake-l", kind: "wake", prompt: "[Event] run run-9 (investigate) Done", steps: [], text: long, status: "done", error: null };
    setTurns({ [workstreamConversation("ws-1")]: { sessionId: "s1", turns: [short, wake] } });
    const proposals = [comment("p-w", "wake-l")];
    const html = renderToStaticMarkup(<PipConversation conversation={workstreamConversation("ws-1")} proposals={proposals} />);
    useRuns.getInitialState().runs = [];
    expect(wakeIsLong(long)).toBe(true);
    expect(wakeIsLong("R1 finished.")).toBe(false);
    expect(html).toMatch(/id="wake-text-wake-l" data-wake-text="true" data-clamped="true" class="[^"]*line-clamp-3/);
    expect(html).not.toMatch(/id="wake-text-wake-s"[^>]*data-clamped/);
    expect(html.match(/>Show more</g)).toHaveLength(1);
    expect(html).toContain('aria-controls="wake-text-wake-l"');
    // Its cards follow the folded text.
    expect(html.indexOf('data-draft="p-w"')).toBeGreaterThan(html.indexOf("wake-text-wake-l"));
  });

  it("opens a wake's run by its sheet over the screen the person is on", () => {
    useTabs.setState({ route: "agents" });
    openWakeRun("run-2");
    expect(useRuns.getState().sheet).toEqual({ type: "run", id: "run-2" });
    expect(useWorkView.getState().focusTarget).toBeNull();
    expect(useTabs.getState().route).toBe("agents");
    useRuns.setState({ sheet: null });
    useTabs.setState({ route: "workspace" });
    openWakeRun("run-2");
    expect(useRuns.getState().sheet).toEqual({ type: "run", id: "run-2" });
    expect(useWorkView.getState().focusTarget).toBeNull();
    expect(useTabs.getState().route).toBe("workspace");
    useRuns.setState({ sheet: null });
  });

  it("adds no turn and changes none when a run moves on to working: ticks are the rail's and the footer's", () => {
    const [base] = new MockBackend({ runs: { seed: "busy" } }).runs.list();
    const queued = { ...base, id: "run-q", state: "queued" as const, spec: { ...base.spec, workstream: "ws-1" } };
    useRuns.setState({ runs: [queued] });
    const conv = workstreamConversation("ws-1");
    setTurns({ [conv]: { sessionId: "s1", turns: [turn("q1", "Investigate it", "Drafted.")] } });
    const before = useClaude.getState().byTicket;
    const turns = before[conv]!.turns;
    useRuns.setState({ runs: [{ ...queued, state: "launching" }] });
    useRuns.setState({ runs: [{ ...queued, state: "working", lastDetail: "Reading the code" }] });
    expect(useClaude.getState().byTicket).toBe(before);
    expect(useClaude.getState().byTicket[conv]!.turns).toBe(turns);
    expect(useClaude.getState().byTicket[conv]!.turns).toHaveLength(1);
    useRuns.setState({ runs: [] });
  });

  it("names a wake's run by its short id outside a workstream's labels, and says how many more woke it", () => {
    expect(wakeHeader("[Event] run 3f9a12bc-77 (build) Failed", new Map())).toBe("Pip picked this up: run 3f9a12bc-77 failed");
    expect(wakeHeader("[Event] a run (investigate) Done\n[Event] run r2 (review) Done; verdict: blocking", new Map([["r2", "R2"]]))).toBe("Pip picked this up: a run finished and 1 more");
    expect(wakeHeader("[Event] run r2 (review) Needs an answer", new Map([["r2", "R2"]]))).toBe("Pip picked this up: run R2 needs you");
    expect(wakeHeader("", new Map())).toBe("Pip picked this up");
    expect(wakeParts("[Event] run r2 (review) Done", new Map([["r2", "R2"]]))).toEqual({ who: "run R2", runId: "r2", rest: " finished" });
    expect(wakeParts("[Event] a run (investigate) Done", new Map())).toEqual({ who: "a run", runId: null, rest: " finished" });
  });

  it("renders its turns, the drafts they made and drafts from before, on its own", () => {
    setTurns({ [GENERAL_CONVERSATION]: { sessionId: "s1", turns: [turn("r1", "Draft a comment on CA-412", "I drafted a short comment.")] } });
    const proposals = [comment("p-old", null), comment("p-new", "r1")];
    const html = renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={proposals} />);
    expect(html).toContain("Draft a comment on CA-412");
    expect(html).toContain("I drafted a short comment.");
    expect(html).toContain('aria-label="Drafts"');
    expect(html).toMatch(/Drafts waiting <span class="font-normal">1<\/span>/);
    expect(html.indexOf('data-draft="p-old"')).toBeLessThan(html.indexOf("Draft a comment on CA-412"));
    expect(html.indexOf('data-draft="p-new"')).toBeGreaterThan(html.indexOf("I drafted a short comment."));
    expect(html).not.toContain("Ask me about a ticket");
  });

  it("shows the welcome line with no turns, and reads another conversation by its key", () => {
    setTurns({ "CA-9": { sessionId: null, turns: [turn("r9", "Other question", "Other answer")] } });
    const empty = renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={[]} />);
    expect(empty).toContain("Ask me about a ticket");
    expect(empty).not.toContain("Other question");
    expect(renderToStaticMarkup(<PipConversation conversation="CA-9" proposals={[]} />)).toContain("Other answer");
  });

  it("makes each draft card a focusable stop that names its keys, with no hint until focused", () => {
    setTurns({ [GENERAL_CONVERSATION]: { sessionId: null, turns: [turn("r1", "Q", "A")] } });
    const run = draft("p-run", { type: "startRun", connectionId: "mock", item: itemRef("CA-412"), spec }, { origin: { type: "chat", requestId: "r1" } });
    const html = renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={[comment("p1", "r1"), run]} />);
    expect(html).toMatch(/<article[^>]*data-draft="p1"[^>]*tabindex="0"[^>]*aria-keyshortcuts="a e d s Enter o"[^>]*class="[^"]*focus-visible:outline-ws-pip/);
    expect(html).toMatch(/<article[^>]*data-draft="p-run"[^>]*tabindex="0"/);
    expect(html).not.toContain("a approve");
    // outline-none would stop focus-visible:outline-2 from drawing the ring at all (Tailwind 4 sets the style to none).
    expect(html).not.toMatch(/<article[^>]*class="[^"]*(?<![\w:-])outline-none/);
  });

  it("opens a workstream's empty conversation with one sentence on what it is for, and General with its own words", () => {
    setTurns({});
    const ws = renderToStaticMarkup(<PipConversation conversation={workstreamConversation("ws-404")} proposals={[]} />);
    expect(ws).toContain("data-empty-workstream");
    const intro = /<p data-empty-workstream="true"[^>]*>([^<]*)<\/p>/.exec(ws)?.[1] ?? "";
    expect(intro).toBe("Everything for this ticket stays here: its agents, drafts and our conversation.");
    expect(ws).not.toContain("/stop");
    expect(ws).not.toContain("Ask me about a ticket");
    const general = renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={[]} />);
    expect(general).toContain("Ask me about a ticket");
    expect(general).not.toContain("data-empty-workstream");
  });

  it("names the workstream's ticket in its intro,", () => {
    setTurns({});
    expect(workstreamIntro({ itemKey: "CA-401", title: "CA-401 Welcome flow refresh" })).toBe("Everything for CA-401 Welcome flow refresh stays here: its agents, drafts and our conversation.");
    expect(workstreamIntro({ itemKey: "CA-401", title: "Welcome flow refresh" })).toBe("Everything for CA-401 Welcome flow refresh stays here: its agents, drafts and our conversation.");
    expect(workstreamIntro({ itemKey: null, title: "Tidy the docs" })).toBe("Everything for Tidy the docs stays here: its agents, drafts and our conversation.");
    const before = useWorkstreams.getInitialState().list;
    const ws: WorkstreamView = {
      workstream: { id: "ws-405", connectionId: "mock", itemKey: "CA-405", repo: null, title: "CA-405 Export fix", pipSession: null, pausedReason: null, notes: null, createdAt: "2026-10-01T10:00:00Z", closedAt: null, basis: null },
      stage: "intake",
      runs: [],
      labels: [],
    };
    try {
      // Rendered on the server, a store is read through its initial state.
      useWorkstreams.getInitialState().list = [ws];
      const html = renderToStaticMarkup(<PipConversation conversation={workstreamConversation("ws-405")} proposals={[]} />);
      expect(html).toContain("Everything for CA-405 Export fix stays here");
      expect(html).not.toContain("fixed rules");
      expect(html).not.toContain("/stop");
      // One sentence.
      expect(/<p data-empty-workstream="true"[^>]*>([^<]*)<\/p>/.exec(html)?.[1].match(/[.!?](\s|$)/g)).toHaveLength(1);
    } finally {
      useWorkstreams.getInitialState().list = before;
    }
  });

  it("keeps unsent text per conversation so one workstream's draft never shows in another", () => {
    const attached = { images: [], add: async () => {}, remove: () => {}, take: () => [] } as unknown as Parameters<typeof Composer>[0]["attached"];
    const a = workstreamConversation("ws-a");
    const b = workstreamConversation("ws-b");
    const render = (conversation: string) => renderToStaticMarkup(<Composer conversation={conversation} attached={attached} looking="the board" scene={{ itemKey: null, route: "agents", runOpen: false, workstream: true }} />);
    try {
      keepUnsentInput(a, "half a thought about A");
      expect(render(a)).toContain('value="half a thought about A"');
      expect(render(b)).not.toContain("half a thought");
      expect(unsentInputOf(b)).toBe("");
      keepUnsentInput(b, "B's own");
      expect(render(b)).toContain("B&#x27;s own");
      expect(unsentInputOf(a)).toBe("half a thought about A");
      keepUnsentInput(a, "");
      expect(unsentInputOf(a)).toBe("");
    } finally {
      keepUnsentInput(a, "");
      keepUnsentInput(b, "");
    }
  });

  it("has no commands: the composer takes only questions for Pip", () => {
    const attached = { images: [], add: async () => {}, remove: () => {}, take: () => [] } as unknown as Parameters<typeof Composer>[0]["attached"];
    const on = renderToStaticMarkup(<Composer conversation={workstreamConversation("ws-1")} attached={attached} looking="the board" scene={{ itemKey: null, route: "agents", runOpen: false, workstream: true }} />);
    expect(on).not.toContain('aria-label="Commands"');
    expect(on).not.toContain("/stop R1");
  });

  describe("with a queue", () => {
    const at = (requestId: string, prompt: string, status: Turn["status"], error: string | null = null): Turn => ({ requestId, prompt, steps: [], text: "", status, error });
    const attached = { images: [], add: async () => {}, remove: () => {}, take: () => [] } as unknown as Parameters<typeof Composer>[0]["attached"];
    const composer = () =>
      renderToStaticMarkup(<Composer conversation={GENERAL_CONVERSATION} attached={attached} looking="the board" scene={{ itemKey: null, route: "workspace", runOpen: false }} />);

    it("renders a footer under the input only when given one, as a muted status line", () => {
      expect(composer()).not.toContain("data-composer-footer");
      const html = renderToStaticMarkup(
        <Composer conversation={GENERAL_CONVERSATION} attached={attached} looking="the board" scene={{ itemKey: null, route: "agents", runOpen: false }} footer="4 agents working · 2 need you" />,
      );
      expect(html).toMatch(/<p data-composer-footer="true" class="[^"]*text-ws-ink3[^"]*">4 agents working · 2 need you<\/p>/);
      expect(html.indexOf("data-composer-footer")).toBeGreaterThan(html.indexOf('id="pip-input"'));
      expect(renderToStaticMarkup(<ComposerFooter text="No agents working · nothing needs you" />)).toContain("No agents working");
    });

    it("shows a queued question with when it runs and a way to remove it", () => {
      setTurns({ [GENERAL_CONVERSATION]: { sessionId: null, turns: [at("r1", "First", "running"), at("r2", "Second", "queued")] } });
      const html = renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={[]} />);
      expect(html.match(/Queued, runs after the current answer/g)).toHaveLength(1);
      expect(html.indexOf("Queued, runs after")).toBeGreaterThan(html.indexOf("Second"));
      expect(html.match(/aria-label="Remove this question"/g)).toHaveLength(1);
      expect(html.match(/Looking at/g)).toHaveLength(1);
    });

    it("says a question queued behind another queued one runs after that one, not after the current answer", () => {
      setTurns({ [GENERAL_CONVERSATION]: { sessionId: null, turns: [at("r1", "First", "running"), at("r2", "Second", "queued"), at("r3", "Third", "queued")] } });
      const html = renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={[]} />);
      expect(html.match(/Queued, runs after the current answer/g)).toHaveLength(1);
      expect(html.match(/Queued, runs after the question before it/g)).toHaveLength(1);
      expect(html.indexOf("Queued, runs after the current answer")).toBeLessThan(html.indexOf("Third"));
      expect(html.indexOf("Queued, runs after the question before it")).toBeGreaterThan(html.indexOf("Third"));
    });

    it("says quietly that a removed question never ran, without an alert", () => {
      setTurns({ [GENERAL_CONVERSATION]: { sessionId: null, turns: [at("r1", "Gone", "failed", "Removed before it started"), at("r2", "Broke", "failed", "Claude isn't installed")] } });
      const html = renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={[]} />);
      expect(html).toContain("Removed before it started");
      expect(html.match(/role="alert"/g)).toHaveLength(1);
      expect(html).not.toContain('aria-label="Remove this question"');
    });

    it("keeps the input and Ask next to Stop while Pip answers", () => {
      setTurns({ [GENERAL_CONVERSATION]: { sessionId: null, turns: [at("r1", "First", "running")] } });
      const running = composer();
      expect(running).toMatch(/>Stop<\/button><button type="submit"[^>]*>Ask<\/button>/);
      expect(running).not.toMatch(/<input id="pip-input"[^>]*disabled/);
      setTurns({ [GENERAL_CONVERSATION]: { sessionId: null, turns: [at("r1", "First", "done")] } });
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
      setTurns({ [GENERAL_CONVERSATION]: { sessionId: null, turns } });
      return cardsIn(renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={proposals} />));
    };

    it("approves a focused comment card once on a then Enter, and skips one on s at once", async () => {
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
      // Skipping asks nothing: s acts at once (and offers Undo).
      expect(onDraftCardKey(key("s", card), p, null, act)).toBe(true);
      expect(skip).toHaveBeenCalledTimes(1);
      expect(skip).toHaveBeenCalledWith("p1");
      expect(act.open).not.toHaveBeenCalled();
    });

    it("posts a GitHub review through its own path, never through approve", async () => {
      const review = draft("p9", {
        type: "githubReview",
        connectionId: "github:ada",
        item: null,
        runId: "run-1",
        repo: "acme/webshop",
        number: 218,
        commitSha: "a1b2c3d4e5f6",
        summary: "Gossamr review of #218.",
        comments: [{ path: "src/consumer/retry.ts", line: 42, side: "RIGHT", body: "**Blocking:** no backoff." }],
      });
      const postReview = vi.fn(async (): Promise<Proposal> => ({ ...review, state: { type: "applied" } }));
      useWorkspace.setState({ postReview, proposals: { [review.id]: review } });
      draftDecisions(review.id).approve();
      await vi.waitFor(() => expect(postReview).toHaveBeenCalledWith("p9", 0));
      expect(approve).not.toHaveBeenCalled();
      // The post settles before the next decision on the same draft is taken.
      await new Promise((done) => setTimeout(done, 0));
      postReview.mockImplementationOnce(async () => ({ ...review, error: "GitHub refused to post the review" }));
      draftDecisions(review.id).approve();
      await vi.waitFor(() => expect(report).toHaveBeenCalledWith("Couldn't post that draft", "GitHub refused to post the review"));
      expect(approve).not.toHaveBeenCalled();
      // The card's own copy is what is posted: one revised since it rendered is posted with what the card saw, and refused.
      await new Promise((done) => setTimeout(done, 0));
      const revised = { ...review, revisions: [{ at: "2026-10-01T10:05:00Z", note: "Revised by Pip", intent: review.intent }] };
      useWorkspace.setState({ proposals: { [review.id]: revised } });
      draftDecisions(review.id, review).approve();
      await vi.waitFor(() => expect(postReview).toHaveBeenLastCalledWith("p9", 0));
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

describe("ticket links", () => {
  const ref = (key: string) => ({ connectionId: "mock", externalId: key, key });
  const container = (key: string) => ({ ref: { connectionId: "mock", externalId: key }, key, name: key, workflow: { statuses: [], transitions: { kind: "any" } } }) as unknown as WorkContainer;

  describe("ticket keys in Pip's answers", () => {
    beforeEach(() => {
      vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
      useWorkspace.setState({ items: { "mock:CA-401": { item: ref("CA-401"), title: "Welcome flow" } as WorkItem }, containers: { "mock:CA": container("CA") } });
      useRuns.setState({ runs: [{ id: "r1", item: ref("DEVOPS-455") } as Run] });
    });
    afterEach(() => {
      useWorkspace.setState({ items: {}, containers: {} });
      useRuns.setState({ runs: [] });
      vi.unstubAllGlobals();
    });

    it("know a cached key by its title, a run's key and a key in a known project without one, and no other", () => {
      expect(knownTicketTitle("CA-401")).toBe("Welcome flow");
      expect(knownTicketTitle("DEVOPS-455")).toBe("");
      expect(knownTicketTitle("CA-411")).toBe("");
      expect(knownTicketTitle("ZZ-9")).toBeNull();
    });

    it("link every key Gossamr knows, cached or not, and leave an unknown project's key as text", () => {
      const html = renderToStaticMarkup(
        <TicketLinksContext.Provider value={workspaceTicketLinks}>
          <Markdown text="CA-401 is planned; DEVOPS-455 and CA-411 are done; ZZ-9 is elsewhere." />
        </TicketLinksContext.Provider>,
      );
      expect(html).toMatch(/<button[^>]*title="CA-401: Welcome flow"[^>]*>CA-401<\/button>/);
      expect(html).toMatch(/<button[^>]*title="Open DEVOPS-455"[^>]*>DEVOPS-455<\/button>/);
      expect(html).toMatch(/<button[^>]*title="Open CA-411"[^>]*>CA-411<\/button>/);
      expect(html).not.toContain(">ZZ-9</button>");
      expect(html).toContain("ZZ-9");
    });
  });

  describe("the sample backend's live peek", () => {
    it("opens the tickets only its sample runs name, as finished tickets in their project, and still not an unknown key", async () => {
      const b = new MockBackend();
      for (const key of ["CA-377", "DEVOPS-455", "SUP-9", "WEB-97"]) {
        const item = await b.peekItem(ref(key));
        expect(item?.item.key).toBe(key);
        expect(item?.status.category).toBe("done");
        expect(item?.title).not.toBe("");
      }
      expect(await b.peekItem(ref("CA-9999"))).toBeNull();
    });
  });
});

describe("a decision waiting on a draft card's Enter", () => {
  /** A focused draft card, as the key handler sees it. */
  const card = () => ({ focus: vi.fn(), scrollIntoView: vi.fn(), matches: (sel: string) => sel === DRAFT_CARD, getAttribute: (name: string) => (name === "data-state" ? "pending" : null) });
  /** The card's handlers, with the decision it waits on kept the way the card keeps it. */
  const acts = () => {
    const a = { approve: vi.fn(), skip: vi.fn(), open: vi.fn(), asking: null as "approve" | null, typed: [] as string[], ask: vi.fn(), type: vi.fn() };
    a.ask.mockImplementation((next: "approve" | null) => (a.asking = next));
    a.type.mockImplementation((text: string) => (a.typed.push(text), true));
    return a;
  };
  /** Presses `keys` on one card in turn and returns the last result. */
  const press = (a: ReturnType<typeof acts>, p: Proposal, keys: string[], el: unknown = card()) => keys.reduce((_, k) => onDraftCardKey(key(k, el), p, a.asking, a), false);
  const note = comment("p-note", null);
  const runDraft = draft("p-run", { type: "startRun", connectionId: "mock", item: itemRef("CA-412"), spec }, { origin: { type: "chat", requestId: "r1" } });

  it("only cancels on a card key pressed while an approval waits: a then another deciding or opening key neither skips nor opens", () => {
    for (const then of ["a", "s", "o", "Escape"]) {
      const a = acts();
      press(a, note, ["a"]);
      const ev = key(then, card());
      expect(onDraftCardKey(ev, note, a.asking, a)).toBe(true);
      expect(ev.preventDefault).toHaveBeenCalled();
      expect(a.asking).toBeNull();
      expect(a.ask).toHaveBeenCalledTimes(2);
      expect(a.open).not.toHaveBeenCalled();
      expect(a.approve).not.toHaveBeenCalled();
      expect(a.skip).not.toHaveBeenCalled();
      expect(a.typed).toEqual([]);
    }
    // On a run draft, a then a cancels the ask and doesn't open the draft either.
    const run = acts();
    press(run, runDraft, ["a", "a"]);
    expect(run.open).toHaveBeenCalledTimes(2);
    expect(run.ask).not.toHaveBeenCalled();
    expect(run.asking).toBeNull();
    // A letter that is not a card key still goes back to the input with the a before it.
    const b = acts();
    press(b, note, ["a", "x"]);
    expect(b.typed).toEqual(["ax"]);
    expect(b.approve).not.toHaveBeenCalled();
  });
});
