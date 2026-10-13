import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { docFromText } from "../lib/docs";
import { needGroups, needs, type Need, type NeedsInput } from "../lib/needs";
import { HELD_BUDGET, HELD_PERSON, HELD_RESTART } from "../types";
import type { Intent, Proposal, Run, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { Launcher } from "./PipExtras";
import { NeedsPane } from "./NeedsPane";
import { NeedsYouList, groupText } from "./NeedsYou";
import { NO_FILTERS, groupRuns, slotWaiters, stopAllLabel, stoppable, summaryLine, yourAgents } from "./agentsLogic";
import { arm, confirmArmed, disarm, keyPlan, openInWorkstream, openNeed } from "./needsActions";
import { composerFooter } from "./pipHomeLogic";
import { usePipHome } from "./pipHomeStore";
import { PipRunStripView } from "./PipRunCard";
import { railBadgeText } from "./Rail";
import { useRuns } from "./runsStore";
import { loadTabs, useTabs } from "./tabsStore";
import { useToasts } from "./toasts";
import { needsYouText } from "./useNeeds";
import { useWorkstreams } from "./workstreamsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

const NOW = Date.parse("2026-09-30T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ref = (key: string) => ({ connectionId: "mock", externalId: key, key });

const backend = new MockBackend();
const sample = backend.runs.list();
const base = sample[0];
const run = (id: string, state: Run["state"], over: Partial<Run> = {}): Run => ({ ...base, id, state, item: ref("CA-401"), spec: { ...base.spec, kind: "build", workstream: "ws-1" }, failure: null, needs: null, lastProgressAt: ago(5), queuedAt: ago(60), endedAt: null, ...over });

const view = (id: string, key: string | null, title: string, over: { heldReason?: string | null; runs?: string[] } = {}): WorkstreamView => ({
  workstream: {
    id,
    connectionId: "mock",
    itemKey: key,
    repo: null,
    title,
    pipSession: null,
    mode: "manage",
    heldReason: over.heldReason ?? null,
    notes: null,
    createdAt: ago(600),
    closedAt: null,
    budget: { autoTurns: null, wakes: null, tokens: null },
    spent: { autoTurns: 0, wakes: 0, tokens: 0 },
    rules: {},
    basis: null,
  },
  stage: "build",
  runs: over.runs ?? [],
  labels: (over.runs ?? []).map((r, n) => [r, `R${n + 1}`]),
  budget: { autoTurns: { used: 0, limit: 6 }, wakes: { used: 0, limit: 12 }, level: "ok" },
});

const draft = (id: string, intent: Intent, minutes: number, workstream: string | null = null): Proposal =>
  ({ id, createdAt: ago(minutes), updatedAt: ago(minutes), origin: { type: "chat", requestId: `q-${id}`, workstream }, createdBy: "pip", intent, label: null, basis: null, state: { type: "pending" }, revisions: [], created: [], error: null, run: null }) as unknown as Proposal;

const comment = (key: string, text = "Checking in."): Intent => ({ type: "comment", item: ref(key), body: docFromText(text), mentions: [] }) as unknown as Intent;
const transition = (key: string): Intent => ({ type: "transition", item: ref(key), to: "done" }) as unknown as Intent;
const rewrite = (key: string): Intent => ({ type: "rewrite", item: ref(key), title: null, body: { from: docFromText("a"), to: docFromText("b"), fromText: "a", toText: "b" }, flattened: [] }) as unknown as Intent;
const startRun = (key: string): Intent => ({ type: "startRun", connectionId: "mock", item: ref(key), spec: { ...base.spec, kind: "investigate", workstream: "ws-1" } }) as unknown as Intent;

const ws1 = view("ws-1", "CA-401", "CA-401 Welcome flow refresh", { runs: ["r-perm", "r-q", "r-fail"] });
const ws2 = view("ws-2", "CA-402", "CA-402 Cart merge", { heldReason: HELD_RESTART });

const input = (over: Partial<NeedsInput> = {}): NeedsInput => ({
  workstreams: [ws1, ws2],
  runs: [
    run("r-perm", "needsPermission", { needs: "approve Bash: git push origin ca-401", lastProgressAt: ago(14) }),
    run("r-q", "needsAnswer", { needs: "Which cache should it keep?", lastProgressAt: ago(9) }),
    run("r-fail", "failed", { error: "Launch was interrupted", lastProgressAt: ago(8), endedAt: ago(8) }),
  ],
  proposals: [draft("c1", comment("CA-401"), 30, "ws-1"), draft("c2", transition("CA-401"), 25, "ws-1"), draft("c3", comment("CA-401", "Another"), 24, "ws-1"), draft("g1", comment("CA-500"), 10)],
  dismissed: new Set(),
  titleOf: (key) => (key === "CA-500" ? "Loose ticket" : null),
  now: NOW,
  ...over,
});

/**
 * Static markup reads a store's initial state, not its current one, so what a render should see is put into both, and put
 * back after.
 */
const seeded = new Map<{ getInitialState(): object; setState(patch: never): void }, object>();
function seed<S extends object>(store: { getInitialState(): S; setState(patch: Partial<S>): void }, patch: Partial<S>) {
  const initial = store.getInitialState();
  if (!seeded.has(store as never)) seeded.set(store as never, { ...initial });
  Object.assign(initial, patch);
  store.setState(patch);
}
function unseed() {
  for (const [store, was] of seeded) {
    Object.assign(store.getInitialState(), was);
    store.setState(was as never);
  }
  seeded.clear();
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memory());
  useTabs.setState(loadTabs());
  useWorkspace.setState({ proposals: {} });
});

