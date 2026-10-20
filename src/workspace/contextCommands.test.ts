import { describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import { docFromText } from "../lib/docs";
import { needGroups, openInWorkstreamLabel, type ActionSpec, type Need } from "../lib/needs";
import type { Proposal, Run, WorkstreamView } from "../types";
import { buildCommands, rankCommands, type CommandActions } from "./commands";
import { batchCommands, contextCommands, type ContextData, type ContextDeps, type Subject } from "./contextCommands";

const ref = itemRef("CA-401");

const spec = (id: ActionSpec["id"], label: string): ActionSpec => ({ id, label });
const need = (over: Partial<Need> & Pick<Need, "key" | "kind" | "primary">): Need => ({
  group: "unblock",
  workstreamId: "ws-1",
  head: "CA-401 · Checkout retries",
  title: "R2 asks to run a command",
  why: "R2 wants to run `git push`.",
  ifYouWait: "The run stays paused.",
  at: "2026-10-12T09:00:00Z",
  secondary: [],
  target: { type: "run", id: "r-1" },
  batchable: false,
  ...over,
});

const comment = (id: string, state: Proposal["state"] = { type: "pending" }): Proposal =>
  ({ id, createdAt: "2026-10-12T09:00:00Z", updatedAt: "2026-10-12T09:00:00Z", origin: { type: "chat", requestId: "r" }, createdBy: "pip", intent: { type: "comment", item: ref, body: docFromText("Hi") }, label: null, basis: null, state, revisions: [], created: [], error: null, run: null }) as Proposal;
const rewrite = (id: string): Proposal => ({ ...comment(id), intent: { type: "rewrite", item: ref, title: { from: "A", to: "B" }, body: null, flattened: [] } }) as Proposal;
const view = (over: Partial<WorkstreamView["workstream"]> = {}): WorkstreamView =>
  ({ workstream: { id: "ws-1", itemKey: "CA-401", title: "CA-401 Checkout", mode: "manage", heldReason: null, closedAt: null, ...over }, stage: "intake", runs: [], labels: [], budget: {} }) as unknown as WorkstreamView;

const deps = (): ContextDeps => ({
  needAct: vi.fn(),
  openInWorkstream: vi.fn(),
  approveDraft: vi.fn(),
  openDraft: vi.fn(),
  skipDraft: vi.fn(),
  draftInWorkstream: vi.fn(),
  openRun: vi.fn(),
  hold: vi.fn(),
  resume: vi.fn(),
  advise: vi.fn(),
  openWorkstream: vi.fn(),
  approveSafe: vi.fn(),
});
const data = (over: Partial<ContextData> = {}): ContextData => ({ needs: [], proposals: {}, runs: [], workstreams: [view()], ...over });
const labels = (cs: { label: string }[]) => cs.map((c) => c.label);

const permission = need({ key: "run:r-1", kind: "permission", runId: "r-1", primary: spec("allow", "Allow once in Terminal"), secondary: [spec("deny", "Deny")] });

describe("the palette's entries for the focused item", () => {
  it("a permission need offers Allow once and Deny, then Open in workstream and its workstream's controls", () => {
    const d = deps();
    const subject: Subject = { type: "need", key: permission.key };
    const entries = contextCommands(subject, data({ needs: [permission] }), d);
    expect(labels(entries)).toEqual(["Allow once", "Deny", "Open in workstream", "Hold the workstream on CA-401", "Switch CA-401 to Advise"]);
    expect(entries.every((c) => c.group === "This item")).toBe(true);
    // Each one calls the need's own button of that name, and the palette adds nothing to it.
    entries[0].run();
    entries[1].run();
    entries[2].run();
    expect(d.needAct).toHaveBeenNthCalledWith(1, permission, "allow");
    expect(d.needAct).toHaveBeenNthCalledWith(2, permission, "deny");
    expect(d.openInWorkstream).toHaveBeenCalledWith(permission);
  });

  it("finds them by the words a person would type", () => {
    const entries = contextCommands({ type: "need", key: permission.key }, data({ needs: [permission] }), deps());
    expect(labels(rankCommands(entries, "allow"))[0]).toBe("Allow once");
    expect(labels(rankCommands(entries, "deny"))[0]).toBe("Deny");
    expect(labels(rankCommands(entries, "hold"))).toContain("Hold the workstream on CA-401");
    expect(labels(rankCommands(entries, "advise"))).toContain("Switch CA-401 to Advise");
  });

  it("a failed run offers Retry and Dismiss; a limit stop Resume; a held workstream Resume, and not Hold", () => {
    const failed = need({ key: "run:r-2", kind: "failure", runId: "r-2", primary: spec("retry", "Retry"), secondary: [spec("dismiss", "Dismiss")] });
    expect(labels(contextCommands({ type: "need", key: failed.key }, data({ needs: [failed] }), deps())).slice(0, 2)).toEqual(["Retry", "Dismiss"]);
    const limit = need({ key: "run:r-3", kind: "stoppedAtLimit", runId: "r-3", primary: spec("resume", "Resume"), secondary: [spec("dismiss", "Dismiss")] });
    expect(labels(contextCommands({ type: "need", key: limit.key }, data({ needs: [limit] }), deps())).slice(0, 2)).toEqual(["Resume", "Dismiss"]);
    const held = need({ key: "held:ws-1", kind: "hold", target: { type: "workstream" }, primary: spec("resume", "Resume") });
    const entries = contextCommands({ type: "need", key: held.key }, data({ needs: [held], workstreams: [view({ heldReason: "person" })] }), deps());
    expect(labels(entries)).toEqual(["Resume", "Open in workstream", "Switch CA-401 to Advise"]);
  });

  it("a used-up budget offers Allow 5 more and Switch to Advise once, each calling the need's own button", () => {
    const budget = need({ key: "budget:ws-1", kind: "budget", group: "decide", target: { type: "workstream" }, primary: spec("allowMore", "Allow 5 more"), secondary: [spec("advise", "Switch to Advise")] });
    const d = deps();
    const entries = contextCommands({ type: "need", key: budget.key }, data({ needs: [budget], workstreams: [view({ heldReason: "budget" })] }), d);
    // The workstream's own Switch to Advise would say the same thing twice.
    expect(labels(entries)).toEqual(["Allow 5 more", "Switch to Advise", "Open in workstream"]);
    entries[0].run();
    entries[1].run();
    expect(d.needAct).toHaveBeenNthCalledWith(1, budget, "allowMore");
    expect(d.needAct).toHaveBeenNthCalledWith(2, budget, "advise");
    expect(labels(rankCommands(entries, "allow more"))[0]).toBe("Allow 5 more");
  });

  it("a ticket that isn't clear enough to plan offers its three choices, each calling the need's own button, and found by what a person would type", () => {
    const unclear = need({ key: "readiness:r-t", kind: "readiness", group: "decide", target: { type: "workstream" }, primary: spec("askReporter", "Ask the reporter"), secondary: [spec("answerSelf", "I'll answer"), spec("planAnyway", "Plan anyway")] });
    const d = deps();
    const entries = contextCommands({ type: "need", key: unclear.key }, data({ needs: [unclear], workstreams: [view({})] }), d);
    expect(labels(entries).slice(0, 3)).toEqual(["Ask the reporter", "I'll answer", "Plan anyway"]);
    entries[0].run();
    entries[1].run();
    entries[2].run();
    expect(d.needAct).toHaveBeenNthCalledWith(1, unclear, "askReporter");
    expect(d.needAct).toHaveBeenNthCalledWith(2, unclear, "answerSelf");
    expect(d.needAct).toHaveBeenNthCalledWith(3, unclear, "planAnyway");
    expect(labels(rankCommands(entries, "plan anyway"))[0]).toBe("Plan anyway");
    expect(labels(rankCommands(entries, "reporter"))[0]).toBe("Ask the reporter");
  });

  it("a need in General says where its link goes; one in a workstream never lists a second open entry", () => {
    const general = need({ key: "run:r-9", workstreamId: null, kind: "failure", runId: "r-9", target: { type: "run", id: "r-9" }, primary: spec("retry", "Retry") });
    expect(labels(contextCommands({ type: "need", key: general.key }, data({ needs: [general], workstreams: [] }), deps()))).toEqual(["Retry", "Open the run"]);
    expect(openInWorkstreamLabel({ workstreamId: null, target: { type: "draft", id: "p-1" } })).toBe("Show in Pip");
    expect(contextCommands({ type: "need", key: permission.key }, data({ needs: [permission] }), deps()).some((c) => c.id.startsWith("context:open:"))).toBe(false);
    expect(openInWorkstreamLabel({ workstreamId: "ws-1", target: { type: "run", id: "r-1" } })).toBe("Open in workstream");
  });

  it("a draft need offers Approve, Edit and Skip as its buttons do", () => {
    const draft = need({ key: "draft:p1", kind: "draft", group: "approve", target: { type: "draft", id: "p1" }, primary: spec("approve", "Approve"), secondary: [spec("edit", "Edit"), spec("dismiss", "Skip")] });
    const d = deps();
    const entries = contextCommands({ type: "need", key: draft.key }, data({ needs: [draft] }), d);
    expect(labels(entries).slice(0, 3)).toEqual(["Approve", "Edit", "Skip"]);
    entries[2].run();
    expect(d.needAct).toHaveBeenCalledWith(draft, "dismiss");
  });

  it("a focused draft card offers approve, edit, skip (marked as undoable) and Open in workstream", () => {
    const d = deps();
    const p = comment("p1");
    const entries = contextCommands({ type: "draft", id: "p1" }, data({ proposals: { p1: p } }), d);
    expect(labels(entries)).toEqual(["Approve this draft", "Edit this draft", "Skip this draft", "Open in workstream"]);
    expect(entries[2].hint).toMatch(/undo/);
    entries.forEach((c) => c.run());
    expect(d.approveDraft).toHaveBeenCalledWith(p);
    expect(d.openDraft).toHaveBeenCalledWith(p);
    expect(d.skipDraft).toHaveBeenCalledWith(p);
    expect(d.draftInWorkstream).toHaveBeenCalledWith(p);
  });

  it("a draft that is approved only once read opens instead of approving, and a decided one offers nothing to decide", () => {
    const d = deps();
    const entries = contextCommands({ type: "draft", id: "p2" }, data({ proposals: { p2: rewrite("p2") } }), d);
    expect(labels(entries)[0]).toBe("Review and approve this draft");
    entries[0].run();
    expect(d.approveDraft).not.toHaveBeenCalled();
    expect(d.openDraft).toHaveBeenCalled();
    const skipped = contextCommands({ type: "draft", id: "p3" }, data({ proposals: { p3: comment("p3", { type: "skipped" }) } }), deps());
    expect(labels(skipped)).toEqual(["Open in workstream"]);
  });

  it("a workstream offers Hold (or Resume when held) and Advise while it is managed", () => {
    expect(labels(contextCommands({ type: "workstream", id: "ws-1" }, data(), deps()))).toEqual(["Hold the workstream on CA-401", "Switch CA-401 to Advise", "Open the workstream on CA-401"]);
    expect(labels(contextCommands({ type: "workstream", id: "ws-1" }, data({ workstreams: [view({ heldReason: "person", mode: "advise" })] }), deps()))).toEqual(["Resume the workstream on CA-401", "Open the workstream on CA-401"]);
    const d = deps();
    const [hold, advise] = contextCommands({ type: "workstream", id: "ws-1" }, data(), d);
    hold.run();
    advise.run();
    expect(d.hold).toHaveBeenCalledWith("ws-1");
    expect(d.advise).toHaveBeenCalledWith("ws-1");
    // A closed workstream has no controls.
    expect(contextCommands({ type: "workstream", id: "ws-1" }, data({ workstreams: [view({ closedAt: "2026-10-01T00:00:00Z" })] }), deps())).toEqual([]);
  });

  it("a run in Needs you offers what its need does; any other run only opens", () => {
    const run = { id: "r-1" } as Run;
    const viaNeed = contextCommands({ type: "run", id: "r-1" }, data({ needs: [permission], runs: [run] }), deps());
    expect(labels(viaNeed).slice(0, 2)).toEqual(["Allow once", "Deny"]);
    const d = deps();
    const plain = contextCommands({ type: "run", id: "r-9" }, data({ runs: [{ id: "r-9" } as Run] }), d);
    expect(labels(plain)).toEqual(["Open this run"]);
    plain[0].run();
    expect(d.openRun).toHaveBeenCalled();
  });

  it("offers nothing for no focus, or for an item that has gone", () => {
    expect(contextCommands(null, data(), deps())).toEqual([]);
    expect(contextCommands({ type: "need", key: "gone" }, data(), deps())).toEqual([]);
    expect(contextCommands({ type: "draft", id: "gone" }, data(), deps())).toEqual([]);
    expect(contextCommands({ type: "run", id: "gone" }, data(), deps())).toEqual([]);
  });
});

describe("the global entries", () => {
  const safe = (id: string, ws: string) => need({ key: `draft:${id}`, kind: "draft", group: "approve", workstreamId: ws, target: { type: "draft", id }, primary: spec("approve", "Approve"), secondary: [spec("dismiss", "Skip")], batchable: true });

  it("offers 'Approve all safe drafts in KEY' only for a workstream with two or more, and only shows them first", () => {
    const groups = needGroups([safe("a", "ws-1"), safe("b", "ws-1"), safe("c", "ws-2"), permission]);
    const d = deps();
    const commands = batchCommands(groups, d);
    expect(commands).toHaveLength(1);
    expect(commands[0].label).toMatch(/^Approve all safe drafts in /);
    expect(commands[0].hint).toMatch(/2 drafts/);
    commands[0].run();
    expect(d.approveSafe).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.approveSafe).mock.calls[0][0].safeBatch.map((n: Need) => n.key)).toEqual(["draft:a", "draft:b"]);
    expect(batchCommands(needGroups([safe("c", "ws-2")]), d)).toEqual([]);
    expect(labels(rankCommands(commands, "approve safe"))).toHaveLength(1);
  });

  it("keeps 'Show what needs me' among the palette's commands", () => {
    const made = new Map<string | symbol, ReturnType<typeof vi.fn>>();
    const actions = new Proxy({}, { get: (_, name) => (made.has(name) ? made : made.set(name, vi.fn())).get(name) }) as unknown as CommandActions;
    const all = buildCommands([], [], actions, { project: null, view: null, unreadActivity: 0, agents: true, needsYou: 3 });
    const show = all.find((c) => c.label === "Show what needs me");
    expect(show?.hint).toBe("3 waiting");
    show!.run();
    expect(actions.showNeedsYou).toHaveBeenCalled();
  });
});
