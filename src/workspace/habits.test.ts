import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { docText } from "../lib/docs";
import { LEARN_AFTER } from "../lib/clarityLearning";
import { safeToBatch } from "../lib/needs";
import { jiraSent } from "../lib/jiraSent";
import { nudgeOffered } from "../lib/reporterWait";
import type { Proposal } from "../types";
import { useWorkspace } from "../workspaceStore";
import { giveBackClarity } from "./clarityActions";
import { usePipHome } from "./pipHomeStore";
import { usePrefs } from "./prefs";
import { pushLearning, useToasts } from "./toasts";
import { currentNeeds } from "./useNeeds";
import { useWorkstreams } from "./workstreamsStore";

// The habits' stores and the sample backend: the reporter nudge, what Looks fine teaches the clarity notice, and What Jira
// saw from me, read from the same drafts and audit the page holds.

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};
const THIN = "Fix it.";
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const texts = () => useToasts.getState().toasts.map((t) => t.text);

let backend: MockBackend;
beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  usePrefs.setState({ clarityLearning: {}, startMyDayDoneOn: null });
  useToasts.getState().clear();
  backend = new MockBackend({ runs: { seed: "empty", prSurfaceMs: null }, wsManage: true });
  backend.supervisor.dispose();
  await useWorkspace.getState().init(backend);
  useWorkstreams.getState().init(backend);
});
afterEach(() => {
  useWorkstreams.getState().dispose();
  useToasts.getState().clear();
  usePrefs.setState({ clarityLearning: {}, startMyDayDoneOn: null });
  vi.unstubAllGlobals();
});

const stored = (id: string) => useWorkstreams.getState().list.find((v) => v.workstream.id === id)!;
const events = (id: string) => backend.workstreams.events(id);
const open = async (key: string) => {
  const id = (await backend.workstreamsOpen(itemRef(key))).id;
  await useWorkstreams.getState().refresh();
  return id;
};
const proposals = () => Object.values(useWorkspace.getState().proposals);
const nudges = () => proposals().filter((p) => p.label === "Nudge for the reporter");

/** A workstream on CA-408 whose questions to the reporter were posted `days` days ago, as the audit would say it. */
async function waitedOn(days: number) {
  const id = await open("CA-408");
  const posted = ago(days);
  backend.workstreams.seedEvent(id, "person", "clarity_asked", ago(days + 0.1), { proposalId: "old-ask" });
  backend.workstreams.seedEvent(id, "person", "draft_approved", posted, { proposalId: "old-ask" });
  await useWorkstreams.getState().refresh();
  expect(stored(id).waitingOnReporter?.since).toBe(posted);
  return id;
}

