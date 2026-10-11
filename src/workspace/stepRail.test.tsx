import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { CodeChange, Intent, ItemRef, Proposal, ReviewView, Run, RunKind, RunState, WorkstreamEvent, WorkstreamView } from "../types";
import { freezeBatch } from "./pipHomeLogic";
import { approveBatch, BATCH_CHANGED, BatchConfirm, confirmBatch, EarlierStepDrafts, planResultFor, StepDrafts, StepRailView, type StepRailViewProps } from "./StepRail";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const ref = (key: string): ItemRef => ({ connectionId: "mock", externalId: key, key });

const base = new MockBackend().runs.list()[0];
const run = (id: string, kind: RunKind, state: RunState, minutesAgo: number, over: Partial<Run> = {}): Run => ({
  ...base,
  id,
  shortId: id,
  state,
  item: ref("CA-401"),
  spec: { ...base.spec, kind, workstream: "ws-1" },
  failure: null,
  queuedAt: iso(minutesAgo),
  lastProgressAt: iso(minutesAgo - 1),
  endedAt: state === "done" ? iso(minutesAgo - 2) : null,
  autoStart: null,
  ...over,
});

const RUNS = [
  run("r1", "investigate", "done", 90),
  run("r2", "triage", "done", 80, { autoStart: { rule: "investigate_triage", afterRun: "r1" } }),
  run("r3", "plan", "done", 70, { autoStart: { rule: "triage_plan", afterRun: "r2" } }),
  run("r4", "build", "done", 60, { autoStart: { rule: "plan_build", afterRun: "r3" } }),
  run("r5", "review", "done", 50, { autoStart: { rule: "build_review", afterRun: "r4" } }),
];

const view: WorkstreamView = {
  workstream: {
    id: "ws-1",
    connectionId: "mock",
    itemKey: "CA-401",
    repo: null,
    title: "CA-401 Retry the export",
    pipSession: null,
    mode: "manage",
    heldReason: null,
    notes: "Plan first, then build.",
    createdAt: iso(120),
    closedAt: null,
    budget: { autoTurns: null, wakes: null, tokens: null },
    spent: { autoTurns: 0, wakes: 0, tokens: 0 },
    rules: {},
    basis: null,
  },
  stage: "review",
  runs: RUNS.map((r) => r.id),
  labels: RUNS.map((r, n) => [r.id, `R${n + 1}`]),
  waitingForPr: null,
  budget: { autoTurns: { used: 0, limit: 6 }, wakes: { used: 0, limit: 12 }, level: "ok" },
};

const event = (action: string, runId: string | null): WorkstreamEvent => ({ workstreamId: "ws-1", seq: 1, at: iso(10), actor: "supervisor", action, runId, proposalId: null, digest: null, detail: null });

const comment: Intent = { type: "comment", item: ref("CA-401"), body: { blocks: [] } as never };
const transition: Intent = { type: "transition", item: ref("CA-401"), to: "31" };
const rewrite: Intent = { type: "rewrite", item: ref("CA-401"), title: { from: "Old", to: "New" } as never, body: null, flattened: [] };
const describe_: Intent = { type: "rewrite", item: ref("CA-401"), title: null, body: { blocks: [] } as never, flattened: [] };

const draft = (id: string, intent: Intent, minutesAgo: number, origin: Proposal["origin"] = { type: "chat", requestId: `q-${id}`, workstream: "ws-1" }): Proposal =>
  ({ id, createdAt: iso(minutesAgo), updatedAt: iso(minutesAgo), origin, createdBy: origin.type === "run" ? "agent" : "pip", intent, label: null, basis: null, state: { type: "pending" }, revisions: [], created: [], error: null, run: null }) as Proposal;
const fromRun = (id: string, intent: Intent, runId: string, minutesAgo = 5) => draft(id, intent, minutesAgo, { type: "run", runId, shortId: runId, workstream: "ws-1" });

const props = (over: Partial<StepRailViewProps> = {}): StepRailViewProps => ({
  view,
  runs: RUNS,
  events: [],
  verdicts: {},
  proposals: [],
  now: NOW,
  titleOf: () => null,
  onOpenRun: vi.fn(),
  approve: vi.fn(),
  ...over,
});

/** The rendered `<li>` of step `kind`: up to the next step's, or the end of the list. */
const stepOf = (html: string, kind: RunKind) => {
  const start = html.indexOf(`data-step="${kind}"`);
  const next = html.indexOf('data-step="', start + 1);
  return html.slice(start, next > -1 ? next : html.indexOf("</ol>", start));
};

