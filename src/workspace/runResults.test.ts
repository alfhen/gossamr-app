import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { commentText, jiraNote, ticketFromAnswer, ticketKeys, ticketProposal } from "../backend/mockRunResult";
import results from "../../src-tauri/test-fixtures/agents/results.json";
import tickets from "../../src-tauri/test-fixtures/agents/ticket-results.json";
import type { CodeChange, Run } from "../types";
import { agentMatchesChip, buildRows, coversAgents, shownSourceOf, sourcesFor, toRunEntries, type RunEntry } from "./activityLogic";
import { blockerChoices, blockerControl, changeSummary, commentControl } from "./runSheetLogic";
import { useActivity } from "./activityStore";
import { useRuns } from "./runsStore";
import { useToasts } from "./toasts";

vi.mock("./jump", () => ({ showMe: vi.fn(() => true), openTicketByKey: vi.fn(async () => true) }));

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const seeded = () => new MockBackend().runs.list();
const run = (over: Partial<Run>): Run => ({ ...seeded()[0], id: "r", shortId: "1000a000", state: "working", launchedAt: iso(30), lastProgressAt: iso(5), endedAt: null, needs: null, result: null, error: null, ...over });

describe("the sample parser agrees with the shared fixtures it can read", () => {
  const plain = results.filter((c) => !/markup|escapes|secrets|not ascii/.test(c.name));
  it.each(plain.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(jiraNote(c.input)).toEqual({ text: c.text, fromMarker: c.fromMarker });
  });

  it("finds ticket keys once each, upper case", () => {
    expect(ticketKeys("blocked by taf-3525 and DEVOPS-9, see TAF-3525")).toEqual(["TAF-3525", "DEVOPS-9"]);
  });
});

describe("the sample ticket parser agrees with the shared ticket fixtures", () => {
  it.each(tickets.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(ticketProposal(c.input)).toEqual(c.expected);
  });

  it("seeds a draft from an answer with no section: the first line is the title", () => {
    expect(ticketFromAnswer("## The consumer retries in a loop\n\nIt never backs off.")).toEqual({ title: "The consumer retries in a loop", kind: "task", body: "The consumer retries in a loop\n\nIt never backs off." });
    expect(ticketFromAnswer("  \n")).toBeNull();
  });
});

