import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelChoice, RunSpec } from "../types";
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

const CA401 = itemRef("CA-401");
const spec = (over: Partial<RunSpec> = {}): RunSpec => ({ role: "investigate", repo: "acme/storefront", clonePath: "/Users/sample/Gossamr/agents/acme/storefront", base: "main", name: `ca-401-${Math.random().toString(16).slice(2, 8)}`, brief: "", ticketBlock: null, ...over });
const pick = (model: string): ModelChoice => ({ instanceId: "claude", model });

describe("the mock's runs record the instance and model they run on", () => {
  it("gives a new run the Settings default for agents", () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    expect(backend.runs.start(spec(), CA401).runsOn).toEqual({ instanceId: "claude", model: "default" });
  });

  it("gives a run the choice of its workstream, and a run queued before the choice keeps its own", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const ws = await backend.workstreamsOpen(CA401);
    const before = backend.runs.start(spec({ workstream: ws.id }), CA401);
    const set = await backend.workstreamsSetModel(ws.id, pick("opus"));
    expect(set.agentsModel).toEqual(pick("opus"));
    const after = backend.runs.start(spec({ workstream: ws.id }), CA401);
    expect([before.runsOn, after.runsOn]).toEqual([pick("default"), pick("opus")]);

    expect((await backend.workstreamsSetModel(ws.id, null)).agentsModel).toBeUndefined();
    expect(backend.runs.start(spec({ workstream: ws.id }), CA401).runsOn).toEqual(pick("default"));
  });

  it("refuses a model the instance does not list for a workstream, and a closed workstream takes none", async () => {
    const backend = new MockBackend({ runs: { seed: "empty" } });
    const ws = await backend.workstreamsOpen(CA401);
    await expect(backend.workstreamsSetModel(ws.id, pick("gpt-9"))).rejects.toThrow("Pick a model for this run.");
    await backend.workstreamsClose(ws.id);
    await expect(backend.workstreamsSetModel(ws.id, pick("opus"))).rejects.toThrow(`workstream ${ws.id} is closed`);
  });

  it("changes a queued run's choice and clears what it waited for, and refuses once it has started", async () => {
    const backend = new MockBackend({ runs: { seed: "empty", cap: 1 } });
    const first = backend.runs.start(spec(), CA401);
    backend.runs.advance(first.id);
    const waiting = backend.runs.start(spec(), CA401);
    expect([backend.runs.get(first.id)?.state, waiting.state]).toEqual(["launching", "queued"]);
    const changed = await backend.runsSetModel(waiting.id, pick("haiku"));
    expect(changed.runsOn).toEqual(pick("haiku"));
    await expect(backend.runsSetModel(waiting.id, pick("gpt-9"))).rejects.toThrow("Pick a model for this run.");
    await expect(backend.runsSetModel(first.id, pick("opus"))).rejects.toThrow("This run is launching, so what it runs on can't change.");
  });

  it("refuses to remove the Claude that has agents running, and counts only those past the queue", async () => {
    const backend = new MockBackend({ runs: { seed: "empty", cap: 1 } });
    backend.runs.advance(backend.runs.start(spec(), CA401).id);
    backend.runs.start(spec(), CA401);
    await expect(backend.connectionRemove("claude")).rejects.toThrow("Stop its running agent first.");
  });
});
