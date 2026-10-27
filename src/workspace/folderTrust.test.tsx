import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { useWorkspace } from "../workspaceStore";
import { LOAD_LIMIT_MS, useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

const settle = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runs = () => useRuns.getState();
const CA = itemRef("CA-401");

let backend: MockBackend;

async function start(untrusted = true) {
  vi.stubGlobal("localStorage", memory());
  backend = new MockBackend({ runs: { epoch: Date.parse("2026-09-30T12:00:00Z"), seed: "empty", untrusted } });
  await useWorkspace.getState().init(backend);
  runs().init(backend);
  useToasts.getState().clear();
  useTabs.getState().setRoute("workspace");
  await settle();
}

beforeEach(() => start());
afterEach(() => vi.useRealTimers());

describe("starting in a folder Claude refuses", () => {
  const startOne = () => backend.runs.pipStart({ workstream: null, role: "investigator", brief: "Look into it.", repo: "acme/storefront", item: CA }, `turn-${Math.random()}`);

  it("announces the failure, and Retry goes through once trusted", async () => {
    const started = startOne();
    expect(started.state).toBe("queued");
    await runs().reload();
    expect(runs().launching.has(started.id)).toBe(true);
    useToasts.getState().clear();
    await sleep(700);
    await runs().reload();
    const run = runs().runs.find((r) => r.id === started.id)!;
    expect(run).toMatchObject({ state: "failed", failure: { type: "untrustedFolder", path: "/Users/sample/Code/storefront" } });
    expect(runs().launching.size).toBe(0);
    const toast = useToasts.getState().toasts.slice(-1)[0];
    expect(toast.text).toMatch(/^The agent on CA-401 didn't start\. Claude asks you once per folder/);
    expect(toast.action?.label).toBe("Fix it");

    await runs().fix(run.id, "terminal");
    await runs().retryLaunch(run.id);
    await settle();
    expect(runs().runs.find((r) => r.id === run.id)?.state).toBe("queued");
  });

  it("does not open a sheet over the person's screen, and stops watching a run that started", async () => {
    startOne();
    await runs().reload();
    runs().openSafety();
    await sleep(700);
    await runs().reload();
    expect(runs().sheet).toEqual({ type: "safety" });
    expect(runs().launching.size).toBe(0);

    await start(false);
    const ok = startOne();
    await runs().reload();
    backend.runs.advance(ok.id);
    await runs().reload();
    expect(runs().launching.size).toBe(1);
    backend.runs.advance(ok.id);
    await runs().reload();
    expect(runs().launching.size).toBe(0);
  });
});

describe("the list never spins for good", () => {
  it("loads from scratch when the store lost its backend, as a hot reload leaves it", async () => {
    runs().dispose();
    expect(runs()).toMatchObject({ status: "idle", backend: null });
    runs().recover();
    expect(runs().status).toBe("loading");
    await settle();
    expect(runs().status).toBe("ready");
  });

  it("re-reads when it has a backend, and clears an error on the way", async () => {
    vi.spyOn(backend, "runsList").mockRejectedValueOnce(new Error("locked"));
    await runs().reload();
    expect(runs()).toMatchObject({ status: "error", error: "locked" });
    runs().recover();
    expect(runs()).toMatchObject({ status: "loading", error: null });
    await settle();
    expect(runs().status).toBe("ready");
  });

  it("ends in an error with a reason when the backend never answers, and recovers on Retry", async () => {
    vi.useFakeTimers();
    const list = vi.spyOn(backend, "runsList").mockReturnValueOnce(new Promise(() => {}));
    void runs().reload();
    await vi.advanceTimersByTimeAsync(LOAD_LIMIT_MS);
    expect(runs()).toMatchObject({ status: "error", error: "Reading your agents took too long." });
    runs().recover();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs().status).toBe("ready");
    list.mockRestore();
  });
});