describe("what the run sheet may draft", () => {
  it("needs a ticket and an answer for a comment, and only a ticket for a blocker", () => {
    expect(commentControl({ item: seeded()[0].item, result: "Found it." })).toEqual({ enabled: true, reason: null });
    expect(commentControl({ item: null, result: "Found it." }).reason).toMatch(/isn't about a ticket/);
    expect(commentControl({ item: seeded()[0].item, result: "  \n" }).reason).toMatch(/nothing to post/);
    expect(commentControl({ item: seeded()[0].item, result: null }).enabled).toBe(false);
    expect(blockerControl({ item: null })).toMatchObject({ enabled: false });
    expect(blockerControl({ item: seeded()[0].item }).enabled).toBe(true);
  });

  const tickets = [
    { key: "CA-1", title: "Cart total is wrong" },
    { key: "CA-2", title: "Refund rounding" },
    { key: "WEB-9", title: "Banner flicker" },
  ];

  it("offers the tickets the result names first, never the run's own, then matches for what is typed", () => {
    expect(blockerChoices(tickets, ["WEB-9", "CA-1", "NOPE-1"], "CA-1", "")).toEqual([{ key: "WEB-9", title: "Banner flicker", found: true }]);
    expect(blockerChoices(tickets, [], "CA-1", "refund").map((c) => c.key)).toEqual(["CA-2"]);
    expect(blockerChoices(tickets, ["WEB-9"], "CA-1", "ca-").map((c) => [c.key, c.found])).toEqual([["CA-2", false]]);
    expect(blockerChoices(tickets, [], "CA-1", "")).toEqual([]);
  });

  it("offers a typed key that isn't cached, but not the run's own", () => {
    expect(blockerChoices(tickets, [], "CA-1", "taf-3525")).toEqual([{ key: "TAF-3525", title: null, found: false }]);
    expect(blockerChoices(tickets, [], "CA-1", "ca-1")).toEqual([]);
    expect(blockerChoices(tickets, [], null, "nonsense")).toEqual([]);
    expect(blockerChoices(tickets, [], "WEB-9", "ca-").map((c) => c.key)).toEqual(["CA-1", "CA-2"]);
    expect(blockerChoices(tickets, [], "WEB-9", "ca-2").map((c) => c.key)).toEqual(["CA-2"]);
  });

  it("sums up a pull request and says a bare branch has none", () => {
    const pr = { kind: "pullRequest", state: "open", changedFiles: 5, additions: 84, deletions: 12, checks: "passing", review: "approved" } as CodeChange;
    expect(changeSummary(pr)).toEqual(["Open", "5 files changed", "+84 −12", "Checks passing", "Approved"]);
    expect(changeSummary({ ...pr, changedFiles: 1, additions: null, state: "merged", checks: "failing", review: "none" })).toEqual(["Merged", "1 file changed", "Checks failing"]);
    expect(changeSummary({ ...pr, kind: "branch" })).toEqual(["Branch only, no pull request yet"]);
  });
});

describe("agent entries in the activity feed", () => {
  const read = new Set<string>();

  it("lists a start for a run with a session, and what is true now for waiting, finished and failed runs", () => {
    const entries = toRunEntries(
      [
        run({ id: "w", state: "working" }),
        run({ id: "p", state: "needsPermission", needs: "approve Bash: git push" }),
        run({ id: "d", state: "done", result: "The lag comes from one consumer.\n\nFor Jira: add a backoff.", endedAt: iso(2) }),
        run({ id: "f", state: "failed", shortId: null, error: "Claude isn't signed in.\nRun claude." }),
        run({ id: "s", state: "stopped", endedAt: iso(3) }),
        run({ id: "q", state: "queued", shortId: null, launchedAt: null }),
      ],
      read,
      NOW,
    );
    expect(entries.map((e) => [e.id, e.kind, e.unread])).toEqual([
      ["run:d:done", "finished", true],
      ["run:f:failed", "failed", true],
      ["run:p:needsPermission", "needsYou", true],
      ["run:d:started", "started", false],
      ["run:p:started", "started", false],
      ["run:s:started", "started", false],
      ["run:w:started", "started", false],
    ]);
    expect(entries.find((e) => e.id === "run:d:done")?.text).toBe("Investigate agent finished: The lag comes from one consumer.");
    expect(entries.find((e) => e.id === "run:p:needsPermission")?.text).toBe("Investigate agent needs permission: git push");
    expect(entries.find((e) => e.id === "run:f:failed")?.text).toBe("Investigate agent failed: Claude isn't signed in.");
  });

  it("gives the same run the same ids however often it is read, so a read mark sticks", () => {
    const waiting = run({ id: "p", state: "needsAnswer", needs: "Which cache?" });
    const once = toRunEntries([waiting, waiting], read, NOW);
    expect(once.map((e) => e.id)).toEqual(["run:p:needsAnswer", "run:p:started"]);
    const marked = toRunEntries([waiting], new Set(["run:p:needsAnswer"]), NOW);
    expect(marked.find((e) => e.kind === "needsYou")?.unread).toBe(false);
    const again = toRunEntries([{ ...waiting, lastProgressAt: iso(1) }], new Set(["run:p:needsAnswer"]), NOW);
    expect(again.find((e) => e.kind === "needsYou")?.unread).toBe(false);
  });

  it("stops asking for attention after two weeks", () => {
    const old = run({ id: "d", state: "done", result: "x", endedAt: new Date(NOW - 15 * 864e5).toISOString() });
    expect(toRunEntries([old], read, NOW).find((e) => e.kind === "finished")?.unread).toBe(false);
  });

  const entries: RunEntry[] = toRunEntries([run({ id: "p", state: "needsAnswer", needs: "Which cache?" }), run({ id: "d", state: "done", result: "x", endedAt: iso(2), item: null })], read, NOW);
  const input = { chip: "all" as const, container: null, jira: [], more: false, code: [], agents: entries, containerOf: () => null };

  it("shows under All sources and Agents only, and the chips treat them like GitHub events", () => {
    expect(buildRows({ ...input, source: "all" }).map((r) => r.source)).toEqual(Array(entries.length).fill("agents"));
    expect(buildRows({ ...input, source: "agents" })).toHaveLength(entries.length);
    expect(buildRows({ ...input, source: "jira" })).toEqual([]);
    expect(buildRows({ ...input, source: "github" })).toEqual([]);
    expect(buildRows({ ...input, source: "agents", chip: "needsMe" }).map((r) => r.entry.id)).toEqual(["run:d:done", "run:p:needsAnswer"]);
    for (const chip of ["mentions", "comments", "status", "assigned", "drafts"] as const) expect(buildRows({ ...input, source: "agents", chip })).toEqual([]);
    expect(agentMatchesChip("all", { unread: false })).toBe(true);
  });

  it("narrows to a project through the ticket and leaves out runs without one", () => {
    const project = { connectionId: "mock", externalId: "P" };
    const inP = (ref: { key: string }) => (ref.key === entries.find((e) => e.item)?.item?.key ? project : null);
    expect(buildRows({ ...input, source: "agents", container: project, containerOf: inP }).map((r) => r.entry.id).sort()).toEqual(["run:p:needsAnswer", "run:p:started"]);
  });

  it("offers the Agents source only while agents are on", () => {
    expect(sourcesFor({ github: false, agents: false })).toEqual(["all", "jira"]);
    expect(sourcesFor({ github: true, agents: true })).toEqual(["all", "jira", "github", "agents"]);
  });
});

describe("drafting from a run", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  let backend: MockBackend;
  const s = () => useRuns.getState();
  const finished = () => s().runs.find((r) => r.state === "done" && r.item?.key === "DEVOPS-455")!;
  const drafts = () => backend.proposals.list({ states: ["pending"] });

  beforeEach(async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    useToasts.getState().clear();
    backend = new MockBackend();
    s().init(backend);
    await settle();
  });

  it("makes a comment draft marked as from the run, takes the person to it, and posts nothing", async () => {
    const { showMe } = await import("./jump");
    vi.mocked(showMe).mockClear();
    const run = finished();
    s().openRun(run.id);
    await s().draftComment(run.id);
    const [draft] = drafts();
    expect(draft.origin).toEqual({ type: "run", runId: run.id, shortId: run.shortId });
    expect(draft).toMatchObject({ createdBy: "user", state: { type: "pending" }, label: `From agent run ${run.shortId}` });
    expect(draft.intent).toMatchObject({ type: "comment", item: { key: "DEVOPS-455" } });
    expect(JSON.stringify(draft.intent)).toContain("add a backoff to the consumer and close the alert.");
    expect(JSON.stringify(draft.intent)).toContain("Pull request: https://github.com/acme/storefront/pull/518");
    expect(useToasts.getState().toasts[0]).toMatchObject({ text: "Draft ready. Nothing is posted until you approve it.", tone: "info" });
    expect(s().sheet).toBeNull();
    expect(s().drafting).toBeNull();
    expect(showMe).toHaveBeenCalledWith(expect.objectContaining({ key: "DEVOPS-455" }), { peek: true });
  });

  it("refuses the same comment twice, and a run that hasn't finished", async () => {
    const run = finished();
    await s().draftComment(run.id);
    useToasts.getState().clear();
    await s().draftComment(run.id);
    expect(useToasts.getState().toasts[0].text).toMatch(/^Couldn't draft the comment: that comment is already waiting as a draft on DEVOPS-455/);
    expect(drafts()).toHaveLength(1);

    useToasts.getState().clear();
    const working = s().runs.find((r) => r.state === "working")!;
    s().openRun(working.id);
    await s().draftComment(working.id);
    expect(useToasts.getState().toasts[0].text).toBe("Couldn't draft the comment: that run hasn't finished");
    expect(s().sheet).toEqual({ type: "run", id: working.id });
  });

  it("drafts a blocker as a link from the blocking ticket to the run's ticket, and refuses odd keys", async () => {
    const run = finished();
    await s().draftBlocker(run.id, " ca-402 ");
    const [draft] = drafts();
    expect(draft.intent).toMatchObject({ type: "link", kind: "blocks", from: { key: "CA-402" }, to: { key: "DEVOPS-455" } });
    expect(draft.origin).toMatchObject({ type: "run", runId: run.id });
    expect(draft.label).toBe("Blocked by CA-402");
    for (const bad of ["devops-455", "not a key", "CA-"]) {
      useToasts.getState().clear();
      await s().draftBlocker(run.id, bad);
      expect(useToasts.getState().toasts[0].text).toMatch(/^Couldn't draft the blocker: /);
    }
    expect(drafts()).toHaveLength(1);
  });

  it("ignores a second request while one is being made", async () => {
    const run = finished();
    const first = s().draftComment(run.id);
    await s().draftBlocker(run.id, "CA-402");
    await first;
    expect(drafts().map((d) => d.intent.type)).toEqual(["comment"]);
  });

  it("gives the sheet the note, the keys it names and the change the run made", async () => {
    const outcome = await backend.runsOutcome(finished().id);
    expect(outcome.note).toEqual({ text: "add a backoff to the consumer and close the alert.", fromMarker: true });
    expect(outcome.change).toMatchObject({ kind: "pullRequest", number: 518 });
    const bare = s().runs.find((r) => r.item?.key === "WEB-97")!;
    const other = await backend.runsOutcome(bare.id);
    expect(other.note).toEqual({ text: "Cropping happens twice, once in the CDN rule and once in the component.", fromMarker: false });
    expect(other.change?.kind).toBe("branch");
    expect(commentText(other.note!, other.change)).toContain("didn't mark anything for Jira");
    expect(commentText(other.note!, other.change)).not.toContain("Pull request:");
  });
});

describe("the activity store and agent entries", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("remembers which agent entries were read, apart from GitHub's, and keeps only the latest 500", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
    useActivity.setState({ runRead: new Set() });
    useActivity.getState().markRunRead(["run:a:done", "run:b:failed"]);
    useActivity.getState().markRunRead(["run:a:done"]);
    expect([...useActivity.getState().runRead]).toEqual(["run:a:done", "run:b:failed"]);
    expect(JSON.parse(data.get("gossamr-runs-activity-read")!)).toEqual(["run:a:done", "run:b:failed"]);
    expect(data.has("gossamr-code-read")).toBe(false);
    useActivity.getState().markRunRead(Array.from({ length: 600 }, (_, i) => `run:x${i}:done`));
    expect(useActivity.getState().runRead.size).toBe(500);
  });

  it("does not ask the tracker for a feed while the Agents source is chosen", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    const backend = new MockBackend();
    const feed = vi.spyOn(backend, "cacheFeed");
    const events = vi.spyOn(backend, "codeEvents");
    useActivity.setState({ source: "all", chip: "all" });
    useActivity.getState().init(backend);
    await settle();
    feed.mockClear();
    events.mockClear();
    useActivity.getState().setSource("agents");
    await settle();
    expect(feed).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(useActivity.getState()).toMatchObject({ status: "ready", entries: [], codeEvents: [] });
    useActivity.getState().dispose();
    useActivity.setState({ source: "all" });
  });
});