afterEach(() => {
  unseed();
  usePipHome.getState().reset();
  disarm();
  useRuns.setState({ sheet: null, selectedId: null, runs: [], dismissed: new Set() });
  useWorkstreams.setState({ list: [] });
  useTabs.getState().setRoute("workspace");
  vi.unstubAllGlobals();
});

describe("the Needs you list", () => {
  const list = needs(input());

  it("shows the one count, then one row per workstream and General, each with its top need's ticket, title, kind, why and age", () => {
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(html).toContain('<section aria-label="Needs you"');
    expect(html).toMatch(/data-needs-you-count[^>]*>8</);
    expect(html).toContain('aria-label="8 things need you"');
    // The hold is the oldest of what is stuck, so its workstream's row leads.
    const rows = [...html.matchAll(/data-needs-you-row="([^"]+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(["ws-2", "ws-1", "general"]);
    expect([...html.matchAll(/data-needs-you-key[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["CA-402", "CA-401"]);
    expect([...html.matchAll(/data-needs-you-head[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["Cart merge", "Welcome flow refresh", "General"]);
    expect([...html.matchAll(/data-needs-you-chip="(\w+)"/g)].map((m) => m[1])).toEqual(["unblock", "unblock", "approve"]);
    expect(html).toContain("R1 wants to run `git push origin ca-401`.");
    expect(html).toContain("Held after a restart.");
    // The age of each top need.
    expect([...html.matchAll(/data-needs-you-age[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["10h", "14m", "10m"]);
  });

  it("says '+N more' for a group with more than one need, and nothing for one with a single need", () => {
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect([...html.matchAll(/data-needs-you-more[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["+5 more"]);
    expect(html.match(/data-needs-you-more/g)).toHaveLength(1);
  });

  it("gives a row its whole line as its tooltip, and its text as its name", () => {
    const g = needGroups(list).find((x) => x.workstreamId === "ws-1")!;
    expect(groupText(g, NOW)).toBe("CA-401 · Welcome flow refresh · Unblock · R1 wants to run `git push origin ca-401`. · 14m · +5 more");
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(html).toContain(`title="${groupText(g, NOW)}"`);
    expect(html).not.toContain(`aria-label="${groupText(g, NOW)}"`);
  });

  it("keeps a group folded until it is expanded, then lists every need in it, the top one first", () => {
    const folded = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).not.toContain("data-needs-you-need=");
    seed(usePipHome, { expanded: new Set(["ws-1"]) });
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(html).toContain('aria-expanded="true"');
    expect([...html.matchAll(/data-needs-you-need="([^"]+)"/g)].map((m) => m[1])).toEqual(["run:r-perm", "run:r-q", "run:r-fail", "draft:c1", "draft:c2", "draft:c3"]);
    expect(html).toContain("Show less");
    // A long title wraps to two lines, whole in its tooltip, so stuck runs that differ at the end still read apart.
    const titles = [...html.matchAll(/<span data-needs-you-need-title([^>]*)>/g)].map((m) => m[1]);
    expect(titles).toHaveLength(6);
    for (const t of titles) expect(t).toContain("line-clamp-2");
    expect(titles.join(" ")).not.toContain("truncate");
  });

  it("keeps the NEEDS YOU header in view while the list scrolls", () => {
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(html).toMatch(/<h2 data-needs-you-title[^>]*class="sticky top-0 /);
  });

  it("as Pip home's main column, takes the height it is given and scrolls inside it, not under a cap of its own", () => {
    const html = renderToStaticMarkup(<NeedsYouList main needs={list} now={NOW} />);
    const region = /<section aria-label="Needs you"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(region).toContain("flex-1");
    expect(region).toContain("overflow-y-auto");
    expect(region).not.toMatch(/max-h-/);
    // The popover's and the plain list keep their caps.
    expect(renderToStaticMarkup(<NeedsYouList compact needs={list} now={NOW} />)).toMatch(/aria-label="Needs you"[^>]*max-h-\[min\(400px,60vh\)\]/);
    expect(renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />)).toMatch(/aria-label="Needs you"[^>]*max-h-\[38vh\]/);
  });

  it("lets a group's title wrap to two lines instead of cutting it to one", () => {
    const html = renderToStaticMarkup(<NeedsYouList main needs={list} now={NOW} />);
    const heads = [...html.matchAll(/<span data-needs-you-head[^>]*class="([^"]*)"/g)].map((m) => m[1]);
    expect(heads.length).toBeGreaterThan(0);
    for (const c of heads) {
      expect(c).toContain("line-clamp-2");
      expect(c).not.toContain("truncate");
    }
  });

  it("offers 'Approve N safe drafts' under an expanded group with two or more, with none for a lone draft", () => {
    seed(useWorkspace, { proposals: Object.fromEntries(input().proposals.map((p) => [p.id, p])) });
    seed(usePipHome, { expanded: new Set(["ws-1"]) });
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(html).toContain("Approve 3 safe drafts");
    expect(html.match(/Approve \d+ safe drafts/g)).toHaveLength(1);
    // A group with a single batchable draft has no batch to offer.
    const lone = needs(input({ proposals: [draft("c1", comment("CA-401"), 30, "ws-1")] }));
    expect(renderToStaticMarkup(<NeedsYouList needs={lone} now={NOW} />)).not.toContain("safe drafts");
  });

  it("keeps the batch's preview out of the list: its button opens it in the pane", () => {
    seed(useWorkspace, { proposals: Object.fromEntries(input().proposals.map((p) => [p.id, p])) });
    seed(usePipHome, { expanded: new Set(["ws-1"]), batch: "ws-1" });
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(html).toContain("Approve 3 safe drafts");
    expect(html).not.toContain("data-needs-you-batch-preview");
    expect(html).not.toContain("Yes, approve");
    usePipHome.getState().previewBatch("ws-1");
    expect(usePipHome.getState().batch).toBe("ws-1");
  });

  it("marks an open group's top need, listed again under it, so j and k step past it", () => {
    seed(usePipHome, { expanded: new Set(["ws-1"]) });
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    const group = needGroups(list).find((g) => g.workstreamId === "ws-1")!;
    expect([...html.matchAll(/data-needs-top=""/g)]).toHaveLength(1);
    expect(html).toMatch(new RegExp(`data-needs-you-need="${group.top.key}"[^>]*data-needs-top=""`));
    expect(html.match(/data-needs-you-need=/g)).toHaveLength(group.count);
    // Folded, a group is its one row.
    unseed();
    const folded = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(folded).not.toContain("data-needs-top");
  });

  it("says so when nothing waits", () => {
    const html = renderToStaticMarkup(<NeedsYouList needs={[]} now={NOW} />);
    expect(html).toMatch(/data-needs-you-count[^>]*>0</);
    expect(html).toContain("Nothing needs you.");
    expect(html).not.toContain("data-needs-you-group");
  });

  it("marks the need whose decision is open, and says what a key is waiting for on its row", () => {
    seed(usePipHome, { expanded: new Set(["ws-1"]), deciding: "run:r-q", asking: { key: "run:r-perm", text: "↵ deny it; Claude carries on without it · any other key cancels" } });
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/data-need-key="run:r-q"[^>]*aria-current="true"|aria-current="true"[^>]*data-need-key="run:r-q"/);
    expect(html).toContain("data-needs-asking");
    expect(html).toContain("↵ deny it; Claude carries on without it · any other key cancels");
  });
});

describe("opening a need", () => {
  const list = needs(input());
  const need = (key: string) => list.find((n) => n.key === key)!;

  it("on Pip home selects its workstream and opens its decision in the middle column", () => {
    useTabs.getState().setRoute("pip");
    openNeed(need("run:r-perm"));
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState()).toMatchObject({ selected: "ws-1", deciding: "run:r-perm", asking: null });
  });

  it("from another route goes to Pip home first", () => {
    useTabs.getState().setRoute("workspace");
    openNeed(need("held:ws-2"));
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState()).toMatchObject({ selected: "ws-2", deciding: "held:ws-2" });
  });

  it("goes to General for a need in no workstream", () => {
    usePipHome.getState().openWorkstream("ws-1");
    openNeed(need("draft:g1"));
    expect(usePipHome.getState().selected).toBeNull();
    expect(usePipHome.getState().deciding).toBe("draft:g1");
  });

  it("'Open in workstream' closes the decision and asks for the card, where the card is; a run's sheet opens over it", () => {
    useTabs.getState().setRoute("pip");
    openNeed(need("draft:c1"));
    openInWorkstream(need("draft:c1"));
    expect(usePipHome.getState()).toMatchObject({ selected: "ws-1", deciding: null, focusTarget: { type: "draft", id: "c1" } });
    expect(useRuns.getState().sheet).toBeNull();
    openInWorkstream(need("held:ws-2"));
    expect(usePipHome.getState()).toMatchObject({ selected: "ws-2", focusTarget: { type: "workstream" } });
    openInWorkstream(need("run:r-q"));
    expect(usePipHome.getState().focusTarget).toEqual({ type: "run", id: "r-q" });
    expect(useRuns.getState().sheet).toEqual({ type: "run", id: "r-q" });
    openInWorkstream(need("draft:g1"));
    expect(usePipHome.getState().selected).toBeNull();
  });
});

describe("what the list's keys do", () => {
  const proposals = [...input().proposals, draft("rw", rewrite("CA-401"), 40, "ws-1"), draft("st", startRun("CA-401"), 35, "ws-1")];
  const list = needs(input({ proposals }));
  const need = (key: string) => list.find((n) => n.key === key)!;

  beforeEach(() => {
    useWorkspace.setState({ proposals: Object.fromEntries(proposals.map((p) => [p.id, p])) });
    useRuns.setState({ runs: [...input().runs] });
  });

  it("asks for Enter before it approves a comment or a move, or denies, and only then does it", () => {
    const plan = keyPlan(need("draft:c1"), "approve");
    expect(plan).toMatchObject({ type: "ask", text: "approve this draft" });
    expect(keyPlan(need("draft:c2"), "approve")).toMatchObject({ type: "ask" });
    const deny = keyPlan(need("run:r-perm"), "dismiss");
    expect(deny).toMatchObject({ type: "ask", text: "deny it; Claude carries on without it" });
    if (deny?.type !== "ask") throw new Error("a deny reaches the agent, so it asks first");
    // Nothing happens until Enter confirms what was asked.
    arm(need("run:r-perm"), deny);
    expect(usePipHome.getState().asking).toEqual({ key: "run:r-perm", text: "↵ deny it; Claude carries on without it · any other key cancels" });
    expect(usePipHome.getState().asking).not.toBeNull();
    disarm();
    expect(usePipHome.getState().asking).toBeNull();
    // Confirming what was dropped does nothing.
    confirmArmed();
  });

  it("skips a draft and dismisses a run at once, with no Enter, since both can be undone", () => {
    expect(keyPlan(need("draft:c1"), "dismiss")).toMatchObject({ type: "do" });
    expect(keyPlan(need("draft:c1"), "skip")).toMatchObject({ type: "do" });
    expect(keyPlan(need("run:r-q"), "skip")).toBeNull();
    expect(keyPlan(need("run:r-perm"), "skip")).toBeNull();
    const dismiss = keyPlan(need("run:r-fail"), "dismiss");
    expect(dismiss).toMatchObject({ type: "do" });
    if (dismiss?.type !== "do") throw new Error("a dismissal acts at once");
    expect(useRuns.getState().dismissed.has("r-fail")).toBe(false);
    dismiss.run();
    expect(useRuns.getState().dismissed.has("r-fail")).toBe(true);
    // The same keys on the same need as the button's: Undo puts it back.
    expect(useToasts.getState().toasts.some((t) => t.action?.label === "Undo")).toBe(true);
  });

  it("allows, retries and resumes only after Enter: they reach an agent or start something", () => {
    // A permission's primary is an Allow once only where the run offers one; otherwise a opens its decision.
    expect(["ask", "open"]).toContain(keyPlan(need("run:r-perm"), "approve")?.type);
    expect(keyPlan(need("held:ws-2"), "approve")).toMatchObject({ type: "ask", text: "resume this workstream" });
  });

  it("allows 5 more automatic steps only after Enter, as it reaches the workstream's allowance", () => {
    const list = needs({ ...input(), workstreams: [{ ...view("ws-1", "CA-401", "CA-401 Welcome flow refresh", { heldReason: HELD_BUDGET }), budget: { autoTurns: { used: 11, limit: 11 }, wakes: { used: 0, limit: 12 }, level: "spent" } }], runs: [], proposals: [] });
    const plan = keyPlan(list[0], "approve");
    expect(plan).toMatchObject({ type: "ask", text: "allow 5 more automatic steps" });
    expect(keyPlan(list[0], "dismiss")).toBeNull();
    const was = useWorkstreams.getState().allowMore;
    const allowMore = vi.fn(async () => true);
    useWorkstreams.setState({ allowMore });
    if (plan?.type !== "ask") throw new Error("it asks for Enter first");
    plan.run();
    expect(allowMore).toHaveBeenCalledWith("ws-1");
    useWorkstreams.setState({ allowMore: was });
  });

  it("opens the decision where there is something to read first: a rewrite's diff, a question, a run to start", () => {
    expect(keyPlan(need("draft:rw"), "approve")).toEqual({ type: "open", edit: false });
    expect(keyPlan(need("run:r-q"), "approve")).toEqual({ type: "open", edit: false });
    expect(keyPlan(need("draft:st"), "approve")).toEqual({ type: "open", edit: false });
    expect(keyPlan(need("held:ws-2"), "approve")).toMatchObject({ type: "ask", text: "resume this workstream" });
  });

  it("opens an edit where the draft has one, and means nothing where it has none", () => {
    expect(keyPlan(need("draft:c1"), "edit")).toEqual({ type: "open", edit: true });
    expect(keyPlan(need("run:r-q"), "edit")).toEqual({ type: "open", edit: true });
    expect(keyPlan(need("run:r-perm"), "edit")).toBeNull();
    expect(keyPlan(need("held:ws-2"), "edit")).toBeNull();
    expect(keyPlan(need("held:ws-2"), "dismiss")).toBeNull();
    expect(keyPlan(need("held:ws-2"), "skip")).toBeNull();
  });
});

describe("the decision pane", () => {
  const set = (over: Partial<NeedsInput> = {}) => {
    const given = input(over);
    seed(useRuns, { runs: given.runs as Run[] });
    seed(useWorkstreams, { list: [...given.workstreams] });
    seed(useWorkspace, { proposals: Object.fromEntries(given.proposals.map((p) => [p.id, p])) });
    return needs(given);
  };
  const pane = (list: Need[], key: string) => {
    seed(usePipHome, { deciding: key });
    return renderToStaticMarkup(<NeedsPane needs={list} />);
  };

  it("opens nothing until a need is chosen, and nothing for a need that is gone", () => {
    const list = set();
    expect(renderToStaticMarkup(<NeedsPane needs={list} />)).toBe("");
    seed(usePipHome, { deciding: "run:gone" });
    expect(renderToStaticMarkup(<NeedsPane needs={list} />)).toBe("");
  });

  it("opens a group's safe drafts as one decision: what each does, then the one confirm; a batch with fewer than two says so", () => {
    const list = set();
    seed(usePipHome, { batch: "ws-1" });
    const html = renderToStaticMarkup(<NeedsPane needs={list} />);
    expect(html).toContain('data-needs-pane="batch:ws-1"');
    expect(html).toContain("Approve 3 safe drafts");
    expect(html).toContain('data-needs-you-chip="approve"');
    expect(html).toContain("Nothing is posted until you choose.");
    expect(html.match(/<li class="\[overflow-wrap:anywhere\]">/g)).toHaveLength(3);
    expect(html).toContain(">Yes, approve 3</button>");
    expect(html).toContain('aria-label="Back to the list"');
    // Cancel and Esc keep the drafts: the pane is the one confirm, and nothing was approved by opening it.
    expect(useWorkspace.getState().proposals["c1"].state.type).toBe("pending");
    seed(usePipHome, { batch: "general" });
    expect(renderToStaticMarkup(<NeedsPane needs={list} />)).toContain("These drafts are no longer waiting together.");
  });

  it("a batch and a need's decision replace each other, and closing clears either", () => {
    const home = usePipHome.getState();
    home.decide("run:r-perm", "ws-1");
    home.previewBatch("ws-1");
    expect(usePipHome.getState()).toMatchObject({ deciding: null, batch: "ws-1" });
    expect([...usePipHome.getState().expanded]).toContain("ws-1");
    usePipHome.getState().decide("run:r-perm", "ws-1");
    expect(usePipHome.getState()).toMatchObject({ deciding: "run:r-perm", batch: null });
    usePipHome.getState().previewBatch("ws-1");
    usePipHome.getState().closeDecision();
    expect(usePipHome.getState()).toMatchObject({ deciding: null, batch: null });
  });

  it("heads the decision with why and what waiting does, and a link to the workstream", () => {
    const list = set();
    const html = pane(list, "run:r-perm");
    expect(html).toContain('aria-label="Decision"');
    expect(html).toContain("R1 wants to run `git push origin ca-401`.");
    expect(html).toContain("If you wait:");
    expect(html).toContain("The run stays paused; nothing else in CA-401 moves.");
    expect(html).toContain("Open in workstream");
    expect(html).toContain('data-needs-pane="run:r-perm"');
    expect(html).toContain('data-needs-you-chip="unblock"');
  });

  it("decides a permission with the permission ask, a question with the answer box, a failure with its next step and Dismiss", () => {
    const list = set();
    expect(pane(list, "run:r-perm")).toContain("data-permission-ask");
    expect(pane(list, "run:r-q")).toContain('aria-label="Your answer"');
    const failure = pane(list, "run:r-fail");
    // It ran before it failed, so there is no launch to retry: Terminal, and Dismiss.
    expect(failure).toContain("Open in Terminal");
    expect(failure).toContain("Dismiss");
    const launch = set({ runs: [run("r-x", "failed", { shortId: null, failure: { type: "other" }, error: "Launch was interrupted" })], workstreams: [ws1], proposals: [] });
    expect(pane(launch, "run:r-x")).toContain("Retry launch");
  });

  it("decides a sign-in with the sign-in box and a limit stop with the resume box", () => {
    const list = set({ runs: [run("r-s", "systemBlocked"), run("r-l", "stopped", { stoppedByLimit: true, error: "Stopped by Gossamr: it passed the 60 minute limit" })], proposals: [], workstreams: [view("ws-1", "CA-401", "CA-401 Welcome flow refresh", { runs: ["r-s", "r-l"] })] });
    expect(pane(list, "run:r-s")).toContain("Claude needs you to sign in");
    expect(pane(list, "run:r-s")).toContain("R1 needs you to sign in to Claude.");
    const limit = pane(list, "run:r-l");
    expect(limit).toContain('aria-label="What to tell it"');
    expect(limit).toContain("Resume");
  });

  it("decides a hold with the held banner's Resume, and a draft with its card", () => {
    const list = set();
    const held = pane(list, "held:ws-2");
    expect(held).toContain("data-held-banner");
    expect(held).toContain("Resume");
    const card = pane(list, "draft:c1");
    expect(card).toContain('data-draft="c1"');
    expect(card).toContain("Nothing is written to Jira until you approve it.");
  });

  it("decides a used-up budget with Allow 5 more and Switch to Advise, and shows no need for a hold the person chose", () => {
    const spent: WorkstreamView = { ...view("ws-1", "CA-401", "CA-401 Welcome flow refresh", { heldReason: HELD_BUDGET }), budget: { autoTurns: { used: 11, limit: 11 }, wakes: { used: 11, limit: 12 }, level: "spent" } };
    const list = set({ workstreams: [spent], runs: [], proposals: [] });
    const html = pane(list, "budget:ws-1");
    expect(html).toContain("CA-401 used its 11 automatic steps");
    expect(html).toContain("Pip and the automatic steps are paused until you decide.");
    expect(html).toContain(">Allow 5 more<");
    expect(html).toContain(">Switch to Advise<");
    expect(html).toContain('data-needs-you-chip="decide"');
    expect(html).toContain("11 of 11 automatic steps used");
    expect(html).not.toMatch(/turns|wakes/);
    // The person's own hold and Hold all are no need, and so in no count.
    for (const reason of [HELD_PERSON, "hold_all"]) {
      const own = set({ workstreams: [view("ws-1", "CA-401", "CA-401 Welcome flow refresh", { heldReason: reason })], runs: [], proposals: [] });
      expect(own).toEqual([]);
    }
  });

  it("decides a ticket the triage found not clear enough to plan with its questions and the three choices", () => {
    const unclear: WorkstreamView = { ...view("ws-1", "CA-401", "CA-401 Welcome flow refresh"), readiness: { triageRun: "r-t", triageLabel: "R2", questions: ["What does done look like?", "Who is waiting on it?"], at: ago(4) } };
    const list = set({ workstreams: [unclear], runs: [], proposals: [] });
    const html = pane(list, "readiness:r-t");
    expect(html).toContain("CA-401 isn&#x27;t clear enough to plan");
    expect(html).toContain('data-needs-you-chip="decide"');
    expect(html).toContain("<li>What does done look like?</li><li>Who is waiting on it?</li>");
    expect(html).toContain("No plan starts until you choose.");
    for (const label of ["Ask the reporter", "I&#x27;ll answer", "Plan anyway"]) expect(html).toContain(`>${label}<`);
    // Nothing is posted by the pane itself: it only offers the choices.
    expect(html).not.toContain("Post review");
    // With no questions listed, it says so rather than show an empty list.
    const none = set({ workstreams: [{ ...unclear, readiness: { ...unclear.readiness!, questions: [] } }], runs: [], proposals: [] });
    const quiet = pane(none, "readiness:r-t");
    expect(quiet).toContain("unclear but listed no questions");
    expect(quiet).not.toContain("data-readiness-questions");
  });

  it("calls the store for each of the three choices", () => {
    const unclear: WorkstreamView = { ...view("ws-1", "CA-401", "CA-401 Welcome flow refresh"), readiness: { triageRun: "r-t", triageLabel: "R2", questions: ["Who asked?"], at: ago(4) } };
    const list = set({ workstreams: [unclear], runs: [], proposals: [] });
    const was = useWorkstreams.getState();
    const calls = { askReporter: vi.fn(async () => true), answerSelf: vi.fn(async () => true), planAnyway: vi.fn(async () => true) };
    useWorkstreams.setState(calls);
    const [primary, ...rest] = [list[0].primary, ...list[0].secondary];
    expect([primary.id, ...rest.map((a) => a.id)]).toEqual(["askReporter", "answerSelf", "planAnyway"]);
    // The keyboard's plan for the primary asks for Enter and then calls the store; the others are the pane's buttons.
    const plan = keyPlan(list[0], "approve");
    if (plan?.type !== "ask") throw new Error("it asks for Enter first");
    plan.run();
    expect(calls.askReporter).toHaveBeenCalledWith("ws-1");
    useWorkstreams.setState({ askReporter: was.askReporter, answerSelf: was.answerSelf, planAnyway: was.planAnyway });
  });

  it("decides an escalation with its three choices and the review draft that folded into it, and a plan with its approval note", () => {
    const escalated: WorkstreamView = { ...view("ws-1", "CA-401", "CA-401 Welcome flow refresh", { runs: ["r-b", "r-rev"] }), escalation: { reviewRun: "r-rev", buildRun: "r-b", reviewLabel: "R2", buildLabel: "R1", rounds: 2, reviewDraft: "rd", at: ago(3) } };
    const review = draft("rd", { type: "githubReview", item: ref("CA-401"), connectionId: "github", repo: "acme/shop", number: 7, runId: "r-rev", summary: "Blocking", comments: [], commitSha: "abc" } as unknown as Intent, 5, "ws-1");
    const planRun = run("r-plan", "done", { spec: { ...base.spec, kind: "plan", workstream: "ws-1" } });
    const list = set({ workstreams: [escalated], runs: [planRun], proposals: [review, { ...draft("plan", rewrite("CA-401"), 4, "ws-1"), origin: { type: "run", runId: "r-plan", shortId: null, workstream: "ws-1" } } as Proposal], dismissed: new Set() });
    const escalation = pane(list, "escalation:r-rev");
    expect(escalation).toContain("data-escalation");
    expect(escalation).toContain("Run another fix round");
    expect(escalation).toContain('data-draft="rd"');
    expect(escalation).toContain("The review still blocks after 2 fix rounds.");
    const plan = pane(list, "draft:plan");
    expect(plan).toContain("data-plan-approve");
    expect(list.map((n) => n.key)).not.toContain("draft:rd");
  });

  it("shows an escalation once in the pane: its header says the review still blocks, so the card doesn't say it again", () => {
    const escalated: WorkstreamView = { ...view("ws-1", "CA-401", "CA-401 Welcome flow refresh", { runs: ["r-b", "r-rev"] }), escalation: { reviewRun: "r-rev", buildRun: "r-b", reviewLabel: "R2", buildLabel: "R1", rounds: 2, reviewDraft: "rd", at: ago(5) } } as WorkstreamView;
    const review = draft("rd", { type: "githubReview", item: ref("CA-401"), connectionId: "github", repo: "acme/shop", number: 7, runId: "r-rev", summary: "Blocking", comments: [], commitSha: "abc" } as unknown as Intent, 5, "ws-1");
    const list = set({ workstreams: [escalated], runs: [], proposals: [review], dismissed: new Set() });
    const html = pane(list, "escalation:r-rev");
    expect(html).toContain("The review still blocks after 2 fix rounds.");
    expect(html).not.toContain("What next?");
    expect(html).toContain('aria-label="Review still blocks"');
  });

  it("is the one thing that scrolls in its place: its header stays in view and its drafts' action bars are not sticky", () => {
    const html = pane(set({ workstreams: [], runs: sample, proposals: [draft("c1", comment("CA-401"), 3)], dismissed: new Set() }), "draft:c1");
    expect(html).toMatch(/<section[^>]*data-needs-pane="draft:c1"[^>]*class="[^"]*overflow-y-auto[^"]*\[&amp;_\[data-draft-actions\]\]:static/);
    expect(html).toMatch(/<header class="sticky -top-2.5 /);
    // The pane is the only scroller inside itself.
    expect(html.match(/overflow-y-auto/g)).toHaveLength(1);
  });
});

describe("every count of needs you and of agents, from one fixture (D4, D5, N3)", () => {
  const runs = sample;
  const at = NOW;
  const ticket = ref("CA-401");
  const proposals = [draft("p1", comment("CA-401"), 3), { ...draft("p2", { type: "startRun", connectionId: "mock", item: ticket, spec: { ...runs[0].spec, kind: "investigate" } } as unknown as Intent, 3) }];
  const failed = runs.find((r) => r.state === "failed")!;

  for (const dismissed of [new Set<string>(), new Set([failed.id])]) {
    it(`agrees on the list, the rail badge, the composer, the launcher, the Agents header, Your agents and Stop all${dismissed.size ? ", once the failed run was dismissed" : ""}`, () => {
      const list = needs({ workstreams: [], runs, proposals, dismissed, now: at + 5 * 60_000 });
      const n = list.length;
      // The sample clock stands at 12:00; five minutes on, the run that was quiet at 11:20 is 45 minutes quiet.
      expect(n).toBe(3 + (dismissed.size ? 0 : 1) + proposals.length);
      // One number: the list's pill, the rail badge, the composer footer, the launcher and the Agents header.
      expect(renderToStaticMarkup(<NeedsYouList needs={list} now={at} />)).toMatch(new RegExp(`data-needs-you-count[^>]*>${n}<`));
      expect(railBadgeText.pipHome(n)).toBe(needsYouText(n));
      expect(Number(/(\d+) needs? you/.exec(composerFooter(runs, n, at))?.[1])).toBe(n);
      expect(renderToStaticMarkup(<Launcher needs={n} onOpen={() => {}} nudge={null} />)).toContain(`Ask Pip, ${needsYouText(n)}`);
      expect(summaryLine(runs, at, n)).toMatch(new RegExp(`^${n} need you · `));
      // Its agent part: the run needs among them, and Agents has no badge of its own.
      const waiting = list.filter((x) => x.runId);
      expect(n).toBe(waiting.length + proposals.length);
      // Your agents: the strip's "3 of M" is every agent, the waiting ones among them.
      const mine = yourAgents(runs, dismissed);
      const strip = renderToStaticMarkup(<PipRunStripView runs={runs} enabled now={at} dismissed={dismissed} titleOf={() => null} onOpen={() => {}} onSeeAll={() => {}} />);
      expect(Number(/data-strip-count[^>]*>\d+ of (\d+)</.exec(strip)?.[1])).toBe(mine.length);
      // Failed or stuck in the header is the lane of that name, card for card (N3).
      const bad = groupRuns(runs, NO_FILTERS, at).find((g) => g.lane === "bad")?.runs.length ?? 0;
      expect(Number(/(\d+) failed or stuck/.exec(summaryLine(runs, at, n))?.[1])).toBe(bad);
      // Stop all counts a set of its own, and says so.
      expect(stopAllLabel(stoppable(runs).length + slotWaiters(runs).length)).toMatch(/^Stop all \(\d+ stoppable\)$/);
    });
  }

  it("keeps a folder to trust, and every other failure, in the count until it is dismissed (R5)", () => {
    const trust = runs.find((r) => r.failure?.type === "untrustedFolder")!;
    const other = { ...trust, id: "r-other", failure: { type: "other" } } as unknown as typeof trust;
    const all = [...runs, other];
    useRuns.setState({ runs: all, dismissed: new Set() });
    // Opening Agents once marked every failure but the folder as seen; nothing does that now.
    const listed = (dismissed: ReadonlySet<string>) => needs({ workstreams: [], runs: all, proposals: [], dismissed, now: at }).filter((x) => x.kind === "failure").map((x) => x.runId);
    expect(listed(new Set())).toEqual(expect.arrayContaining([trust.id, other.id]));
    useRuns.getState().dismiss(other.id);
    expect(listed(useRuns.getState().dismissed)).toEqual(expect.arrayContaining([trust.id]));
    expect(listed(useRuns.getState().dismissed)).not.toContain(other.id);
  });
});