beforeEach(() => vi.stubGlobal("localStorage", memory()));
afterEach(() => vi.unstubAllGlobals());

describe("the Plan step while its description update waits (N6)", () => {
  it("says approving it lets Build start, and lists the questions the plan left open", () => {
    const planned = RUNS.map((r) => (r.id === "r3" ? { ...r, result: "## Steps\n\n1. Do it\n\n## Open questions for a person\n\n- Do the Klaviyo flows read the subjects?\n- Keep the two-day delay?" } : r));
    const html = renderToStaticMarkup(<StepRailView {...props({ runs: planned, proposals: [fromRun("d-desc", describe_, "r3")] })} />);
    const plan = stepOf(html, "plan");
    expect(plan).toContain("data-plan-approve");
    expect(plan).toContain("Approve the description update to let Build start.");
    expect(plan).toContain("The plan leaves 2 open questions for you.");
    expect([...plan.matchAll(/<li class="\[overflow-wrap:anywhere\]">([^<]+)<\/li>/g)].map((m) => m[1])).toEqual(["Do the Klaviyo flows read the subjects?", "Keep the two-day delay?"]);
    // Nowhere else, and not once the description update is decided.
    expect(html.match(/data-plan-approve/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<StepRailView {...props({ runs: planned })} />)).not.toContain("data-plan-approve");
  });

  it("takes the open questions from the plan the waiting update came from, not a later plan", () => {
    const earlier = run("p1", "plan", "done", 30, { result: "## Open questions for a person\n\n- The earlier plan's question?" });
    const later = run("p2", "plan", "done", 5, { result: "## Open questions for a person\n\n- The later plan's question?" });
    const waiting = fromRun("d-desc", describe_, "p1");
    expect(planResultFor(waiting, [earlier, later], later)).toBe(earlier.result);
    // A draft not made from a run falls back to the step's newest plan.
    expect(planResultFor({ ...waiting, origin: { type: "board" } }, [earlier, later], later)).toBe(later.result);
  });

  it("says nothing of approving for a rewrite of the title alone: there is no description update", () => {
    const html = renderToStaticMarkup(<StepRailView {...props({ proposals: [fromRun("d-title", rewrite, "r3")] })} />);
    expect(html).not.toContain("data-plan-approve");
  });
});