describe("approving a blocker in the sample data", () => {
  it("links the two tickets on both ends, once, and refuses one that isn't there", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    const backend = new MockBackend();
    const p = await backend.proposalsCreate({ type: "link", from: itemRef("CA-402"), to: itemRef("CA-406"), kind: "blocks" }, "Blocked by CA-402");
    await backend.proposalsApprove(p.id);
    const linked = async (key: string) => (await backend.cacheItem(itemRef(key)))!.links.filter((l) => l.kind === "blocks" && l.from.key === "CA-402" && l.to.key === "CA-406");
    expect(await linked("CA-402")).toHaveLength(1);
    expect(await linked("CA-406")).toHaveLength(1);
    const again = await backend.proposalsCreate({ type: "link", from: itemRef("CA-402"), to: itemRef("CA-406"), kind: "blocks" }, null);
    await backend.proposalsApprove(again.id);
    expect(await linked("CA-402")).toHaveLength(1);
    const stale = await backend.proposalsCreate({ type: "link", from: { ...itemRef("CA-403"), key: "CA-406" }, to: itemRef("CA-404"), kind: "relates" }, null);
    await backend.proposalsApprove(stale.id);
    const ca403 = (await backend.cacheItem(itemRef("CA-403")))!.links;
    expect(ca403.find((l) => l.kind === "relates")).toMatchObject({ from: { externalId: "CA-403", key: "CA-403" }, to: { externalId: "CA-404" } });
    const missing = await backend.proposalsCreate({ type: "link", from: itemRef("CA-402"), to: itemRef("NOPE-1"), kind: "blocks" }, null);
    const done = await backend.proposalsApprove(missing.id).catch((e: Error) => e);
    expect(done instanceof Error ? done.message : done.error).toMatch(/isn't in the sample data/);
  });
});

describe("the Activity source after agents are turned off", () => {
  it("falls back to the tracker's, which the view hands back to the store", () => {
    const off = sourcesFor({ github: false, agents: false });
    expect(shownSourceOf("agents", off)).toBe("jira");
    expect(shownSourceOf("github", off)).toBe("jira");
    expect(shownSourceOf("agents", sourcesFor({ github: false, agents: true }))).toBe("agents");
    expect(shownSourceOf("all", off)).toBe("all");
  });

  it("marks agent entries read only for All sources and Agents", () => {
    expect([coversAgents("all"), coversAgents("agents"), coversAgents("jira"), coversAgents("github")]).toEqual([true, true, false, false]);
  });
});
