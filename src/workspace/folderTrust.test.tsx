import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import type { Preflight } from "../types";
import { useWorkspace } from "../workspaceStore";
import { RunPreflight } from "./RunPreflight";
import { usePrefs } from "./prefs";
import { useRunSetup } from "./runSetupStore";
import { LOAD_LIMIT_MS, useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

const settle = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const setup = () => useRunSetup.getState();
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
  usePrefs.setState({ agentsIntroSeen: true });
  setup().close();
  await settle();
}

beforeEach(() => start());
afterEach(() => vi.useRealTimers());

const trustRow = () => setup().preflight?.rows.find((r) => r.action?.type === "trustFolder");

async function drafted() {
  await setup().begin({ item: CA });
  await setup().chooseRepo("acme/storefront");
}

describe("a folder Claude has not been opened in", () => {
  it("is an amber row with a Trust this folder step, and does not block Start", async () => {
    await drafted();
    expect(trustRow()).toMatchObject({ level: "amber", action: { type: "trustFolder", path: "/Users/sample/Code/storefront" } });
    expect(trustRow()?.text).toContain("hasn't been opened");
    expect(setup().preflight?.blocking).toBe(false);
  });

  it("opens Terminal there, and Check again clears the row once Claude was opened", async () => {
    await drafted();
    const spy = vi.spyOn(backend, "runsTrustPath");
    await setup().recheck();
    expect(trustRow()).toBeDefined();
    await setup().trustFolder("/Users/sample/Code/storefront");
    expect(spy).toHaveBeenCalledWith("/Users/sample/Code/storefront");
    expect(setup().trustOpened).toBe(true);
    await setup().recheck();
    expect(trustRow()).toBeUndefined();
    expect(setup().rechecking).toBe(false);
  });

  it("says so when Terminal could not be opened", async () => {
    await drafted();
    vi.spyOn(backend, "runsTrustPath").mockRejectedValueOnce(new Error("nope"));
    await setup().trustFolder("/Users/sample/Code/storefront");
    expect(useToasts.getState().toasts[0].text).toBe("Couldn't open Terminal: nope");
    expect(setup().trustOpened).toBe(false);
  });

  it("only opens Terminal where Gossamr looks for clones", async () => {
    await expect(backend.runsTrustPath("/etc")).rejects.toThrow(/isn't in a place/);
  });

  it("shows nothing in a folder that was trusted", async () => {
    await start(false);
    await drafted();
    expect(trustRow()).toBeUndefined();
  });

  it("renders the buttons beside the row, and Check again waits while it runs", () => {
    const preflight: Preflight = { blocking: false, rows: [{ level: "amber", text: "Claude hasn't been opened in /a yet: trust it once.", action: { type: "trustFolder", path: "/a" } }] };
    const steps = { trust: vi.fn(), recheck: vi.fn(), rechecking: false };
    const html = renderToStaticMarkup(<RunPreflight preflight={preflight} checking={false} steps={steps} />);
    expect(html).toContain("Trust this folder");
    expect(html).toContain("Check again");
    expect(renderToStaticMarkup(<RunPreflight preflight={preflight} checking={false} steps={{ ...steps, rechecking: true }} />)).toContain("Checking…");
    expect(renderToStaticMarkup(<RunPreflight preflight={preflight} checking={false} />)).not.toContain("Trust this folder");
  });
});

describe("starting in a folder Claude refuses", () => {
  it("announces the failure, opens the run with its way on, and Retry goes through once trusted", async () => {
    await drafted();
    const started = await setup().start();
    expect(started?.state).toBe("queued");
    expect(runs().launching.has(started!.id)).toBe(true);
    useToasts.getState().clear();
    await sleep(700);
    await settle();
    const run = runs().runs.find((r) => r.id === started!.id)!;
    expect(run).toMatchObject({ state: "failed", failure: { type: "untrustedFolder", path: "/Users/sample/Code/storefront" } });
    expect(runs().launching.size).toBe(0);
    expect(runs().sheet).toEqual({ type: "run", id: run.id });
    const toast = useToasts.getState().toasts.slice(-1)[0];
    expect(toast.text).toMatch(/^The agent on CA-401 didn't start\. Claude asks you once per folder/);
    expect(toast.action?.label).toBe("Fix it");

    await runs().fix(run.id, "terminal");
    await runs().retryLaunch(run.id);
    await settle();
    expect(runs().runs.find((r) => r.id === run.id)?.state).toBe("queued");
  });

  it("does not shuffle a sheet the person already has open, and stops watching a run that started", async () => {
    await drafted();
    const started = await setup().start();
    runs().openSafety();
    await sleep(700);
    await settle();
    expect(runs().sheet).toEqual({ type: "safety" });
    expect(runs().launching.size).toBe(0);

    await start(false);
    await drafted();
    const ok = await setup().start();
    backend.runs.advance(ok!.id);
    await settle();
    expect(runs().launching.size).toBe(1);
    backend.runs.advance(ok!.id);
    await settle();
    expect(runs().launching.size).toBe(0);
    expect(started).not.toBeNull();
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