describe("the step rail", () => {
  it("shows Pip's notes, the workstream's controls, then the six steps in order", () => {
    const html = renderToStaticMarkup(<StepRailView {...props()} />);
    expect(html).toContain("Plan first, then build.");
    expect(html.indexOf("Plan first, then build.")).toBeLessThan(html.indexOf("Manage this workstream"));
    const order = [...html.matchAll(/data-step="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["investigate", "triage", "plan", "build", "review", "verify"]);
    expect(html.indexOf("Manage this workstream")).toBeLessThan(html.indexOf('data-step="investigate"'));
  });

  it("derives each chip from the runs: label and state, started automatically, the verdict and the fix round", () => {
    const verdicts: Record<string, ReviewView | null> = { r5: { verdict: "blocking", blocking: 2 } as ReviewView };
    const html = renderToStaticMarkup(<StepRailView {...props({ verdicts, events: [event("fix_round_sent", "r4")] })} />);
    expect(stepOf(html, "investigate")).toContain('data-run-label="R1"');
    expect(stepOf(html, "investigate")).toContain("Ready to review");
    expect(stepOf(html, "investigate")).not.toContain("started automatically");
    expect(stepOf(html, "triage")).toContain("started automatically");
    expect(stepOf(html, "review")).toMatch(/data-step-verdict[^>]*>· Blocking · 2</);
    expect(stepOf(html, "build")).toMatch(/data-step-fix-round[^>]*>· fix round 1\/2</);
    expect(stepOf(html, "verify")).toContain("Not started");
    const passed = renderToStaticMarkup(<StepRailView {...props({ verdicts: { r5: { verdict: "pass", blocking: 0 } as ReviewView } })} />);
    expect(stepOf(passed, "review")).toMatch(/data-step-verdict[^>]*>· Pass</);
    // A running investigation says so.
    const running = renderToStaticMarkup(<StepRailView {...props({ runs: [run("r1", "investigate", "working", 5)], view: { ...view, runs: ["r1"], labels: [["r1", "R1"]] } })} />);
    expect(stepOf(running, "investigate")).toMatch(/data-run-label="R1"[\s\S]*Working/);
  });

  it("marks the next step and keeps the later steps nothing has reached to one quiet line each", () => {
    const fresh = renderToStaticMarkup(<StepRailView {...props({ runs: [], view: { ...view, runs: [], labels: [], stage: "intake" } })} />);
    expect(stepOf(fresh, "investigate")).toContain('data-step-next="investigate"');
    expect(stepOf(fresh, "investigate")).toContain("Not started");
    expect(stepOf(fresh, "investigate")).toContain(">Next<");
    expect(stepOf(fresh, "investigate")).not.toContain("data-step-quiet");
    for (const kind of ["triage", "plan", "build", "review", "verify"] as const) {
      expect(stepOf(fresh, kind)).toContain('data-step-quiet="true"');
      expect(stepOf(fresh, kind)).not.toContain("Not started");
      expect(stepOf(fresh, kind)).not.toContain("data-step-next");
    }
    expect(fresh.match(/data-step-next=/g)).toHaveLength(1);
    // The next step is marked by a bar down its edge, not an outline in the focus ring's colour; quiet labels stay readable.
    const nextChip = /<button[^>]*data-step-next="investigate"[^>]*>/.exec(fresh)![0];
    expect(nextChip).toContain("shadow-[inset_3px_0_0_var(--color-ws-pip)]");
    expect(nextChip).not.toMatch(/\bborder-ws-pip\b/);
    expect(stepOf(fresh, "plan")).toMatch(/<b class="text-sm font-normal text-ws-ink2">Plan<\/b>/);
    // Once the investigation is done, Triage is next; the investigation reads as it did.
    const investigated = renderToStaticMarkup(<StepRailView {...props({ runs: [RUNS[0]], view: { ...view, runs: ["r1"], labels: [["r1", "R1"]] } })} />);
    expect(stepOf(investigated, "triage")).toContain('data-step-next="triage"');
    expect(stepOf(investigated, "investigate")).toContain('data-run-label="R1"');
    expect(stepOf(investigated, "investigate")).toContain("Ready to review");
    expect(stepOf(investigated, "investigate")).not.toContain("data-step-quiet");
    expect(stepOf(investigated, "plan")).toContain("data-step-quiet");
  });

  it("leaves the steps with runs as they were, and a step with a draft waiting is never quiet", () => {
    const html = renderToStaticMarkup(<StepRailView {...props()} />);
    for (const kind of ["investigate", "triage", "plan", "build", "review"] as const) {
      expect(stepOf(html, kind)).not.toContain("data-step-quiet");
      expect(stepOf(html, kind)).not.toContain("data-step-next");
    }
    expect(stepOf(html, "verify")).toContain('data-step-next="verify"');
    const start: Intent = { type: "startRun", connectionId: "mock", item: ref("CA-401"), spec: { ...base.spec, kind: "plan", workstream: "ws-1" } };
    const waiting = renderToStaticMarkup(<StepRailView {...props({ runs: [], view: { ...view, runs: [], labels: [] }, proposals: [draft("d-plan", start, 3)] })} />);
    expect(stepOf(waiting, "plan")).not.toContain("data-step-quiet");
    expect(stepOf(waiting, "plan")).toContain("data-step-needs-you");
  });

  it("shows the build's pull request under the Build chip once a sync has found it, and not while it waits for it", () => {
    const waiting = renderToStaticMarkup(<StepRailView {...props({ view: { ...view, waitingForPr: "r4" } })} />);
    expect(stepOf(waiting, "build")).toMatch(/data-step-state[^>]*>waiting for PR</);
    expect(waiting).not.toContain("data-step-pr");
    const change = { kind: "pullRequest", number: 301, title: "CA-401: Build (agent)", url: "https://github.com/acme/webshop/pull/301", state: "draft" } as CodeChange;
    const found = renderToStaticMarkup(<StepRailView {...props({ changes: { r4: change } })} />);
    const build = stepOf(found, "build");
    expect(build).not.toContain("waiting for PR");
    expect(build).toMatch(/data-step-pr[\s\S]*Draft PR[\s\S]*>#301 CA-401: Build \(agent\)<\/button>/);
    expect(found.match(/data-step-pr/g)).toHaveLength(1);
  });

  it("keeps each chip closed until opened; opened, it lists its runs and the drafts about it", () => {
    const proposals = [fromRun("c1", comment, "r5", 8), fromRun("c2", comment, "r5", 6), draft("pip1", comment, 4), draft("run1", { type: "startRun", connectionId: "mock", item: ref("CA-401"), spec: { ...base.spec, kind: "verify", workstream: "ws-1" } } as unknown as Intent, 3)];
    const closed = renderToStaticMarkup(<StepRailView {...props({ proposals })} />);
    expect(closed).toMatch(/aria-expanded="false" aria-controls="step-ws-1-review"/);
    expect(closed).not.toContain('data-draft="c1"');
    // Pip's own drafts are always shown, at the top, before the steps.
    expect(closed).toContain('aria-label="Pip&#x27;s drafts"');
    expect(closed.indexOf('data-draft="pip1"')).toBeLessThan(closed.indexOf('data-step="investigate"'));
    expect(stepOf(closed, "review")).toMatch(/data-step-needs-you[^>]*>2 need you</);
    expect(stepOf(closed, "verify")).toMatch(/data-step-needs-you[^>]*>1 needs you</);

    const open = renderToStaticMarkup(<StepRailView {...props({ proposals, initialOpen: ["review", "verify"] })} />);
    const review = stepOf(open, "review");
    expect(review).toMatch(/aria-expanded="true" aria-controls="step-ws-1-review"/);
    expect(review).toContain('data-run-id="r5"');
    expect(review.indexOf('data-draft="c1"')).toBeLessThan(review.indexOf('data-draft="c2"'));
    expect(stepOf(open, "verify")).toContain('data-draft="run1"');
    expect(stepOf(open, "investigate")).not.toContain("data-draft");
  });

  it("offers 'Approve these N' for two or more comments, moves or subtasks, and never counts a rewrite", () => {
    const approve = vi.fn();
    const two = renderToStaticMarkup(<StepDrafts step="review" drafts={[fromRun("c1", comment, "r5"), fromRun("t1", transition, "r5"), fromRun("rw", rewrite, "r5")]} approve={approve} />);
    expect(two).toContain(">Approve these 2</button>");
    expect(two).toContain('data-draft="rw"');
    const one = renderToStaticMarkup(<StepDrafts step="review" drafts={[fromRun("c1", comment, "r5"), fromRun("rw", rewrite, "r5"), fromRun("rw2", rewrite, "r5")]} approve={approve} />);
    expect(one).not.toContain("Approve these");
    expect(approve).not.toHaveBeenCalled();
  });

  it("asks first, inline, with Yes focused; Esc there cancels and approves nothing", () => {
    const html = renderToStaticMarkup(<StepDrafts step="review" drafts={[fromRun("c1", comment, "r5"), fromRun("c2", comment, "r5")]} approve={vi.fn()} initialConfirming />);
    expect(html).toMatch(/role="group" aria-label="Approve 2 drafts" data-esc-local/);
    expect(html).toContain(">Yes, approve 2</button>");
    expect(html).not.toContain("Approve these");

    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const confirm = BatchConfirm({ count: 2, onConfirm, onCancel }) as ReactElement<{ onKeyDown(ev: unknown): void; children: unknown[] }>;
    const stopPropagation = vi.fn();
    confirm.props.onKeyDown({ key: "Escape", stopPropagation, preventDefault: vi.fn() });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    // Yes is the button that takes focus.
    const yes = (confirm.props.children as unknown[]).filter(isValidElement).find((c) => (c.props as { autoFocus?: boolean }).autoFocus);
    expect((yes?.props as { children: unknown[] }).children.join("")).toBe("Yes, approve 2");
  });

  it("confirms only the comments, moves and subtasks it covered when it opened: never a rewrite, never one that came in since", async () => {
    const ok = async (_id: string) => ({ error: null });
    const mixed = [fromRun("c1", comment, "r5"), fromRun("rw", rewrite, "r5"), fromRun("c2", comment, "r5")];
    const frozen = freezeBatch(mixed);
    expect(frozen.map((f) => f.id)).toEqual(["c1", "c2"]);
    const approve = vi.fn(ok);
    expect(await confirmBatch(frozen, mixed, approve)).toEqual({ text: "Approved 2.", failed: false });
    expect(approve.mock.calls.map(([id]) => id)).toEqual(["c1", "c2"]);

    // A review that finished while "Approve all 2?" was open left a third comment: Yes still approves the two shown.
    const later = vi.fn(ok);
    await confirmBatch(frozen, [...mixed, fromRun("c3", comment, "r6")], later);
    expect(later.mock.calls.map(([id]) => id)).toEqual(["c1", "c2"]);

    // One of them decided or revised meanwhile: nothing goes, and the person is told to look again.
    const revised = vi.fn(ok);
    const c2 = { ...mixed[2], revisions: [{ note: "Pip changed it", at: iso(1) }] } as unknown as Proposal;
    expect(await confirmBatch(frozen, [mixed[0], mixed[1], c2], revised)).toEqual({ text: BATCH_CHANGED, failed: true });
    expect(await confirmBatch(frozen, [mixed[0], mixed[1]], revised)).toEqual({ text: BATCH_CHANGED, failed: true });
    expect(revised).not.toHaveBeenCalled();

    // A snapshot that somehow named the rewrite still never approves it.
    const forged = vi.fn(ok);
    await confirmBatch([...frozen, { id: "rw", revision: 0 }], mixed, forged);
    expect(forged).not.toHaveBeenCalledWith("rw");
  });

  it("reports a batch that throws while it is picked as failed, with the error, rather than dropping it", async () => {
    const mixed = [fromRun("c1", comment, "r5"), fromRun("c2", comment, "r5")];
    const frozen = freezeBatch(mixed);
    const broken = { ...mixed[1], revisions: undefined } as unknown as Proposal;
    const approve = vi.fn(async (_id: string) => ({ error: null }));
    const out = await confirmBatch(frozen, [mixed[0], broken], approve);
    expect(out.failed).toBe(true);
    expect(out.text).toMatch(/^Couldn't approve these drafts: /);
    expect(approve).not.toHaveBeenCalled();
  });

  it("approves once per draft, in order, and reports the ones that failed", async () => {
    const calls: string[] = [];
    const approve = vi.fn(async (id: string) => {
      calls.push(id);
      if (id === "c2") return { error: "Jira said no" };
      if (id === "t1") throw new Error("offline");
      return { error: null };
    });
    const drafts = [fromRun("c1", comment, "r5"), fromRun("c2", comment, "r5"), fromRun("t1", transition, "r5"), fromRun("c3", comment, "r5")];
    const outcome = await approveBatch(drafts, approve);
    expect(calls).toEqual(["c1", "c2", "t1", "c3"]);
    expect(outcome).toEqual({ text: "Approved 2. Failed: Comment on CA-401: Jira said no; Move CA-401: offline", failed: true });
    expect(await approveBatch(drafts.slice(0, 1), async () => ({ error: null }))).toEqual({ text: "Approved 1.", failed: false });
  });
});

describe("earlier drafts on the rail", () => {
  const retired = (p: Proposal, reason: string): Proposal => ({ ...p, state: { type: "retired", reason } });

  it("collapses a step's retired drafts to 'N earlier drafts', each with its reason once opened; open drafts are unchanged", () => {
    const older = retired(draft("t1", transition, 9), "Replaced by a newer draft");
    const proposals = [older, draft("t2", transition, 5), retired(fromRun("c1", comment, "r5", 8), "Another move of CA-401 was approved")];
    const html = renderToStaticMarkup(<StepRailView {...props({ proposals, initialOpen: ["review"] })} />);
    const pip = html.slice(html.indexOf('aria-label="Pip&#x27;s drafts"'), html.indexOf('data-step="investigate"'));
    expect(pip).toContain('data-draft="t2"');
    expect(pip).not.toContain('data-draft="t1"');
    expect(pip).toMatch(/data-earlier-drafts="pip"[\s\S]*aria-expanded="false"[\s\S]*1 earlier draft</);
    expect(stepOf(html, "review")).toContain("1 earlier draft");
    expect(stepOf(html, "investigate")).not.toContain("earlier draft");

    const two = renderToStaticMarkup(<EarlierStepDrafts step="pip" drafts={[older, retired(draft("t3", transition, 7), "Another move of CA-401 was approved")]} />);
    expect(two).toContain("2 earlier drafts");
    expect(two).toMatch(/<ul[^>]*hidden/);
    const opened = renderToStaticMarkup(<EarlierStepDrafts step="pip" drafts={[older]} initialOpen />);
    expect(opened).toContain('aria-expanded="true"');
    expect(opened).not.toMatch(/<ul[^>]*hidden/);
    expect(opened).toMatch(/Move CA-401<\/span> · Replaced by a newer draft/);
  });

  it("shows Pip's section for retired drafts alone, and nothing for a step without any", () => {
    const html = renderToStaticMarkup(<StepRailView {...props({ proposals: [retired(draft("t1", transition, 9), "Replaced by a newer draft")] })} />);
    expect(html).toContain("Pip&#x27;s drafts");
    expect(html).toContain("1 earlier draft");
    expect(renderToStaticMarkup(<EarlierStepDrafts step="plan" drafts={[]} />)).toBe("");
  });
});