describe("Draft a nudge", () => {
  it("is refused while nobody is waited on and while the wait is under 2 days, and nothing is drafted", async () => {
    const id = await open("CA-408");
    await expect(backend.workstreamsNudgeReporter(id)).rejects.toThrow("isn't due a nudge");
    const fresh = await waitedOn(1.5);
    await expect(backend.workstreamsNudgeReporter(fresh)).rejects.toThrow("isn't due a nudge");
    expect(await useWorkstreams.getState().nudgeReporter(fresh)).toBe(false);
    expect(texts()[0]).toMatch(/^Couldn't draft the nudge\. This workstream isn't due a nudge to the reporter\./);
    await useWorkspace.getState().refreshProposals();
    expect(nudges()).toEqual([]);
  });

  it("drafts a short, polite comment for approval after 2 days, in the workstream, audited, posting nothing", async () => {
    const id = await waitedOn(3);
    expect(await useWorkstreams.getState().nudgeReporter(id)).toBe(true);
    await useWorkspace.getState().refreshProposals();
    const [nudge] = nudges();
    expect(nudge).toMatchObject({ state: { type: "pending" }, createdBy: "user", intent: { type: "comment" }, origin: { type: "chat", workstream: id } });
    const text = docText(nudge.intent.type === "comment" ? nudge.intent.body : { blocks: [] });
    expect(text).toMatch(/^Hi @Mette Lund,/);
    expect(text).toContain("A gentle nudge on the questions above");
    expect(text).toContain("CA-408");
    expect(text.length).toBeLessThan(300);
    expect(backend.proposals.writes).toEqual([]);
    expect(events(id).find((e) => e.action === "reporter_nudged")).toMatchObject({ actor: "person", proposalId: nudge.id });
    // The decision opens in Pip home's pane, with its card focused so Post comment is not one key away.
    expect(usePipHome.getState()).toMatchObject({ deciding: `draft:${nudge.id}`, selected: id });
  });

  it("is a draft in Needs you like the questions, and never one of the safe batch", async () => {
    const id = await waitedOn(3);
    await useWorkstreams.getState().nudgeReporter(id);
    await useWorkspace.getState().refreshProposals();
    const [nudge] = nudges();
    expect(safeToBatch(nudge)).toBe(false);
    expect(currentNeeds().find((n) => n.key === `draft:${nudge.id}`)).toMatchObject({ group: "approve", batchable: false, title: "Nudge for the reporter" });
    // A plain comment beside it is batchable, so the exclusion is the nudge's own.
    expect(safeToBatch({ ...nudge, label: null } as Proposal)).toBe(true);
  });

  it("waits while one is drafted, and posting it starts the wait again from then", async () => {
    const id = await waitedOn(4);
    await useWorkstreams.getState().nudgeReporter(id);
    await useWorkspace.getState().refreshProposals();
    const [nudge] = nudges();
    expect(nudgeOffered(stored(id).waitingOnReporter, new Date(), proposals(), id)).toBe(false);
    await expect(backend.workstreamsNudgeReporter(id)).rejects.toThrow("isn't due a nudge");
    await backend.proposalsApprove(nudge.id);
    await useWorkstreams.getState().refresh();
    await useWorkspace.getState().refreshProposals();
    expect(backend.proposals.writes.map((w) => w.proposalId)).toEqual([nudge.id]);
    expect(Date.now() - Date.parse(stored(id).waitingOnReporter!.since)).toBeLessThan(60_000);
    expect(nudgeOffered(stored(id).waitingOnReporter, new Date(), proposals(), id)).toBe(false);
    // Skipped instead, nothing changed: the same wait, and a nudge may be drafted again.
    const other = await waitedOn(5);
    await useWorkstreams.getState().nudgeReporter(other);
    await useWorkspace.getState().refreshProposals();
    const second = nudges().find((p) => p.state.type === "pending" && p.origin.type === "chat" && p.origin.workstream === other)!;
    await backend.proposalsSkip(second.id);
    await useWorkspace.getState().refreshProposals();
    expect(nudgeOffered(stored(other).waitingOnReporter, new Date(), proposals(), other)).toBe(true);
  });

  it("is not a need: waiting on the reporter adds nothing to Needs you", async () => {
    await waitedOn(9);
    expect(currentNeeds()).toEqual([]);
  });
});

