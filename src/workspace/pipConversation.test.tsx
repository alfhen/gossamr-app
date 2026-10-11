import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import { useClaude, type Turn } from "../claudeStore";
import { docFromText } from "../lib/docs";
import type { Intent, Proposal, RunSpec, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { draftDecisions } from "./DraftPreview";
import { DRAFT_CARD, onDraftCardKey, stepDraftCards, upToNewestDraft } from "./draftKeys";
import { Composer, ComposerFooter, GENERAL_CONVERSATION, PipConversation, VerbNote, composerVerb, inputAfterCommand, openWakeRun, outcomeBelongs, wakeHeader, wakeIsLong, wakeParts, workstreamConversation } from "./PipConversation";
import { usePipHome } from "./pipHomeStore";
import { useTabs } from "./tabsStore";
import { useRuns } from "./runsStore";
import { useWorkstreams } from "./workstreamsStore";
import { useToasts } from "./toasts";
import { MockBackend } from "../backend/mock";
import { GENERAL_CONVERSATION as FROM_PANE, PIP_INPUT_ID } from "./PipPane";

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
    expect(FROM_PANE).toBe(GENERAL_CONVERSATION);
    expect(GENERAL_CONVERSATION).toBe("general");
    expect(workstreamConversation("ws-7")).toBe("ws:ws-7");
    expect(PIP_INPUT_ID).toBe("pip-input");
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
    const wake: Turn = { requestId: "wake-1", kind: "wake", prompt: `[Event] run ${b.id} (triage) Done; plan recommended: yes`, steps: [], text: "R2 finished. Plan R3 is queued to start automatically.", status: "done", error: null };
    setTurns({ [workstreamConversation("ws-1")]: { sessionId: "s1", turns: [turn("q1", "Investigate it", "Drafted."), wake] } });
    const html = renderToStaticMarkup(<PipConversation conversation={workstreamConversation("ws-1")} proposals={[]} />);
    useRuns.getInitialState().runs = [];
    expect(html.match(/data-turn-kind="wake"/g)).toHaveLength(1);
    expect(html.replace(/<[^>]+>/g, "")).toContain("Pip picked this up: run R2 finished");
    // The run is named by a button that opens it.
    expect(html).toMatch(/<button type="button" data-wake-run="run-2"[^>]*>run R2<\/button> finished/);
    expect(html).toContain("Plan R3 is queued to start automatically.");
    expect(html).not.toContain("[Event]");
    expect(html.match(/bg-ws-accent px-3/g)).toHaveLength(1);
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

  it("opens a wake's run on Pip home by its step in the rail, and in the pane by its sheet", () => {
    useTabs.setState({ route: "pip" });
    openWakeRun("run-2");
    expect(usePipHome.getState().focusTarget).toEqual({ type: "run", id: "run-2", where: "rail" });
    expect(useRuns.getState().sheet).toBeNull();
    usePipHome.getState().reset();
    useTabs.setState({ route: "workspace" });
    openWakeRun("run-2");
    expect(useRuns.getState().sheet).toEqual({ type: "run", id: "run-2" });
    expect(usePipHome.getState().focusTarget).toBeNull();
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
    expect(html).not.toContain("I follow along as you move around");
  });

  it("shows the welcome line with no turns, and reads another conversation by its key", () => {
    setTurns({ "CA-9": { sessionId: null, turns: [turn("r9", "Other question", "Other answer")] } });
    const empty = renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={[]} />);
    expect(empty).toContain("I follow along as you move around");
    expect(empty).not.toContain("Other question");
    expect(renderToStaticMarkup(<PipConversation conversation="CA-9" proposals={[]} />)).toContain("Other answer");
  });

  it("makes each draft card a focusable stop that names its keys, with no hint until focused", () => {
    setTurns({ [GENERAL_CONVERSATION]: { sessionId: null, turns: [turn("r1", "Q", "A")] } });
    const run = draft("p-run", { type: "startRun", connectionId: "mock", item: itemRef("CA-412"), spec }, { origin: { type: "chat", requestId: "r1" } });
    const html = renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={[comment("p1", "r1"), run]} />);
    expect(html).toMatch(/<article[^>]*data-draft="p1"[^>]*tabindex="0"[^>]*aria-keyshortcuts="a s Enter o"[^>]*class="[^"]*focus-visible:outline-ws-pip/);
    expect(html).toMatch(/<article[^>]*data-draft="p-run"[^>]*tabindex="0"/);
    expect(html).not.toContain("a approve");
    // outline-none would stop focus-visible:outline-2 from drawing the ring at all (Tailwind 4 sets the style to none).
    expect(html).not.toMatch(/<article[^>]*class="[^"]*(?<![\w:-])outline-none/);
  });

  it("opens a workstream's empty conversation with what it is for and the commands, and General with its own words", () => {
    setTurns({});
    const ws = renderToStaticMarkup(<PipConversation conversation={workstreamConversation("ws-404")} proposals={[]} />);
    expect(ws).toContain("data-empty-workstream");
    expect(ws).toContain("/stop R1, /retry R1 or /answer R1");
    expect(ws).not.toContain("I follow along as you move around");
    const general = renderToStaticMarkup(<PipConversation conversation={GENERAL_CONVERSATION} proposals={[]} />);
    expect(general).toContain("I follow along as you move around");
    expect(general).not.toContain("data-empty-workstream");
  });

  it("says in a managed workstream's empty conversation that routine steps start on their own and Jira still waits", () => {
    setTurns({});
    const before = useWorkstreams.getInitialState().list;
    const ws = (mode: "advise" | "manage"): WorkstreamView => ({
      workstream: { id: "ws-405", connectionId: "mock", itemKey: "CA-405", repo: null, title: "CA-405", pipSession: null, mode, heldReason: null, notes: null, createdAt: "2026-10-01T10:00:00Z", closedAt: null, budget: { autoTurns: null, wakes: null, tokens: null }, spent: { autoTurns: 0, wakes: 0, tokens: 0 }, rules: {}, basis: null },
      stage: "intake",
      runs: [],
      labels: [],
      budget: { autoTurns: { used: 0, limit: 6 }, wakes: { used: 0, limit: 12 }, level: "ok" },
    });
    const intro = (mode: "advise" | "manage") => {
      // Rendered on the server, a store is read through its initial state.
      useWorkstreams.getInitialState().list = [ws(mode)];
      return renderToStaticMarkup(<PipConversation conversation={workstreamConversation("ws-405")} proposals={[]} />);
    };
    try {
      expect(intro("advise")).toContain("Nothing changes until you approve.");
      const managed = intro("manage");
      expect(managed).toContain("the routine next steps start on their own by fixed rules (see Automatic steps), I start nothing myself, and every change to Jira still waits for you.");
      expect(managed).not.toContain("Nothing changes until you approve.");
    } finally {
      useWorkstreams.getInitialState().list = before;
    }
  });

  describe("commands in the composer", () => {
    const runsBefore = useRuns.getState();
    const ws = workstreamConversation("ws-1");
    const linked = () => {
      const base = new MockBackend().runs.list().find((r) => r.state === "working")!;
      return { ...base, id: "run-ws-1", spec: { ...base.spec, workstream: "ws-1" } };
    };
    const fake = () => ({ runsStop: vi.fn(async (id: string) => ({ ...linked(), id, state: "stopped" as const })), runsRetryLaunch: vi.fn(), runsAnswer: vi.fn() });
    afterEach(() => {
      useRuns.setState({ backend: runsBefore.backend, runs: runsBefore.runs });
      useToasts.getState().clear();
    });

    it("sends /stop R1 to the person's own stop command, not to Pip, and adds no turn", async () => {
      const backend = fake();
      useRuns.setState({ backend: backend as never, runs: [linked()] });
      setTurns({ [ws]: { sessionId: null, turns: [turn("w1", "Earlier", "Answer")] } });
      const ask = vi.spyOn(useClaude.getState(), "ask");
      const outcome = await composerVerb("/stop R1", ws, true);
      expect(outcome).toEqual({ ok: true, message: "Stopped R1" });
      expect(backend.runsStop).toHaveBeenCalledWith("run-ws-1");
      expect(ask).not.toHaveBeenCalled();
      expect(useClaude.getState().byTicket[ws].turns.map((t) => t.requestId)).toEqual(["w1"]);
      // Told once, in the note under the input, not again as a toast.
      expect(useToasts.getState().toasts).toEqual([]);
      ask.mockRestore();
    });

    it("leaves everything to Pip while Agents are off, as the composer was before agents", () => {
      const backend = fake();
      useRuns.setState({ backend: backend as never, runs: [linked()] });
      for (const text of ["/stop R1", "/retry R1", "/answer R1 yes", "/nudge R1"]) {
        expect(composerVerb(text, ws, false)).toBeNull();
        expect(composerVerb(text, GENERAL_CONVERSATION, false)).toBeNull();
      }
      expect(backend.runsStop).not.toHaveBeenCalled();
    });

    it("keeps what was typed when a command is refused, and clears it when it worked unless more was typed since", () => {
      expect(inputAfterCommand({ ok: false, message: "No run R9 in this workstream" }, "/stop R9", "/stop R9")).toBe("/stop R9");
      expect(inputAfterCommand({ ok: false, message: "Couldn't answer R2." }, "/answer R2 a long paragraph", "/answer R2 a long paragraph")).toBe("/answer R2 a long paragraph");
      expect(inputAfterCommand({ ok: true, message: "Stopped R1" }, "/stop R1", "/stop R1")).toBe("");
      expect(inputAfterCommand({ ok: true, message: "Stopped R1" }, "/stop R1", "and then")).toBe("and then");
    });

    it("drops a command's outcome once the person has moved to another conversation", () => {
      expect(outcomeBelongs(ws, ws)).toBe(true);
      expect(outcomeBelongs(ws, GENERAL_CONVERSATION)).toBe(false);
      expect(outcomeBelongs(ws, workstreamConversation("ws-2"))).toBe(false);
    });

    it("says what is wrong without calling anything, and lets a question through", async () => {
      const backend = fake();
      useRuns.setState({ backend: backend as never, runs: [linked()] });
      expect(await composerVerb("/stop R9", ws, true)).toEqual({ ok: false, message: "No run R9 in this workstream" });
      expect(await composerVerb("/answer R1", ws, true)).toMatchObject({ ok: false, message: expect.stringMatching(/^Say what to answer/) });
      expect(backend.runsStop).not.toHaveBeenCalled();
      expect(composerVerb("investigate this", ws, true)).toBeNull();
    });

    it("shows the outcome as a muted note under the input", () => {
      const html = renderToStaticMarkup(<VerbNote outcome={{ ok: true, message: "Stopped R1" }} />);
      expect(html).toContain('role="status"');
      expect(html).toContain("Stopped R1");
      expect(html).toContain("text-ws-ink3");
      expect(renderToStaticMarkup(<VerbNote outcome={null} />)).toBe("");
    });
  });

  describe("with a queue", () => {
    const at = (requestId: string, prompt: string, status: Turn["status"], error: string | null = null): Turn => ({ requestId, prompt, steps: [], text: "", status, error });
    const attached = { images: [], add: async () => {}, remove: () => {}, take: () => [] } as unknown as Parameters<typeof Composer>[0]["attached"];
    const composer = () =>
      renderToStaticMarkup(<Composer conversation={GENERAL_CONVERSATION} attached={attached} chips={["What is stale?"]} looking="the board" scene={{ itemKey: null, route: "workspace", runOpen: false }} />);

    it("renders a footer under the input only when given one, as a muted status line", () => {
      expect(composer()).not.toContain("data-composer-footer");
      const html = renderToStaticMarkup(
        <Composer conversation={GENERAL_CONVERSATION} attached={attached} chips={[]} looking="the board" scene={{ itemKey: null, route: "pip", runOpen: false }} footer="4 agents working · 2 need you" />,
      );
      expect(html).toMatch(/<p role="status" data-composer-footer="true" class="[^"]*text-ws-ink3[^"]*">4 agents working · 2 need you<\/p>/);
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

    it("keeps the input and Ask next to Stop while Pip answers, and the chips until a question waits", () => {
      setTurns({ [GENERAL_CONVERSATION]: { sessionId: null, turns: [at("r1", "First", "running")] } });
      const running = composer();
      expect(running).toMatch(/>Stop<\/button><button type="submit"[^>]*>Ask<\/button>/);
      expect(running).toContain("What is stale?");
      expect(running).not.toMatch(/<input id="pip-input"[^>]*disabled/);
      setTurns({ [GENERAL_CONVERSATION]: { sessionId: null, turns: [at("r1", "First", "running"), at("r2", "Second", "queued")] } });
      expect(composer()).not.toContain("What is stale?");
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
