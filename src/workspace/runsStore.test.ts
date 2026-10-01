import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Backend } from "../backend/types";
import { NO_FILTERS } from "./agentsLogic";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";
import { useRuns } from "./runsStore";
import { attentionCount } from "./agentsLogic";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

const s = () => useRuns.getState();
const settle = () => new Promise((r) => setTimeout(r, 0));

let backend: MockBackend;

beforeEach(() => {
  vi.stubGlobal("localStorage", memory());
  useRuns.setState({ seenFailed: new Set(), filters: NO_FILTERS, earlierOpen: false, introOpen: null, stopping: false });
  useToasts.getState().clear();
  useTabs.getState().setRoute("workspace");
  backend = new MockBackend();
  s().init(backend);
});

describe("the runs store", () => {
  it("loads the runs and the state of Claude", async () => {
    s().init(backend);
    expect(s()).toMatchObject({ status: "loading", runs: [] });
    await settle();
    expect(s().status).toBe("ready");
    expect(s().runs).toHaveLength(8);
    expect(s().environment).toEqual({ claude: "ok", version: "2.1.286" });
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

  it("keeps the badge down once the failed run has been seen, and remembers it", async () => {
    await settle();
    const count = () => attentionCount(s().runs, s().seenFailed);
    expect(count()).toBe(3);
    s().markSeen();
    expect(count()).toBe(2);
    const stored = JSON.parse(localStorage.getItem("gossamr-runs-seen")!);
    expect(stored).toHaveLength(1);
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
    s().setFilter({ lane: "needs" });
    s().setFilter({ repo: "acme/payments" });
    expect(s().filters).toEqual({ lane: "needs", repo: "acme/payments", ticket: "all" });
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
    const first = s().runs.find((r) => r.state === "needsPermission")!;
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
    await s().retryLaunch(failed.id);
    await settle();
    expect(s().runs.find((r) => r.id === failed.id)?.state).toBe("queued");
    await s().startNow(failed.id);
    await settle();
    expect(s().runs.find((r) => r.id === failed.id)?.state).toBe("launching");
    await s().startNow(failed.id);
    expect(useToasts.getState().toasts[0].text).toMatch(/^Couldn't start it: /);
  });

  it("opens the sheet when a notification asks for a run", async () => {
    await settle();
    backend.runs.open("run-seed-2");
    expect(s().sheet).toEqual({ type: "run", id: "run-seed-2" });
  });
});

