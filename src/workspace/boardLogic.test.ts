import { beforeEach, describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import { containerRef, itemRef, statusId } from "../backend/mockConnector";
import { ALL } from "../lib/filter";
import type { Proposal, WorkItem, Workflow } from "../types";
import { itemsByFilter, useWorkspace } from "../workspaceStore";
import {
  AGE_BUCKETS,
  ageColumns,
  approvableTransitions,
  blockedKeys,
  boardSections,
  categorySection,
  categoryVerdict,
  planCategoryDrop,
  bulkMoves,
  bulkTargets,
  draftStatus,
  dropVerdict,
  pendingMoves,
  planDrop,
  targetsFor,
  witherOf,
} from "./boardLogic";

const s = () => useWorkspace.getState();
const item = (key: string): WorkItem => s().items[`mock:${key}`];
const sections = (filter = ALL, include = null as ReturnType<typeof containerRef> | null) => boardSections(itemsByFilter(s(), filter), s().containers, include);
const section = (code: string) => sections().find((x) => x.code === code)!;
const workflowOf = (i: WorkItem): Workflow | null => s().containers[`mock:${i.container.externalId}`]?.workflow ?? null;

beforeEach(async () => {
  await s().init(new MockBackend());
});

describe("board sections", () => {
  it("makes a section per project, each with its own workflow's columns", () => {
    const all = sections();
    expect(all.map((x) => x.code)).toEqual(["CA", "DEVOPS", "SUP", "WEB"]);
    expect(section("DEVOPS").columns.map((c) => c.status.name)).toEqual(["To Do", "In Progress", "In Review", "Blocked", "Done"]);
    expect(section("CA").columns.map((c) => c.status.name)).toEqual(["Backlog", "Copy", "Design", "QA", "Scheduled", "Sent"]);
    expect(all.reduce((n, x) => n + x.count, 0)).toBe(Object.keys(s().items).length);
  });

  it("puts each item in the column of its status", () => {
    const blocked = section("DEVOPS").columns.find((c) => c.status.name === "Blocked")!;
    expect(blocked.items.map((i) => i.item.key)).toContain("DEVOPS-473");
    expect(section("DEVOPS").columns.every((c) => c.items.every((i) => i.status.id === c.status.id))).toBe(true);
  });

  it("only shows projects that have items, except one the filter names", () => {
    const web = itemsByFilter(s(), { type: "container", container: containerRef("WEB") });
    expect(boardSections(web, s().containers).map((x) => x.code)).toEqual(["WEB"]);
    expect(boardSections([], s().containers)).toEqual([]);
    const empty = boardSections([], s().containers, containerRef("CA"));
    expect(empty.map((x) => x.code)).toEqual(["CA"]);
    expect(empty[0].columns).toHaveLength(6);
  });

  it("adds a column for a status its workflow doesn't list so no card is hidden", () => {
    const odd = { ...item("CA-402"), status: { id: "ca-mystery", name: "Mystery", category: "active" as const } };
    const ca = boardSections([odd], s().containers)[0];
    expect(ca.columns[ca.columns.length - 1]).toMatchObject({ status: { name: "Mystery" }, items: [odd] });
    expect(ca.columns.slice(0, -1).every((c) => c.items.length === 0)).toBe(true);
  });
});

describe("drop rules", () => {
  it("allows only the workflow's next statuses and highlights nothing else", () => {
    const card = item("DEVOPS-471");
    const devops = section("DEVOPS");
    expect(card.status.name).toBe("In Review");
    const verdicts = Object.fromEntries(devops.columns.map((c) => [c.status.name, dropVerdict(card, devops, c.status.id)]));
    expect(verdicts).toEqual({ "To Do": "invalid", "In Progress": "ok", "In Review": "same", Blocked: "ok", Done: "ok" });
    expect(targetsFor(devops.workflow, card).map((t) => t.name)).toEqual(["In Progress", "Blocked", "Done"]);
  });

  it("never lets a card into another project's column", () => {
    const wrong = section("WEB").columns[1];
    expect(dropVerdict(item("DEVOPS-471"), section("WEB"), wrong.status.id)).toBe("invalid");
    expect(planDrop(item("DEVOPS-471"), section("WEB"), wrong.status.id).ok).toBe(false);
  });

  it("treats every other status as droppable when moves are only known per item", () => {
    const devops = section("DEVOPS");
    const jira: typeof devops = { ...devops, workflow: { ...devops.workflow, transitions: { kind: "graph", moves: [] } } };
    const card = item("DEVOPS-471");
    expect(dropVerdict(card, jira, statusId("DEVOPS", "To Do"))).toBe("ok");
    expect(dropVerdict(card, jira, card.status.id)).toBe("same");
  });

  it("allows any other status when the workflow has no graph", () => {
    const sup = section("SUP");
    const card = sup.columns.flatMap((c) => c.items)[0];
    expect(sup.workflow.transitions.kind).toBe("any");
    expect(sup.columns.filter((c) => dropVerdict(card, sup, c.status.id) === "ok")).toHaveLength(sup.columns.length - 1);
  });

  it("plans a drop as a transition intent to the column's status id", () => {
    const devops = section("DEVOPS");
    const plan = planDrop(item("DEVOPS-471"), devops, statusId("DEVOPS", "Done"));
    expect(plan).toMatchObject({ ok: true, to: { name: "Done" }, intent: { type: "transition", item: itemRef("DEVOPS-471"), to: statusId("DEVOPS", "Done") } });
  });

  it("explains a refused drop and stays quiet about a drop where it started", () => {
    const devops = section("DEVOPS");
    expect(planDrop(item("DEVOPS-471"), devops, statusId("DEVOPS", "To Do"))).toEqual({ ok: false, reason: "DevOps doesn't allow In Review → To Do" });
    expect(planDrop(item("DEVOPS-471"), devops, item("DEVOPS-471").status.id)).toEqual({ ok: false, reason: null });
    expect(planDrop(item("DEVOPS-471"), devops, "nope")).toMatchObject({ ok: false });
  });
});

describe("draft moves", () => {
  it("turns a drop into a pending draft by the user and writes nothing", async () => {
    const card = item("DEVOPS-471");
    const plan = planDrop(card, section("DEVOPS"), statusId("DEVOPS", "Done"));
    if (!plan.ok) throw new Error("expected a plan");
    const p = await s().draftTransition(card.item, plan.to);

    expect(p).toMatchObject({ createdBy: "user", origin: { type: "board" }, state: { type: "pending" }, label: "Done" });
    expect(p.intent).toEqual(plan.intent);
    expect(s().proposals[p.id]).toBeDefined();
    await s().refresh();
    expect(item("DEVOPS-471").status.name).toBe("In Review");
    expect((await s().backend!.cacheItem(card.item))?.status.name).toBe("In Review");
  });

  it("replaces the transition draft still pending for the card, and approving applies it", async () => {
    const card = item("DEVOPS-471");
    const [progress, done] = ["In Progress", "Done"].map((n) => section("DEVOPS").workflow.statuses.find((x) => x.name === n)!);
    const first = await s().draftTransition(card.item, progress);
    const second = await s().draftTransition(card.item, done);
    expect(s().proposals[first.id].state.type).toBe("skipped");
    expect(pendingMoves(s().proposals).get("mock:DEVOPS-471")?.id).toBe(second.id);

    await s().approve(second.id);
    expect(s().proposals[second.id].state.type).toBe("applied");
    await s().refresh();
    expect(item("DEVOPS-471").status.name).toBe("Done");
  });

  it("keeps the earlier draft when the new one is refused", async () => {
    const card = item("DEVOPS-471");
    const wf = section("DEVOPS").workflow;
    const first = await s().draftTransition(card.item, wf.statuses.find((x) => x.name === "In Progress")!);
    await expect(s().draftTransition(card.item, { ...wf.statuses[0], id: " " })).rejects.toThrow(/target status/);
    expect(s().proposals[first.id].state.type).toBe("pending");
  });

  it("finds where a draft points by id, then by name", () => {
    const wf = section("DEVOPS").workflow;
    const draft = (to: string) => ({ intent: { type: "transition", item: itemRef("DEVOPS-471"), to } }) as Proposal;
    expect(draftStatus(draft(statusId("DEVOPS", "Done")), wf)?.name).toBe("Done");
    expect(draftStatus(draft("done"), wf)?.name).toBe("Done");
    expect(draftStatus(draft("Nowhere"), wf)).toBeNull();
    expect(draftStatus({ intent: { type: "comment" } } as Proposal, wf)).toBeNull();
  });

  it("refuses a hand-made draft with no target status", async () => {
    await expect(s().backend!.proposalsCreate({ type: "transition", item: itemRef("CA-402"), to: " " })).rejects.toThrow(/target status/);
    await expect(
      s().backend!.proposalsCreate({ type: "create", container: containerRef("CA"), fields: { title: "x", body: { blocks: [] }, kind: "task", assignee: null, parent: null, priority: null, labels: [] }, link: null }),
    ).rejects.toThrow(/existing item/);
  });
});

describe("bulk actions", () => {
  const picked = () => ["DEVOPS-471", "DEVOPS-472", "CA-402"].map(item);

  it("moves each item to the status of that name in its own workflow and reports the ones that can't get there", () => {
    const { moves, skipped } = bulkMoves(picked(), workflowOf, "In Progress");
    expect(moves.map((m) => [m.item.item.key, m.to.id])).toEqual([["DEVOPS-471", statusId("DEVOPS", "In Progress")]]);
    expect(skipped.map((i) => i.item.key)).toEqual(["DEVOPS-472", "CA-402"]);
  });

  it("matches names regardless of case and sends different projects to their own status ids", () => {
    const both = ["DEVOPS-471", "CA-402"].map(item);
    expect(bulkMoves(both, workflowOf, "in review").moves.map((m) => m.item.item.key)).toEqual([]);
    const design = bulkMoves(["CA-401", "CA-402"].map(item), workflowOf, "DESIGN");
    expect(design.moves.map((m) => m.to.id)).toEqual([statusId("CA", "Design")]);
  });

  it("offers the statuses at least one item can reach, the most reachable first", () => {
    const targets = bulkTargets(picked(), workflowOf);
    expect(targets[0].count).toBeGreaterThanOrEqual(targets[targets.length - 1].count);
    expect(targets.find((t) => t.name === "In Progress")).toEqual({ name: "In Progress", count: 1 });
    expect(targets.find((t) => t.name === "Done")?.count).toBe(1);
    expect(bulkTargets([], workflowOf)).toEqual([]);
  });

  it("approves only transition drafts on the ticked items", async () => {
    const backend = s().backend as MockBackend;
    backend.proposals.draft({ type: "comment", item: itemRef("CA-402"), body: { blocks: [] } });
    const wfDevops = section("DEVOPS").workflow;
    const t1 = await s().draftTransition(itemRef("DEVOPS-471"), wfDevops.statuses.find((x) => x.name === "Done")!);
    await s().draftTransition(itemRef("DEVOPS-472"), wfDevops.statuses.find((x) => x.name === "Blocked")!);
    const pending = pendingMoves(s().proposals);

    const marked = ["mock:DEVOPS-471", "mock:CA-402", "mock:WEB-101"];
    expect(approvableTransitions(pending, marked).map((p) => p.id)).toEqual([t1.id]);
    expect(approvableTransitions(pending, ["mock:CA-402"])).toEqual([]);
  });
});

describe("blocked and age", () => {
  it("marks an item blocked by an open blocker, even one outside the filter", () => {
    const all = Object.values(s().items);
    const blocked = blockedKeys(all);
    const viaLink = all.filter((i) => i.links.some((l) => l.kind === "blocks"));
    expect(viaLink.length).toBeGreaterThan(0);
    const pair = viaLink[0].links.find((l) => l.kind === "blocks")!;
    const blocker = s().items[`${pair.from.connectionId}:${pair.from.externalId}`];
    expect(blocked.has(`${pair.to.connectionId}:${pair.to.externalId}`)).toBe(blocker.status.category !== "done");
  });

  const now = new Date("2026-09-30T12:00:00Z");
  const quiet = (days: number, category: "todo" | "done" = "todo") =>
    ({ ...item("WEB-101"), updated: new Date(now.getTime() - days * 86_400_000 - 1000).toISOString(), status: { id: "x", name: "x", category } }) as WorkItem;

  it("withers open items at 2, 3, 5, 7 and 10 quiet days and never finished ones", () => {
    const at = (days: number) => witherOf(quiet(days), now);
    expect([1, 2, 3, 5, 7, 10, 30].map(at)).toEqual([0, 1, 2, 3, 4, 5, 5]);
    expect([4.9, 6.9, 9.9].map((d) => at(d))).toEqual([2, 3, 4]);
    expect(witherOf(quiet(30, "done"), now)).toBe(0);
  });

  it("puts open items in age columns, the quietest first, and leaves finished work out", () => {
    const list = [quiet(1), quiet(2), quiet(6), quiet(7), quiet(13), quiet(14), quiet(40), quiet(50, "done")];
    const cols = ageColumns(list, now);
    expect(cols.map((c) => c.bucket.id)).toEqual(AGE_BUCKETS.map((b) => b.id));
    expect(cols.map((c) => c.items.length)).toEqual([1, 2, 2, 2]);
    expect(cols[3].items.map((i) => i.updated)).toEqual([list[6].updated, list[5].updated]);
    expect(cols.flatMap((c) => c.items)).not.toContain(list[7]);
  });
});

describe("drops where the tracker reveals moves per item", () => {
  const opaque = (sec: ReturnType<typeof section>): typeof sec => ({ ...sec, workflow: { ...sec.workflow, transitions: { kind: "graph", moves: [] } } });
  const web = () => opaque(section("WEB"));
  const card = () => web().columns.flatMap((c) => c.items).find((i) => i.status.category !== "done")!;

  it("offers every other status until the tracker has answered, then only what it offered", () => {
    const sec = web();
    const i = card();
    const others = sec.workflow.statuses.filter((x) => x.id !== i.status.id);
    expect(targetsFor(sec.workflow, i)).toEqual(others);
    const offered = [others[0]];
    expect(targetsFor(sec.workflow, i, offered)).toEqual(offered);
    expect(dropVerdict(i, sec, others[0].id, offered)).toBe("ok");
    expect(dropVerdict(i, sec, others[1].id, offered)).toBe("invalid");
  });

  it("plans a drop as an intent carrying the status id, and refuses one the tracker didn't offer", () => {
    const sec = web();
    const i = card();
    const [a, b] = sec.workflow.statuses.filter((x) => x.id !== i.status.id);
    const ok = planDrop(i, sec, a.id, [a]);
    expect(ok.ok && ok.intent).toEqual({ type: "transition", item: i.item, to: a.id });
    expect(planDrop(i, sec, b.id, [a])).toMatchObject({ ok: false });
  });

  it("ignores what the tracker said when the workflow lists its moves itself", () => {
    const i = item("CA-402");
    const wf = section("CA").workflow;
    expect(targetsFor(wf, i, [])).toEqual(targetsFor(wf, i));
  });
});

describe("category board", () => {
  it("has a column per status category holding every project's items", () => {
    const all = itemsByFilter(s(), ALL);
    const cat = categorySection(all);
    expect(cat.columns.map((c) => c.status.name)).toEqual(["To do", "In progress", "Done"]);
    expect(cat.columns.reduce((n, c) => n + c.items.length, 0)).toBe(all.length);
    expect(cat.columns.every((c) => c.items.every((i) => i.status.category === c.category))).toBe(true);
    expect(new Set(cat.columns[1].items.map((i) => i.container.externalId)).size).toBeGreaterThan(1);
  });

  it("moves a card to the first status of that category its own workflow allows", () => {
    const card = item("DEVOPS-471");
    const own = section("DEVOPS");
    expect(categoryVerdict(card, own, "done")).toBe("ok");
    expect(categoryVerdict(card, own, "active")).toBe("same");
    expect(categoryVerdict(card, own, "todo")).toBe("invalid");
    expect(planCategoryDrop(card, own, "done")).toMatchObject({ ok: true, to: { name: "Done" }, intent: { type: "transition", to: statusId("DEVOPS", "Done") } });
    expect(planCategoryDrop(card, own, "todo")).toEqual({ ok: false, reason: "DevOps doesn't allow In Review → To do" });
    expect(planCategoryDrop(card, own, "active")).toEqual({ ok: false, reason: null });
  });
});