describe("what Looks fine teaches the clarity notice", () => {
  const thinTickets = ["CA-402", "CA-409", "CA-209"];
  async function dismissAll(keys: readonly string[]) {
    const ids: string[] = [];
    for (const key of keys) {
      backend.editTicket(key, { description: THIN });
      const id = await open(key);
      expect(stored(id).clarity?.gaps).toEqual(["short", "done", "scope", "who"]);
      ids.push(id);
    }
    return ids;
  }

  it("stops flagging the same gap in a project after the third Looks fine, and tells the person how to give it back", async () => {
    const [a, b, c] = await dismissAll(thinTickets);
    expect(LEARN_AFTER).toBe(3);
    await useWorkstreams.getState().looksFine(a);
    await useWorkstreams.getState().looksFine(b);
    expect(usePrefs.getState().clarityLearning).toEqual({ CA: { short: 2, done: 2, scope: 2, who: 2 } });
    // The first and second say how many more it takes; the second replaces the first, which is out of date.
    expect(texts()).toEqual([
      "Noted for short description, no \"done\" criteria, no scope and no \"who is waiting\". After 1 more Looks fine on CA tickets like this, Gossamr stops flagging them (Settings > Unclear tickets).",
    ]);
    useToasts.getState().clear();
    await useWorkstreams.getState().looksFine(c);
    expect(usePrefs.getState().clarityLearning).toEqual({ CA: { short: 3, done: 3, scope: 3, who: 3 } });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain("Gossamr will stop flagging CA tickets that have a very short description, or that don't say what done looks like");
    expect(texts()[0]).toContain("Settings, or from ⌘K");
    // Audited, one line for each gap, in the workstream where the third dismissal was.
    expect(events(c).filter((e) => e.action === "clarity_learned").map((e) => [e.actor, e.detail])).toEqual([
      ["person", "short in CA"],
      ["person", "done in CA"],
      ["person", "scope in CA"],
      ["person", "who in CA"],
    ]);
    expect(events(c).filter((e) => e.action === "clarity_dismissed")).toHaveLength(1);
    expect(backend.proposals.writes).toEqual([]);
  });

  it("gives back what it learned without the old 'will stop flagging' note staying ahead of the 'as before' one", async () => {
    const ids = await dismissAll(thinTickets);
    await useWorkstreams.getState().looksFine(ids[0]);
    await useWorkstreams.getState().looksFine(ids[1]);
    useToasts.getState().clear();
    await useWorkstreams.getState().looksFine(ids[2]);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatch(/^Gossamr will stop flagging CA /);
    expect(await giveBackClarity("CA")).toBe(1);
    expect(texts()).toEqual(["Gossamr will flag new unclear CA tickets as before."]);
  });

  it("three Looks fine in a row leave 'stopped flagging' on screen, never the 'After N more' counters", async () => {
    const ids = await dismissAll(thinTickets);
    for (const id of ids) await useWorkstreams.getState().looksFine(id);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatch(/^Gossamr will stop flagging CA /);
  });

  it("Give back all retires the 'After N more' counter that was on screen, and says what stays dismissed", async () => {
    const [a] = await dismissAll(thinTickets);
    await useWorkstreams.getState().looksFine(a);
    expect(texts()[0]).toMatch(/^Noted for .*\. After 2 more/);
    usePrefs.setState({ clarityLearning: { CA: { who: 3 } } });
    expect(await giveBackClarity()).toBe(1);
    expect(texts()).toEqual(["Gossamr will flag new unclear tickets as before in every project."]);
  });

  it("a note about giving back several projects is replaced by a later note about any one of them", () => {
    pushLearning(["CA", "WEB"], "Gossamr will flag new unclear tickets as before in every project.");
    pushLearning("WEB", "Noted. After 2 more Looks fine on WEB tickets like this, Gossamr stops flagging it.");
    expect(texts()).toEqual(["Noted. After 2 more Looks fine on WEB tickets like this, Gossamr stops flagging it."]);
  });

  it("a counter is not news once the count moved on", async () => {
    const [a, b] = await dismissAll(thinTickets);
    await useWorkstreams.getState().looksFine(a);
    const first = useToasts.getState().toasts[0];
    expect(first.current?.()).toBe(true);
    usePrefs.setState({ clarityLearning: {} });
    expect(first.current?.()).toBe(false);
    void b;
  });

  it("applies to the project only: another project's ticket is still flagged, and the learned ones' notice is left out by the page", async () => {
    await dismissAll(thinTickets).then(async (ids) => {
      for (const id of ids) await useWorkstreams.getState().looksFine(id);
    });
    const { flaggedGaps } = await import("../lib/clarityLearning");
    const learning = usePrefs.getState().clarityLearning;
    expect(flaggedGaps(["short", "who"], learning, "CA")).toEqual([]);
    expect(flaggedGaps(["short", "who"], learning, "WEB")).toEqual(["short", "who"]);
  });

  it("leaves a learned gap out of the questions Ask the reporter now drafts, and is stale when none is left", async () => {
    usePrefs.setState({ clarityLearning: { CA: { who: 3, scope: 3 } } });
    backend.editTicket("CA-402", { description: THIN });
    const id = await open("CA-402");
    expect(await useWorkstreams.getState().askReporterNow(id)).toBe(true);
    await useWorkspace.getState().refreshProposals();
    const asked = proposals().find((p) => p.label === "Questions for the reporter")!;
    const text = docText(asked.intent.type === "comment" ? asked.intent.body : { blocks: [] });
    expect(text).toContain("What is the goal?");
    expect(text).toContain("How will we know it is done");
    expect(text).not.toContain("What is in scope");
    expect(text).not.toContain("Who asked for it");

    backend.editTicket("CA-409", { description: THIN });
    usePrefs.setState({ clarityLearning: { CA: { short: 3, done: 3, scope: 3, who: 3 } } });
    const none = await open("CA-409");
    useToasts.getState().clear();
    expect(await useWorkstreams.getState().askReporterNow(none)).toBe(false);
    expect(texts()).toEqual(["The workstream isn't waiting for that choice any more."]);
    await expect(backend.workstreamsClarityAsk(none, ["short", "done", "scope", "who"])).rejects.toThrow("isn't flagged as possibly unclear");
  });

  it("is given back for a project or for all, audited where there is an open workstream, and nothing is learned to give back otherwise", async () => {
    expect(await giveBackClarity()).toBe(0);
    expect(texts()).toEqual(["Gossamr hasn't learned anything from Looks fine yet."]);
    useToasts.getState().clear();
    usePrefs.setState({ clarityLearning: { CA: { who: 3 }, WEB: { done: 4 }, SUP: { scope: 1 } } });
    const id = await open("CA-402");
    expect(await giveBackClarity("CA")).toBe(1);
    expect(usePrefs.getState().clarityLearning).toEqual({ WEB: { done: 4 }, SUP: { scope: 1 } });
    expect(events(id).find((e) => e.action === "clarity_reset")).toMatchObject({ actor: "person", detail: "CA" });
    expect(texts()).toEqual(["Gossamr will flag new unclear CA tickets as before."]);
    // WEB has no open workstream: given back, with no audit line to write it in.
    expect(await giveBackClarity()).toBe(1);
    expect(usePrefs.getState().clarityLearning).toEqual({});
  });

  it("gives back one gap of a project, audited with its own detail, and keeps the project's others learned", async () => {
    usePrefs.setState({ clarityLearning: { CA: { who: 3, scope: 4 }, WEB: { who: 3 } } });
    const id = await open("CA-402");
    expect(await giveBackClarity("CA", ["who"])).toBe(1);
    expect(usePrefs.getState().clarityLearning).toEqual({ CA: { scope: 4 }, WEB: { who: 3 } });
    expect(events(id).filter((e) => e.action === "clarity_reset").map((e) => e.detail)).toEqual(["who in CA"]);
    expect(texts()).toEqual(["Gossamr will flag CA tickets with no \"who is waiting\" as before."]);
    // A gap that isn't learned there gives back nothing.
    useToasts.getState().clear();
    expect(await giveBackClarity("CA", ["who"])).toBe(0);
    expect(usePrefs.getState().clarityLearning).toEqual({ CA: { scope: 4 }, WEB: { who: 3 } });
  });

  it("does not give the learning back when its audit line can't be written, and says so", async () => {
    usePrefs.setState({ clarityLearning: { CA: { who: 3 }, WEB: { done: 4 } } });
    const id = await open("CA-402");
    const note = vi.spyOn(backend, "workstreamsClarityNote").mockRejectedValue(new Error("down"));
    expect(await giveBackClarity("CA")).toBe(0);
    expect(usePrefs.getState().clarityLearning).toEqual({ CA: { who: 3 }, WEB: { done: 4 } });
    expect(events(id).some((e) => e.action === "clarity_reset")).toBe(false);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain("CA wasn't reset. Try again.");
    expect(useToasts.getState().toasts[0].tone).toBe("error");
    // With all of them: the project with no open workstream is reset, the one whose audit failed is kept.
    useToasts.getState().clear();
    expect(await giveBackClarity()).toBe(1);
    expect(usePrefs.getState().clarityLearning).toEqual({ CA: { who: 3 } });
    // It names the project it reset, not "every project": CA still has its learning.
    expect(texts()).toContain("Gossamr will flag new unclear WEB tickets as before.");
    expect(texts().some((t) => t.includes("every project"))).toBe(false);
    note.mockRestore();
    useToasts.getState().clear();
    expect(await giveBackClarity("CA")).toBe(1);
    expect(usePrefs.getState().clarityLearning).toEqual({});
    expect(events(id).find((e) => e.action === "clarity_reset")).toMatchObject({ detail: "CA" });
  });

  it("says the soonest count when the gaps stand apart, and not that all of them stop", async () => {
    usePrefs.setState({ clarityLearning: { CA: { short: 1 } } });
    backend.editTicket("CA-402", { description: THIN });
    await useWorkstreams.getState().looksFine(await open("CA-402"));
    expect(texts()).toEqual(["Noted for short description, no \"done\" criteria, no scope and no \"who is waiting\". After 1 more Looks fine on CA tickets like this, Gossamr stops flagging the first of them (Settings > Unclear tickets)."]);
  });

  it("clears the 'will stop flagging' notes only of the projects it reset, not one whose audit failed", async () => {
    usePrefs.setState({ clarityLearning: { CA: { who: 3 }, WEB: { done: 4 } } });
    await open("CA-402");
    pushLearning("CA", "Gossamr will stop flagging CA tickets that don't say who asked for it. Give that back.");
    pushLearning("WEB", "Gossamr will stop flagging WEB tickets that don't say what done looks like. Give that back.");
    vi.spyOn(backend, "workstreamsClarityNote").mockRejectedValue(new Error("down"));
    expect(await giveBackClarity()).toBe(1);
    expect(usePrefs.getState().clarityLearning).toEqual({ CA: { who: 3 } });
    expect(texts().some((t) => t.startsWith("Gossamr will stop flagging CA "))).toBe(true);
    expect(texts().some((t) => t.startsWith("Gossamr will stop flagging WEB "))).toBe(false);
  });

  it("dismisses the notice but doesn't count it toward learning when the clarity_learned write fails", async () => {
    const [a, b, c] = await (async () => {
      const ids: string[] = [];
      for (const key of ["CA-402", "CA-409", "CA-209"]) {
        backend.editTicket(key, { description: THIN });
        ids.push(await open(key));
      }
      return ids;
    })();
    await useWorkstreams.getState().looksFine(a);
    await useWorkstreams.getState().looksFine(b);
    useToasts.getState().clear();
    const note = vi.spyOn(backend, "workstreamsClarityNote").mockRejectedValue(new Error("down"));
    expect(await useWorkstreams.getState().looksFine(c)).toBe(true);
    expect(events(c).filter((e) => e.action === "clarity_dismissed")).toHaveLength(1);
    expect(events(c).some((e) => e.action === "clarity_learned")).toBe(false);
    expect(usePrefs.getState().clarityLearning).toEqual({ CA: { short: 2, done: 2, scope: 2, who: 2 } });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain("couldn't note what Gossamr learned");
    expect(useToasts.getState().toasts[0].tone).toBe("error");
    note.mockRestore();
  });

  it("takes only the two clarity notes into the audit", async () => {
    const id = await open("CA-402");
    await expect(backend.workstreamsClarityNote(id, "draft_approved" as never, "x")).rejects.toThrow("isn't a note about the clarity check");
    await backend.workstreamsClarityNote(id, "clarity_learned", "who in CA");
    expect(events(id).find((e) => e.action === "clarity_learned")).toMatchObject({ actor: "person", detail: "who in CA" });
  });
});

