import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSpec } from "../types";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";

const saved = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
  removeItem: (k: string) => void saved.delete(k),
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => saved.clear());

const spec = (over: Partial<RunSpec> = {}): RunSpec => ({ role: "investigate", repo: "acme/storefront", clonePath: "/Users/sample/Gossamr/agents/acme/storefront", base: "main", name: `ca-401-${Math.random().toString(16).slice(2, 8)}`, brief: "", ticketBlock: null, ...over });

function finish(backend: MockBackend, id: string) {
  for (let i = 0; i < 10 && backend.runs.get(id)!.state !== "done"; i++) backend.runs.advance(id);
  expect(backend.runs.get(id)!.state).toBe("done");
}

describe("the mock's queued runs wait for a login to be signed in", () => {
  it("keeps a run queued with the waiting words while its instance is signed out, and starts it once it is signed in", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" }, claudeProbe: "notSignedIn" });
    const run = backend.runs.start(spec(), itemRef("CA-401"));
    backend.runs.advance(run.id);
    expect(backend.runs.get(run.id)).toMatchObject({ state: "queued", waitReason: "Waits until Claude is signed in." });
    expect(backend.runs.launches()).toEqual([]);

    (backend as unknown as { providers: { setDefaultProbe(p: string): void } }).providers.setDefaultProbe("ready");
    backend.runs.advance(run.id);
    const started = backend.runs.get(run.id)!;
    expect(started.state).toBe("launching");
    expect(started.waitReason ?? null).toBeNull();
  });

  it("does not hold a run for an instance that is signed in", () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const run = backend.runs.start(spec(), itemRef("CA-401"));
    backend.runs.advance(run.id);
    expect(backend.runs.get(run.id)!.state).toBe("launching");
  });
});

describe("the mock's clean up of a run whose instance was removed", () => {
  it("says the session was left in that login's folder", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const added = await backend.providerAdd("claude", "Claude personal", "~/.claude-personal");
    const run = backend.runs.start(spec(), itemRef("CA-401"));
    backend.runs.setModel(run.id, { instanceId: added.id, model: "default" });
    finish(backend, run.id);
    await backend.connectionRemove(added.id);
    expect(backend.runs.cleanup(run.id)).toEqual({ type: "removed" });
    expect(backend.runs.get(run.id)).toMatchObject({ sessionsLeft: true });
  });

  it("leaves the flag off when the instance is still there", () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const run = backend.runs.start(spec(), itemRef("CA-401"));
    finish(backend, run.id);
    backend.runs.cleanup(run.id);
    expect(backend.runs.get(run.id)!.sessionsLeft).toBeUndefined();
  });
});
