import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Backend } from "../backend/types";
import { itemRef } from "../backend/mockConnector";
import { NO_FILTERS, agentGroups } from "./agentsLogic";
import { useWorkstreams } from "./workstreamsStore";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";
import { usePrefs } from "./prefs";
import { answerKey, keepAnswer, keptAnswer } from "./keptAnswers";
import { browseList, useRuns } from "./runsStore";
import { laneOf, needsAttention } from "./agentsLogic";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

const s = () => useRuns.getState();
const settle = () => new Promise((r) => setTimeout(r, 0));

let backend: MockBackend;

beforeEach(() => {
  vi.stubGlobal("localStorage", memory());
  useRuns.setState({ dismissed: new Set(), filters: NO_FILTERS, earlierOpen: false, introOpen: false, stopping: false });
  useToasts.getState().clear();
  useTabs.getState().setRoute("workspace");
  backend = new MockBackend();
  s().init(backend);
});

describe("the runs store", () => {
  it("loads the runs", async () => {
    s().init(backend);
    expect(s()).toMatchObject({ status: "loading", runs: [] });
    await settle();
    expect(s().status).toBe("ready");
    expect(s().runs).toHaveLength(8);
  });

  it("refreshes when the backend says runs changed", async () => {
    await settle();
    const id = s().runs.find((r) => r.state === "needsPermission")!.id;
    backend.runs.advance(id);
    await settle();
    expect(s().runs.find((r) => r.id === id)?.state).toBe("working");
  });

  it("stops listening once disposed", async () => {
    await settle();
    s().dispose();
    backend.runs.advance();
    await settle();
    expect(s().runs).toEqual([]);
    expect(s().backend).toBeNull();
  });

  it("shows why the runs could not be read and recovers on retry", async () => {
    await settle();
    const failing = vi.spyOn(backend, "runsList").mockRejectedValueOnce(new Error("database is locked"));
    await s().reload();
    expect(s()).toMatchObject({ status: "error", error: "database is locked" });
    expect(s().runs).toHaveLength(8);
    await s().reload();
    expect(s().status).toBe("ready");
    failing.mockRestore();
  });

  it("ignores a read that finished after a newer one started", async () => {
    await settle();
    let release!: (runs: Awaited<ReturnType<Backend["runsList"]>>) => void;
    const slow = new Promise<Awaited<ReturnType<Backend["runsList"]>>>((r) => (release = r));
    const list = vi.spyOn(backend, "runsList").mockReturnValueOnce(slow);
    const older = s().reload();
    await s().reload();
    release([]);
    await older;
    expect(s().runs).toHaveLength(8);
    list.mockRestore();
  });

  it("never takes a failed run out of Needs you for being looked at; only a Dismiss does, and it is remembered", async () => {
    s().init(new MockBackend({ runs: { seed: "failures" } }));
    await settle();
    const waiting = () => s().runs.filter((r) => needsAttention(r, s().dismissed)).length;
    expect(waiting()).toBe(7);
    // Nothing the store does on its own is a look that clears a failure: reloading leaves all seven.
    await s().reload();
    expect(waiting()).toBe(7);
    const [first] = s().runs;
    s().dismiss(first.id);
    expect(waiting()).toBe(6);
    expect(s().dismissed.has(first.id)).toBe(true);
    expect(JSON.parse(localStorage.getItem("gossamr-runs-dismissed")!)).toEqual([first.id]);
    // Dismissing twice is one.
    s().dismiss(first.id);
    expect(JSON.parse(localStorage.getItem("gossamr-runs-dismissed")!)).toEqual([first.id]);
  });

  it("opens a run from a notification: shows the view, selects it and clears the filters", async () => {
    await settle();
    s().setFilter({ repo: "acme/payments" });
    const offer = vi.fn();
    const off = backend.onOpenRun(offer);
    backend.runs.open("run-seed-3");
    off();
    expect(useTabs.getState().route).toBe("agents");
    expect(s().selectedId).toBe("run-seed-3");
    expect(s().filters).toEqual(NO_FILTERS);
    expect(offer).toHaveBeenCalledWith("run-seed-3");
  });

  it("combines filters and clears them", () => {
    s().setFilter({ lane: "bad" });
    s().setFilter({ repo: "acme/payments" });
    expect(s().filters).toEqual({ lane: "bad", repo: "acme/payments", ticket: "all" });
    s().clearFilters();
    expect(s().filters).toEqual(NO_FILTERS);
  });

  it("attaches through the backend and says when Terminal could not open", async () => {
    await settle();
    const run = s().runs.find((r) => r.state === "needsAnswer")!;
    await s().attach(run.id);
    expect(backend.runs.attached).toEqual([run.id]);
    await s().attach("run-missing");
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual([expect.stringMatching(/^Couldn't open Terminal: /)]);
  });

  it("stops everything that can be stopped, says how many, and reloads", async () => {
    await settle();
    await s().stopAll();
    expect(useToasts.getState().toasts[0]).toMatchObject({ text: "Stopped 5 agents", tone: "info" });
    expect(s().runs.filter((r) => r.state === "stopped")).toHaveLength(5);
    expect(s().stopping).toBe(false);
  });

  it("names the runs waiting for a slot that Stop all stopped before they started", async () => {
    await settle();
    vi.spyOn(backend, "runsStopAll").mockResolvedValueOnce({ stopped: 3, failed: 0, waiting: 2 });
    await s().stopAll();
    expect(useToasts.getState().toasts[0]).toMatchObject({ text: "Stopped 3 agents and 2 waiting to start", tone: "info" });
  });

  it("says so when Start now finds every slot taken, instead of doing nothing visible", async () => {
    await settle();
    const queued = { ...s().runs[0], state: "queued" as const, slotWaitSince: "2026-09-30T11:00:00Z" };
    vi.spyOn(backend, "runsStartNow").mockResolvedValueOnce(queued);
    await s().startNow(queued.id);
    expect(useToasts.getState().toasts[0].text).toBe("Every slot is taken, so it waits and starts when one of the running agents finishes.");
  });

  it("reports a failed Stop all instead of swallowing it", async () => {
    await settle();
    vi.spyOn(backend, "runsStopAll").mockRejectedValueOnce(new Error("runs_stop_all is not available yet"));
    await s().stopAll();
    expect(useToasts.getState().toasts[0].text).toBe("Couldn't stop the agents: runs_stop_all is not available yet");
    expect(s().stopping).toBe(false);
  });
});

describe("the run sheet", () => {
  it("opens on the Agents view with the run selected, and closes", async () => {
    await settle();
    s().openRun("run-seed-3");
    expect(s().sheet).toEqual({ type: "run", id: "run-seed-3" });
    expect(s().selectedId).toBe("run-seed-3");
    expect(useTabs.getState().route).toBe("agents");
    s().closeSheet();
    expect(s().sheet).toBeNull();
  });

  it("stays on the board when opened from a ticket, keeping the filters", async () => {
    await settle();
    s().setFilter({ repo: "acme/payments" });
    s().openRun("run-seed-3", { stay: true });
    expect(useTabs.getState().route).toBe("workspace");
    expect(s().filters.repo).toBe("acme/payments");
    useTabs.getState().setRoute("settings");
    s().openRun("run-seed-3", { stay: true });
    expect(useTabs.getState().route).toBe("agents");
  });

  it("browses with j and k in the order the view lists the runs, and stops at the ends", async () => {
    await settle();
    // The first run of the view's own order: from there k has nowhere to go.
    const first = s().runs.find((r) => r.id === agentGroups("state", s().runs, [], NO_FILTERS, false, Date.now()).order[0])!;
    s().openRun(first.id);
    s().browse(-1);
    expect(s().sheet).toEqual({ type: "run", id: first.id });
    s().browse(1);
    const second = (s().sheet as { id: string }).id;
    expect(second).not.toBe(first.id);
    expect(s().selectedId).toBe(second);
    s().browse(-1);
    expect(s().sheet).toEqual({ type: "run", id: first.id });
  });

  it("browses in group order when the view groups by workstream, as the list on screen is", async () => {
    const ws = await backend.workstreamsOpen(itemRef("CA-401"));
    const run = backend.runs.start({ role: "investigate", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-401-browse-1a2b", brief: "", workstream: ws.id }, itemRef("CA-401"));
    // Finished, it is in the Done lane by state, behind the runs still working, and first by workstream.
    for (let i = 0; i < 3; i++) backend.runs.advance(run.id);
    useWorkstreams.getState().init(backend);
    await s().reload();
    await vi.waitFor(() => expect(useWorkstreams.getState().list).toHaveLength(1));
    usePrefs.setState({ agentsGroup: "workstream" });
    try {
      // The sample's clock stands at 12:00 on 30 September 2026.
      const soon = Date.parse("2026-09-30T12:05:00Z");
      const byWorkstream = agentGroups("workstream", s().runs, useWorkstreams.getState().list, NO_FILTERS, false, soon).order;
      const byState = agentGroups("state", s().runs, [], NO_FILTERS, false, soon).order;
      expect(byWorkstream[0]).toBe(run.id);
      expect(byState.indexOf(run.id)).toBeGreaterThan(0);
      s().openRun(run.id);
      s().browse(-1);
      expect(s().sheet).toEqual({ type: "run", id: run.id });
      s().browse(1);
      expect(s().sheet).toEqual({ type: "run", id: byWorkstream[1] });
    } finally {
      usePrefs.setState({ agentsGroup: "state" });
      useWorkstreams.getState().dispose();
    }
  });

  it("does not browse from the safety sheet", async () => {
    await settle();
    s().openSafety();
    s().browse(1);
    expect(s().sheet).toEqual({ type: "safety" });
  });

  it("stops one run through the backend and says when it cannot", async () => {
    await settle();
    const working = s().runs.find((r) => r.state === "working")!;
    await s().stop(working.id);
    await settle();
    expect(s().runs.find((r) => r.id === working.id)?.state).toBe("stopped");
    const done = s().runs.find((r) => r.state === "done")!;
    await s().stop(done.id);
    expect(useToasts.getState().toasts[0].text).toMatch(/^Couldn't stop it: /);
  });

  it("starts a queued run and retries a failed launch", async () => {
    await settle();
    const failed = s().runs.find((r) => r.state === "failed")!;
    await s().fix(failed.id, "terminal");
    await s().retryLaunch(failed.id);
    await settle();
    expect(s().runs.find((r) => r.id === failed.id)?.state).toBe("queued");
    await s().startNow(failed.id);
    await settle();
    expect(s().runs.find((r) => r.id === failed.id)?.state).toBe("launching");
    await s().startNow(failed.id);
    expect(useToasts.getState().toasts[0].text).toMatch(/^Couldn't start it: /);
  });

  describe("a launch that failed on something the person can fix", () => {
    const failing = async (kind: string) => {
      backend = new MockBackend({ runs: { seed: "failures" } });
      s().init(backend);
      await settle();
      return s().runs.find((r) => r.failure?.type === kind)!;
    };
    const find = (id: string) => s().runs.find((r) => r.id === id)!;

    it("opens Terminal for an untrusted folder, then lets Retry through to Queued", async () => {
      const run = await failing("untrustedFolder");
      expect(s().terminalOpened.has(run.id)).toBe(false);
      await s().fix(run.id, "terminal");
      expect(backend.runs.terminals).toEqual([run.id]);
      expect(s().terminalOpened.has(run.id)).toBe(true);
      await s().retryLaunch(run.id);
      await settle();
      expect(find(run.id)).toMatchObject({ state: "queued", error: null, failure: null, endedAt: null });
      expect(s().terminalOpened.has(run.id)).toBe(false);
      backend.runs.advance(run.id);
      await settle();
      expect(find(run.id).state).toBe("launching");
      backend.runs.advance(run.id);
      await settle();
      expect(find(run.id).state).toBe("working");
    });

    it("says it is still blocked when Retry is pressed before the folder was trusted", async () => {
      const run = await failing("untrustedFolder");
      await s().retryLaunch(run.id);
      await settle();
      expect(find(run.id)).toMatchObject({ state: "failed", failure: { type: "untrustedFolder" } });
      expect(useToasts.getState().toasts[0].text).toMatch(/^Still blocked: Claude asks you once per folder/);
    });

    it("signs in through Terminal for a run that failed on a sign-in, and not for any other", async () => {
      const run = await failing("notSignedIn");
      await s().fix(run.id, "terminal");
      expect(backend.runs.terminals).toEqual([run.id]);
      await s().retryLaunch(run.id);
      await settle();
      expect(find(run.id).state).toBe("queued");
      const other = await failing("other");
      await s().fix(other.id, "terminal");
      expect(useToasts.getState().toasts[0].text).toMatch(/^Couldn't open Terminal: /);
      expect(s().terminalOpened.has(other.id)).toBe(false);
    });

    it("does not carry the Terminal step over to a retry that fails for another reason", async () => {
      const run = await failing("untrustedFolder");
      await s().fix(run.id, "terminal");
      vi.spyOn(backend, "runsRetryLaunch").mockResolvedValueOnce({ ...run, failure: { type: "notSignedIn" }, error: "Claude isn't signed in." });
      await s().retryLaunch(run.id);
      expect(s().terminalOpened.has(run.id)).toBe(false);
      expect(useToasts.getState().toasts[0].text).toMatch(/^It failed again: /);
    });

    it("counts copying the command as taking the step, since that is how someone uses their own terminal", async () => {
      const run = await failing("untrustedFolder");
      s().noteCopied(run.id);
      expect(s().terminalOpened.has(run.id)).toBe(true);
    });

    it("opens the install page for a missing Claude", async () => {
      const run = await failing("claudeMissing");
      const open = vi.spyOn(backend, "openUrl");
      await s().fix(run.id, "install");
      expect(open).toHaveBeenCalledWith("https://code.claude.com/docs/en/setup");
    });

    it("keeps every failure, a folder to trust among them, waiting on the person until it is dismissed", async () => {
      const run = await failing("untrustedFolder");
      const other = s().runs.find((r) => r.failure?.type === "other")!;
      expect(s().dismissed.has(run.id)).toBe(false);
      expect(needsAttention(run, s().dismissed)).toBe(true);
      expect(needsAttention(other, s().dismissed)).toBe(true);
      s().dismiss(other.id);
      expect(needsAttention(other, s().dismissed)).toBe(false);
      expect(needsAttention(run, s().dismissed)).toBe(true);
    });

    it("lets a dismissed failure back into Needs you if it fails again after a retry that worked", async () => {
      const run = await failing("notSignedIn");
      s().dismiss(run.id);
      expect(s().dismissed.has(run.id)).toBe(true);
      await s().fix(run.id, "terminal");
      await s().retryLaunch(run.id);
      await settle();
      expect(s().dismissed.has(run.id)).toBe(false);
      expect(JSON.parse(localStorage.getItem("gossamr-runs-dismissed")!)).not.toContain(run.id);
    });
  });

  it("opens the sheet when a notification asks for a run", async () => {
    await settle();
    backend.runs.open("run-seed-2");
    expect(s().sheet).toEqual({ type: "run", id: "run-seed-2" });
  });

  describe("answering a question", () => {
    const asking = async () => {
      await settle();
      return s().runs.find((r) => r.state === "needsAnswer")!;
    };

    it("sends the answer once and the run carries on under the same id", async () => {
      const run = await asking();
      const send = vi.spyOn(backend, "runsAnswer");
      const done = s().answer(run.id, "Yes, keep it.");
      await s().answer(run.id, "Yes, keep it.");
      await done;
      await settle();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(run.id, "Yes, keep it.");
      expect(s().runs.find((r) => r.id === run.id)).toMatchObject({ state: "working", needs: null, shortId: run.shortId });
      expect(s().answering.size).toBe(0);
    });

    it("says the answer went, and marks it sent until the run reports progress", async () => {
      const run = await asking();
      await s().answer(run.id, "Yes, keep it.");
      await settle();
      expect(useToasts.getState().toasts.map((t) => [t.text, t.tone])).toContainEqual(["Answer sent. Claude is picking it back up. Only the agent sees your answer; nothing goes to Jira.", "info"]);
      const now = s().runs.find((r) => r.id === run.id)!;
      expect(s().answered[run.id]).toBe(now.lastProgressAt);
    });

    it("keeps the run sheet's place in the browse order when the answered run changes lane", async () => {
      const run = await asking();
      s().openRun(run.id);
      const before = [...s().browseOrder!];
      const at = before.indexOf(run.id);
      await s().answer(run.id, "Yes, keep it.");
      await settle();
      expect(s().runs.find((r) => r.id === run.id)?.state).toBe("working");
      // It has moved from Failed or stuck to Running; the sheet still walks the order it opened with.
      const live = agentGroups("state", s().runs, [], NO_FILTERS, false, Date.now()).order;
      // The sample's clock stands at 12:00 on 30 September 2026.
      const soon = Date.parse("2026-09-30T12:05:00Z");
      expect(laneOf(run, soon)).toBe("bad");
      expect(laneOf(s().runs.find((r) => r.id === run.id)!, soon)).toBe("running");
      expect(browseList(s().browseOrder, live).indexOf(run.id)).toBe(at);
      s().browse(1);
      expect(s().sheet).toEqual({ type: "run", id: before[at + 1] });
      s().browse(-1);
      expect(s().sheet).toEqual({ type: "run", id: run.id });
      s().closeSheet();
      expect(s().browseOrder).toBeNull();
    });

    it("forgets a typed answer once the run no longer waits, even with no answer box on screen", async () => {
      const run = await asking();
      keepAnswer(run, "Yes, keep it.");
      expect(keptAnswer(answerKey(run))).toBe("Yes, keep it.");
      await backend.runsAnswer(run.id, "Sent from elsewhere.");
      await s().reload();
      expect(keptAnswer(answerKey(run))).toBeUndefined();
    });

    it("says why it failed and lets the person try again", async () => {
      const run = await asking();
      vi.spyOn(backend, "runsAnswer").mockRejectedValueOnce(new Error("Claude started a copy. Your answer is kept on the run."));
      // false, so the answer box keeps what was typed for the next try.
      expect(await s().answer(run.id, "Yes")).toBe(false);
      expect(useToasts.getState().toasts[0].text).toBe("Couldn't send the answer: Claude started a copy. Your answer is kept on the run.");
      expect(s().answering.size).toBe(0);
      expect(await s().answer(run.id, "Yes")).toBe(true);
      await settle();
      expect(s().runs.find((r) => r.id === run.id)?.state).toBe("working");
    });

    it("lets a second run be answered while the first is on its way, and each only once", async () => {
      backend = new MockBackend({ runs: { seed: "many" } });
      s().init(backend);
      await settle();
      const [first, second] = s().runs.filter((r) => r.state === "needsAnswer");
      expect(second).toBeDefined();
      const send = vi.spyOn(backend, "runsAnswer");
      const one = s().answer(first.id, "Yes");
      expect(s().answering.has(first.id) && !s().answering.has(second.id)).toBe(true);
      const two = s().answer(second.id, "No");
      await s().answer(first.id, "Yes again");
      await Promise.all([one, two]);
      expect(send.mock.calls).toEqual([[first.id, "Yes"], [second.id, "No"]]);
    });

    it("is refused for a permission prompt", async () => {
      await settle();
      const run = s().runs.find((r) => r.state === "needsPermission")!;
      await s().answer(run.id, "Yes");
      expect(useToasts.getState().toasts[0].text).toMatch(/asking permission, which is answered in Terminal/);
      expect(s().runs.find((r) => r.id === run.id)?.state).toBe("needsPermission");
    });
  });
});

describe("adopting a session", () => {
  it("says so on success, and only the error on failure", async () => {
    vi.spyOn(backend, "runsAdoptSession").mockResolvedValueOnce(undefined as never);
    await s().adoptSession("r1", "abcdef1234567890");
    expect(useToasts.getState().toasts.map((t) => [t.text, t.tone])).toEqual([["Adopted session abcdef12. Gossamr follows that session from here.", "info"]]);
    useToasts.getState().clear();
    vi.spyOn(backend, "runsAdoptSession").mockRejectedValueOnce(new Error("nope"));
    await s().adoptSession("r1", "abcdef1234567890");
    expect(useToasts.getState().toasts.map((t) => t.tone)).toEqual(["error"]);
  });
});
