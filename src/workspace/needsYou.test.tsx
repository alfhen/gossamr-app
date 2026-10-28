import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { docFromText } from "../lib/docs";
import { needGroups, needs, type Need, type NeedsInput } from "../lib/needs";
import type { Intent, PauseReason, Proposal, Run, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { Launcher } from "./PipExtras";
import { WorkstreamNeeds } from "./NeedsPane";

/** The stack of the workstream the open decision (or batch preview) belongs to; nothing when none is open. */
function NeedsPane({ needs: list }: { needs: readonly Need[] }) {
  const { deciding, batch } = useWorkView.getState();
  const owner = list.find((n) => n.key === deciding);
  if (batch === null && !owner) return null;
  return <WorkstreamNeeds needs={list} workstreamId={batch !== null ? (batch === "general" ? null : batch) : owner!.workstreamId} />;
}
import { NeedsYouList, firstText, groupText, hasMoreBelow } from "./NeedsYou";
import { slotWaiters, stopAllLabel, stoppable, summaryLine, yourAgents } from "./agentsLogic";
import { arm, confirmArmed, disarm, keyPlan, openInWorkstream, openNeed } from "./needsActions";
import { BATCH_TITLE, composerFooter } from "./workViewLogic";
import { useWorkView } from "./workViewStore";
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
const run = (id: string, state: Run["state"], over: Partial<Run> = {}): Run => ({ ...base, id, state, item: ref("CA-401"), spec: { ...base.spec, role: "build", workstream: "ws-1" }, failure: null, needs: null, lastProgressAt: ago(5), queuedAt: ago(60), endedAt: null, ...over });

const view = (id: string, key: string | null, title: string, over: { pausedReason?: PauseReason | null; runs?: string[] } = {}): WorkstreamView => ({
  workstream: {
    id,
    connectionId: "mock",
    itemKey: key,
    repo: null,
    title,
    pipSession: null,
    pausedReason: over.pausedReason ?? null,
    notes: null,
    createdAt: ago(600),
    closedAt: null,
    basis: null,
  },
  stage: "build",
  runs: over.runs ?? [],
  labels: (over.runs ?? []).map((r, n) => [r, `R${n + 1}`]),
});

const draft = (id: string, intent: Intent, minutes: number, workstream: string | null = null): Proposal =>
  ({ id, createdAt: ago(minutes), updatedAt: ago(minutes), origin: { type: "chat", requestId: `q-${id}`, workstream }, createdBy: "pip", intent, label: null, basis: null, state: { type: "pending" }, revisions: [], created: [], error: null, run: null }) as unknown as Proposal;

const comment = (key: string, text = "Checking in."): Intent => ({ type: "comment", item: ref(key), body: docFromText(text), mentions: [] }) as unknown as Intent;
const transition = (key: string): Intent => ({ type: "transition", item: ref(key), to: "done" }) as unknown as Intent;
const rewrite = (key: string): Intent => ({ type: "rewrite", item: ref(key), title: null, body: { from: docFromText("a"), to: docFromText("b"), fromText: "a", toText: "b" }, flattened: [] }) as unknown as Intent;

const ws1 = view("ws-1", "CA-401", "CA-401 Welcome flow refresh", { runs: ["r-perm", "r-q", "r-fail"] });
const ws2 = view("ws-2", "CA-402", "CA-402 Cart merge", { pausedReason: "ceiling" });

const input = (over: Partial<NeedsInput> = {}): NeedsInput => ({
  workstreams: [ws1, ws2],
  runs: [
    run("r-perm", "needsPermission", { needs: "approve Bash: git push origin ca-401", lastProgressAt: ago(14) }),
    run("r-q", "needsAnswer", { needs: "Which cache should it keep?", lastProgressAt: ago(9) }),
    run("r-fail", "failed", { error: "Launch was interrupted", lastProgressAt: ago(8), endedAt: ago(8), spec: { ...base.spec, role: "verify", workstream: "ws-1" } }),
  ],
  proposals: [draft("c1", comment("CA-401"), 30, "ws-1"), draft("c2", transition("CA-401"), 25, "ws-1"), draft("c3", comment("CA-401", "Another"), 24, "ws-1"), draft("g1", comment("CA-500"), 10)],
  dismissed: new Set(),
  titleOf: (key) => (key === "CA-500" ? "Loose ticket" : null),
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
  useWorkView.getState().reset();
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
    expect(html).toContain('aria-label="8 waiting"');
    // The hold is the oldest of what is stuck, so its workstream's row leads.
    const rows = [...html.matchAll(/data-needs-you-row="([^"]+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(["ws-2", "ws-1", "general"]);
    expect([...html.matchAll(/data-needs-you-key[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["CA-402", "CA-401"]);
    expect([...html.matchAll(/data-needs-you-head[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["Cart merge", "Welcome flow refresh", "General"]);
    expect([...html.matchAll(/data-needs-you-chip="(\w+)"/g)].map((m) => m[1])).toEqual(["unblock", "unblock", "approve"]);
    expect(html).toContain("R1 wants to run `git push origin ca-401`.");
    expect(html).toContain("Pip was woken too often today, so Gossamr paused it.");
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

  it("opens each group by default on the Agents strip while its needs fit, with the group's header only its name and count", () => {
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} main />);
    // The 8 needs fit: ws-1 shows its six, once each, and no why line is repeated on its header.
    expect([...html.matchAll(/data-needs-you-need="([^"]+)"/g)].map((m) => m[1])).toEqual(["run:r-perm", "run:r-q", "run:r-fail", "draft:c1", "draft:c2", "draft:c3"]);
    const ws1 = html.slice(html.indexOf('data-needs-you-row="ws-1"')).split("</li></ul>")[0];
    expect(ws1).toContain("6 here");
    expect(ws1).toContain("6 waiting in this workstream");
    expect(ws1.split('<ul id="needs-you-group-ws-1"')[0]).not.toContain("data-needs-you-why");
    // The person's fold is kept, and a longer list stays folded as before.
    seed(useWorkView, { collapsed: new Set(["ws-1"]) });
    const folded = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} main />);
    expect(folded).not.toContain("data-needs-you-need=");
    expect(folded).toContain("+5 more");
    unseed();
    expect(renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />)).not.toContain("data-needs-you-need=");
  });

  it("says a clipped list has more below only while there is more to scroll to (G26)", () => {
    expect(hasMoreBelow({ scrollHeight: 600, scrollTop: 0, clientHeight: 300 })).toBe(true);
    expect(hasMoreBelow({ scrollHeight: 600, scrollTop: 150, clientHeight: 300 })).toBe(true);
    // At the foot, or within a rounding pixel of it, or not clipped at all, there is no fade.
    expect(hasMoreBelow({ scrollHeight: 600, scrollTop: 300, clientHeight: 300 })).toBe(false);
    expect(hasMoreBelow({ scrollHeight: 600, scrollTop: 298, clientHeight: 300 })).toBe(false);
    expect(hasMoreBelow({ scrollHeight: 200, scrollTop: 0, clientHeight: 300 })).toBe(false);
    // Nothing is measured before the page has laid it out, so the markup carries no fade.
    expect(renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />)).not.toContain("data-needs-you-fade");
  });

  it("explains Decide, Unblock and Approve on the chips", () => {
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(html).toMatch(/data-needs-you-chip="unblock" title="Unblock: [^"]+"/);
    expect(html).toMatch(/data-needs-you-chip="approve" title="Approve: [^"]+"/);
  });

  it("keeps a group folded until it is expanded, then lists every need in it, the top one first", () => {
    const folded = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).not.toContain("data-needs-you-need=");
    seed(useWorkView, { expanded: new Set(["ws-1"]) });
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

  it("as the Agents strip, sizes to its content up to a third of the window and scrolls inside it (G7)", () => {
    const html = renderToStaticMarkup(<NeedsYouList main needs={list} now={NOW} />);
    const region = /<section aria-label="Needs you"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(region).toContain("shrink");
    expect(region).not.toContain("flex-1");
    expect(region).toContain("overflow-y-auto");
    expect(region).toContain("max-h-[min(36vh,20rem)]");
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
    seed(useWorkView, { expanded: new Set(["ws-1"]) });
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(html).toContain("Approve 3 safe drafts");
    expect(html.match(/Approve \d+ safe drafts/g)).toHaveLength(1);
    // The button says what makes a draft safe, and what is left to approve one by one.
    expect(html).toContain(`title="${BATCH_TITLE}"`);
    expect(BATCH_TITLE).toMatch(/comments, status moves and subtasks[^.]*\. A description rewrite/);
    // A group with a single batchable draft has no batch to offer.
    const lone = needs(input({ proposals: [draft("c1", comment("CA-401"), 30, "ws-1")] }));
    expect(renderToStaticMarkup(<NeedsYouList needs={lone} now={NOW} />)).not.toContain("safe drafts");
  });

  it("keeps the batch's preview out of the list: its button opens it in the pane", () => {
    seed(useWorkspace, { proposals: Object.fromEntries(input().proposals.map((p) => [p.id, p])) });
    seed(useWorkView, { expanded: new Set(["ws-1"]), batch: "ws-1" });
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(html).toContain("Approve 3 safe drafts");
    expect(html).not.toContain("data-needs-you-batch-preview");
    expect(html).not.toContain("Yes, approve");
    useWorkView.getState().previewBatch("ws-1");
    expect(useWorkView.getState().batch).toBe("ws-1");
  });

  it("marks an open group's top need, listed again under it, so j and k step past it", () => {
    seed(useWorkView, { expanded: new Set(["ws-1"]) });
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    const group = needGroups(list).find((g) => g.workstreamId === "ws-1")!;
    expect([...html.matchAll(/data-needs-top=""/g)]).toHaveLength(1);
    expect(html).toMatch(new RegExp(`data-needs-you-need="${group.top.key}"[^>]*data-needs-top=""`));
    expect(html.match(/data-needs-you-need=/g)).toHaveLength(group.count);
    // Folded, a group is its one row.
    unseed();
    const folded = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(folded).not.toContain("data-needs-top=\"\"");
  });

  it("names the top need on an open group's row, which j and k step past (G11)", () => {
    seed(useWorkView, { expanded: new Set(["ws-1"]) });
    const group = needGroups(list).find((g) => g.workstreamId === "ws-1")!;
    const label = firstText(group);
    expect(label).toContain(`${group.count} waiting here. First: `);
    expect(label).toContain(group.top.title);
    expect(label).toContain("Enter decides it.");
    const html = renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />);
    expect(html).toContain(`aria-label="${label.replace(/'/g, "&#x27;")}"`);
    unseed();
    expect(renderToStaticMarkup(<NeedsYouList needs={list} now={NOW} />)).not.toContain("Enter decides it.");
  });

  it("says so when nothing waits", () => {
    const html = renderToStaticMarkup(<NeedsYouList needs={[]} now={NOW} />);
    expect(html).toMatch(/data-needs-you-count[^>]*>0</);
    expect(html).toContain("Nothing needs you.");
    expect(html).not.toContain("data-needs-you-group");
  });

  it("marks the need whose decision is open, and says what a key is waiting for on its row", () => {
    seed(useWorkView, { expanded: new Set(["ws-1"]), deciding: "run:r-q", asking: { key: "run:r-perm", text: "↵ deny it; Claude carries on without it · any other key cancels" } });
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

  const home = (n: Need) => n.workstreamId ?? "general";

  it("on Agents turns the Needs you filter on and opens its workstream's detail with the decision open", () => {
    useTabs.getState().setRoute("agents");
    openNeed(need("run:r-perm"));
    expect(useTabs.getState().route).toBe("agents");
    expect(useWorkView.getState()).toMatchObject({ selected: home(need("run:r-perm")), deciding: "run:r-perm", asking: null });
    expect(useRuns.getState().filters.needs).toBe(true);
  });

  it("from another route goes to Agents first, wherever the need is", () => {
    useTabs.getState().setRoute("workspace");
    openNeed(need("paused:ws-2"));
    expect(useTabs.getState().route).toBe("agents");
    expect(useWorkView.getState()).toMatchObject({ selected: "ws-2", deciding: "paused:ws-2" });
  });

  it("opens a need in no workstream under No workstream, whose detail works the same way", () => {
    useWorkView.getState().openWorkstream("ws-1");
    openNeed(need("draft:g1"));
    expect(useWorkView.getState()).toMatchObject({ selected: "general", deciding: "draft:g1" });
  });

  it("'Open in workstream' shows the card in the workstream's detail and leaves the filters alone; a run's sheet opens over it", () => {
    useTabs.getState().setRoute("agents");
    useRuns.getState().clearFilters();
    openInWorkstream(need("draft:c1"));
    expect(useWorkView.getState()).toMatchObject({ selected: "ws-1", focusTarget: { type: "draft", id: "c1" } });
    expect(useRuns.getState().filters.needs).toBe(false);
    expect(useRuns.getState().sheet).toBeNull();
    openInWorkstream(need("paused:ws-2"));
    expect(useWorkView.getState()).toMatchObject({ selected: "ws-2", focusTarget: { type: "workstream" } });
    openInWorkstream(need("run:r-q"));
    expect(useWorkView.getState().focusTarget).toEqual({ type: "run", id: "r-q" });
    expect(useRuns.getState().sheet).toEqual({ type: "run", id: "r-q" });
    openInWorkstream(need("draft:g1"));
    expect(useWorkView.getState().selected).toBe("general");
  });
});

describe("what the list's keys do", () => {
  const proposals = [...input().proposals, draft("rw", rewrite("CA-401"), 40, "ws-1")];
  const list = needs(input({ proposals }));
  const need = (key: string) => list.find((n) => n.key === key)!;

  beforeEach(() => {
    useWorkspace.setState({ proposals: Object.fromEntries(proposals.map((p) => [p.id, p])) });
    useRuns.setState({ runs: [...input().runs] });
  });

  it("asks for Enter before it approves a comment or a move, or dismisses, and only then does it", () => {
    const plan = keyPlan(need("draft:c1"), "approve");
    expect(plan).toMatchObject({ type: "ask", text: "approve this draft" });
    expect(keyPlan(need("draft:c2"), "approve")).toMatchObject({ type: "ask" });
    // A permission prompt is answered in Terminal: its key only opens, and there is nothing to dismiss.
    expect(keyPlan(need("run:r-perm"), "approve")).toEqual({ type: "open", edit: false });
    expect(keyPlan(need("run:r-perm"), "dismiss")).toBeNull();
    const dismiss = keyPlan(need("run:r-fail"), "dismiss");
    expect(dismiss).toMatchObject({ type: "do" });
    if (plan?.type !== "ask") throw new Error("an approval asks first");
    // Nothing happens until Enter confirms what was asked.
    arm(need("draft:c1"), plan);
    expect(useWorkView.getState().asking).toEqual({ key: "draft:c1", text: "↵ approve this draft · any other key cancels" });
    expect(useWorkView.getState().asking).not.toBeNull();
    disarm();
    expect(useWorkView.getState().asking).toBeNull();
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
    expect(keyPlan(need("run:r-perm"), "approve")).toMatchObject({ type: "open" });
    expect(keyPlan(need("paused:ws-2"), "approve")).toMatchObject({ type: "ask", text: "resume this workstream" });
  });

  it("opens the decision where there is something to read first: a rewrite's diff and a question", () => {
    expect(keyPlan(need("draft:rw"), "approve")).toEqual({ type: "open", edit: false });
    expect(keyPlan(need("run:r-q"), "approve")).toEqual({ type: "open", edit: false });
    expect(keyPlan(need("paused:ws-2"), "approve")).toMatchObject({ type: "ask", text: "resume this workstream" });
  });

  it("opens an edit where the draft has one, and means nothing where it has none", () => {
    expect(keyPlan(need("draft:c1"), "edit")).toEqual({ type: "open", edit: true });
    expect(keyPlan(need("run:r-q"), "edit")).toEqual({ type: "open", edit: true });
    expect(keyPlan(need("run:r-perm"), "edit")).toBeNull();
    expect(keyPlan(need("paused:ws-2"), "edit")).toBeNull();
    expect(keyPlan(need("paused:ws-2"), "dismiss")).toBeNull();
    expect(keyPlan(need("paused:ws-2"), "skip")).toBeNull();
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
    seed(useWorkView, { deciding: key });
    return renderToStaticMarkup(<NeedsPane needs={list} />);
  };

  it("opens nothing until a need is chosen, and nothing for a need that is gone", () => {
    const list = set();
    expect(renderToStaticMarkup(<NeedsPane needs={list} />)).toBe("");
    seed(useWorkView, { deciding: "run:gone" });
    expect(renderToStaticMarkup(<NeedsPane needs={list} />)).toBe("");
  });

  it("opens a group's safe drafts as one decision: what each does, then the one confirm; a batch with fewer than two says so", () => {
    const list = set();
    seed(useWorkView, { batch: "ws-1" });
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
    seed(useWorkView, { batch: "general" });
    expect(renderToStaticMarkup(<NeedsPane needs={list} />)).toContain("These drafts are no longer waiting together.");
  });

  it("a batch and a need's decision replace each other, and closing clears either", () => {
    const home = useWorkView.getState();
    home.decide("run:r-perm");
    home.previewBatch("ws-1");
    expect(useWorkView.getState()).toMatchObject({ deciding: null, batch: "ws-1" });
    expect([...useWorkView.getState().expanded]).toContain("ws-1");
    useWorkView.getState().decide("run:r-perm");
    expect(useWorkView.getState()).toMatchObject({ deciding: "run:r-perm", batch: null });
    useWorkView.getState().previewBatch("ws-1");
    useWorkView.getState().closeDecision();
    expect(useWorkView.getState()).toMatchObject({ deciding: null, batch: null });
  });

  it("heads the decision with why and what waiting does, under a Needs you heading in the workstream's detail", () => {
    const list = set();
    const html = pane(list, "run:r-perm");
    expect(html).toContain("data-workstream-needs=");
    expect(html).toMatch(/data-workstream-needs-title[^>]*>Needs you/);
    expect(html).toContain("R1 wants to run `git push origin ca-401`.");
    expect(html).toContain("If you wait:");
    expect(html).toContain("The run stays paused; nothing else in CA-401 moves.");
    expect(html).not.toContain("Open in workstream");
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

  it("decides a sign-in with the sign-in box", () => {
    const list = set({ runs: [run("r-s", "systemBlocked")], proposals: [], workstreams: [view("ws-1", "CA-401", "CA-401 Welcome flow refresh", { runs: ["r-s", "r-l"] })] });
    expect(pane(list, "run:r-s")).toContain("Claude needs you to sign in");
    expect(pane(list, "run:r-s")).toContain("R1 needs you to sign in to Claude.");
  });

  it("decides a pause with the paused banner's Resume, and a draft with its card", () => {
    const list = set();
    const paused = pane(list, "paused:ws-2");
    expect(paused).toContain("data-paused-banner");
    expect(paused).toContain("Resume");
    const card = pane(list, "draft:c1");
    expect(card).toContain('data-draft="c1"');
    expect(card).toContain("Nothing is written to Jira until you approve it.");
  });

  it("decides a plan with its approval note", () => {
    const planRun = run("r-plan", "done", { spec: { ...base.spec, role: "plan", workstream: "ws-1" } });
    const list = set({ workstreams: [view("ws-1", "CA-401", "CA-401 Welcome flow refresh", { runs: ["r-plan"] })], runs: [planRun], proposals: [{ ...draft("plan", rewrite("CA-401"), 4, "ws-1"), origin: { type: "run", runId: "r-plan", shortId: null, workstream: "ws-1" } } as Proposal], dismissed: new Set() });
    expect(pane(list, "draft:plan")).toContain("data-plan-approve");
  });

  it("keeps a draft's action bar in the flow at the card's end, and does not make the stack a scroller of its own", () => {
    const html = pane(set({ workstreams: [], runs: sample, proposals: [draft("c1", comment("CA-401"), 3)], dismissed: new Set() }), "draft:c1");
    expect(html).toMatch(/<section[^>]*data-needs-pane="draft:c1"[^>]*class="[^"]*\[&amp;_\[data-draft-actions\]\]:static/);
    expect(html.match(/[ "]overflow-y-auto[ "]/g)).toBeNull();
  });

  it("stacks a workstream's needs most urgent first, each with its why, and only the open one decided", () => {
    const list = set();
    const ws1Needs = list.filter((n) => n.workstreamId === "ws-1");
    expect(ws1Needs.length).toBeGreaterThan(1);
    seed(useWorkView, { deciding: ws1Needs[1].key, batch: null });
    const html = renderToStaticMarkup(<WorkstreamNeeds needs={list} workstreamId="ws-1" />);
    expect([...html.matchAll(/data-needs-pane="([^"]+)"/g)].map((m) => m[1])).toEqual(ws1Needs.map((n) => n.key));
    expect(html.match(/data-needs-pane-body/g)).toHaveLength(1);
    expect(html.match(/data-needs-if-you-wait/g)).toHaveLength(1);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`data-needs-pane="${ws1Needs[1].key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*data-open`));
  });

  it("holds the needs that belong to no workstream in the same stack", () => {
    const list = set();
    const loose = list.filter((n) => n.workstreamId === null);
    expect(loose.length).toBeGreaterThan(0);
    seed(useWorkView, { deciding: loose[0].key, batch: null });
    const html = renderToStaticMarkup(<WorkstreamNeeds needs={list} workstreamId={null} />);
    expect(html).toContain('data-workstream-needs="general"');
    expect(html).toContain(`data-needs-pane="${loose[0].key}"`);
  });
});

describe("every count of needs you and of agents, from one fixture (D4, D5, N3)", () => {
  const runs = sample;
  const at = NOW;
  const proposals = [draft("p1", comment("CA-401"), 3), draft("p2", rewrite("CA-401"), 3)];
  const failed = runs.find((r) => r.state === "failed")!;

  for (const dismissed of [new Set<string>(), new Set([failed.id])]) {
    it(`agrees on the list, the rail badge, the composer, the launcher, the Agents header, Your agents and Stop all${dismissed.size ? ", once the failed run was dismissed" : ""}`, () => {
      const list = needs({ workstreams: [], runs, proposals, dismissed });
      const n = list.length;
      // A permission and a question, and the failed run until it is dismissed; a quiet run is not a need.
      expect(n).toBe(2 + (dismissed.size ? 0 : 1) + proposals.length);
      // One number: the list's pill, the rail badge, the composer footer, the launcher and the Agents header.
      expect(renderToStaticMarkup(<NeedsYouList needs={list} now={at} />)).toMatch(new RegExp(`data-needs-you-count[^>]*>${n}<`));
      expect(railBadgeText.agents(n)).toBe(needsYouText(n));
      expect(Number(/(\d+) needs? you/.exec(composerFooter(runs, n, at))?.[1])).toBe(n);
      expect(renderToStaticMarkup(<Launcher needs={n} onOpen={() => {}} />)).toContain(`Ask Pip, ${needsYouText(n)}`);
      expect(summaryLine(runs, at, n)).toMatch(new RegExp(`^${n} need you · `));
      // Its agent part: the run needs among them, and Agents has no badge of its own.
      const waiting = list.filter((x) => x.runId);
      expect(n).toBe(waiting.length + proposals.length);
      // Your agents: the strip's "3 of M" is every agent, the waiting ones among them.
      const mine = yourAgents(runs, dismissed);
      const strip = renderToStaticMarkup(<PipRunStripView runs={runs} now={at} dismissed={dismissed} titleOf={() => null} onOpen={() => {}} onSeeAll={() => {}} />);
      expect(Number(/data-strip-count[^>]*>\d+ of (\d+)</.exec(strip)?.[1])).toBe(mine.length);
      // The header's need count is that same one list.
      expect(Number(/^(\d+) needs? you/.exec(summaryLine(runs, at, n))?.[1] ?? 0)).toBe(n);
      // Stop all counts a set of its own, and says so.
      expect(stopAllLabel(stoppable(runs).length + slotWaiters(runs).length)).toMatch(/^Stop all \(\d+ stoppable\)$/);
    });
  }

  it("keeps a folder to trust, and every other failure, in the count until it is dismissed (R5)", () => {
    const trust = runs.find((r) => r.failure?.type === "untrustedFolder")!;
    const other = { ...trust, id: "r-other", failure: { type: "other" }, spec: { ...trust.spec, role: trust.spec.role === "verifier" ? "reviewer" : "verifier" } } as unknown as typeof trust;
    const all = [...runs, other];
    useRuns.setState({ runs: all, dismissed: new Set() });
    // Opening Agents once marked every failure but the folder as seen; nothing does that now.
    const listed = (dismissed: ReadonlySet<string>) => needs({ workstreams: [], runs: all, proposals: [], dismissed }).filter((x) => x.kind === "failure").map((x) => x.runId);
    expect(listed(new Set())).toEqual(expect.arrayContaining([trust.id, other.id]));
    useRuns.getState().dismiss(other.id);
    expect(listed(useRuns.getState().dismissed)).toEqual(expect.arrayContaining([trust.id]));
    expect(listed(useRuns.getState().dismissed)).not.toContain(other.id);
  });
});