describe("What Jira saw from me", () => {
  it("lists what the person approved, with who drafted it, where from, and whether they edited it first", async () => {
    const id = await waitedOn(3);
    await useWorkstreams.getState().nudgeReporter(id);
    await useWorkspace.getState().refreshProposals();
    const [nudge] = nudges();
    await backend.proposalsApprove(nudge.id);
    const other = await backend.proposalsCreate({ type: "comment", item: itemRef("CA-402"), body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "On it.", marks: [] }] }] } });
    await backend.proposalsEdit(other.id, { type: "comment", body: "On it, today.", mentions: [] });
    await backend.proposalsApprove(other.id);
    await useWorkspace.getState().refreshProposals();
    await useWorkstreams.getState().loadEvents(id);
    const sent = jiraSent({ proposals: proposals(), events: useWorkstreams.getState().events, workstreams: useWorkstreams.getState().list });
    expect(sent.map((e) => [e.ticketKey, e.kind, e.madeBy, e.edited])).toEqual([
      ["CA-402", "comment", "You", true],
      ["CA-408", "comment", "Gossamr", false],
    ]);
    expect(sent[0]).toMatchObject({ summary: "On it, today.", workstreamId: null, from: "the board" });
    expect(sent[1]).toMatchObject({ workstreamId: id, workstream: "CA-408", from: "Gossamr" });
    // A draft still waiting, or skipped, is not there.
    const waiting = await backend.proposalsCreate({ type: "comment", item: itemRef("CA-403"), body: { blocks: [] } });
    await useWorkspace.getState().refreshProposals();
    expect(jiraSent({ proposals: proposals(), events: {}, workstreams: [] }).map((e) => e.id)).not.toContain(waiting.id);
  });
});
