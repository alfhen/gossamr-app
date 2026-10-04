import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AskRequest } from "../backend/claude";
import { MockBackend } from "../backend/mock";
import { MANAGER_SEEDS, QUIET_VERDICT, managerReply, noticeText, parseNotice } from "../backend/mockManager";
import { mockAsk } from "../backend/mockPip";
import { ALL } from "../lib/filter";
import type { Proposal } from "../types";
import { itemManagerState, waitingCounts, waitingItems } from "./managerLogic";
import { DEFAULT_SETTINGS, useManager, type ManagerSettings } from "./managerProto";
import { LAST_STEP, STEPS, playStep, type ScenarioEnv } from "./managerScenario";

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) });
  useManager.getState().resetSettings();
  useManager.setState({ on: true });
});

const blank = { view: null, item: null, filter: null, selection: [] };

function world(over: Partial<ManagerSettings> = {}) {
  const backend = new MockBackend({ manager: true });
  const settings: ManagerSettings = { ...DEFAULT_SETTINGS, ...over };
  const said: string[] = [];
  const told: string[] = [];
  let seq = 0;
  const env: ScenarioEnv = {
    backend,
    settings: () => settings,
    turnOnReview: () => void (settings.reviewFinished = true),
    notify: async (prompt) => {
      told.push(prompt);
      await mockAsk({ requestId: `notice-${++seq}`, prompt, context: blank, sessionId: null, images: [] } satisfies AskRequest, backend, 0);
    },
    chat: async (text) => {
      await mockAsk({ requestId: `chat-${++seq}`, prompt: text, context: blank, sessionId: null, images: [] } satisfies AskRequest, backend, 0);
    },
    say: (text) => void said.push(text),
    show: () => {},
    pause: async () => {},
  };
  return { backend, env, settings, said, told };
}

const pending = (backend: MockBackend, type?: Proposal["intent"]["type"]) => backend.proposals.list({ states: ["pending"] }).filter((p) => !type || p.intent.type === type);
const run = async (backend: MockBackend, key: string) => (await backend.runsGet(backend.managerRun(key)!.id))!;
const play = async (env: ScenarioEnv, from: number, to: number) => {
  for (let n = from; n <= to; n++) await playStep(env, n);
};

describe("the Pip-as-manager sample world", () => {
  it("is off by default and leaves the ordinary sample data alone", async () => {
    expect(new MockBackend().managerRun("CA-271")?.state).not.toBe("working");
    expect(DEFAULT_SETTINGS).toMatchObject({ reviewFinished: false, autoSendBack: false, proposeFromChat: true });
  });

  it("starts with the five scripted runs working on the scripted tickets", async () => {
    const { backend } = world();
    const runs = await backend.runsList();
    expect(runs).toHaveLength(MANAGER_SEEDS.length);
    expect(runs.every((r) => r.state === "working")).toBe(true);
    const tickets = await backend.cacheSearch(ALL);
    for (const key of ["CA-271", "CA-401", "CA-355", "CA-388", "CA-412", "CA-420", "CA-409", "CA-433", "CA-396", "CA-440"]) expect(tickets.some((t) => t.item.key === key)).toBe(true);
  });

  it("has a caption for every step", () => {
    expect(STEPS).toHaveLength(LAST_STEP + 1);
  });
});

describe("a finished run, with Pip reviewing", () => {
  it("is announced by the app, and Pip answers with a comment and a breakdown", async () => {
    const { backend, env, told } = world({ reviewFinished: true });
    await play(env, 2, 2);
    expect(told[0]).toMatch(/^\[Gossamr notice\] Run \S+ finished\./);
    expect((await run(backend, "CA-271")).state).toBe("done");
    expect(pending(backend).map((p) => p.intent.type).sort()).toEqual(["comment", "subtasks"]);
    expect(pending(backend).every((p) => p.createdBy === "pip" && p.origin.type === "chat")).toBe(true);
    expect((await run(backend, "CA-271")).pip).toMatchObject({ kind: "drafted" });
  });

  it("corrects a comment whose note disagrees with the answer, and keeps what it said before", async () => {
    const { backend, env } = world({ reviewFinished: true });
    await play(env, 3, 3);
    const [draft] = pending(backend, "comment");
    expect(draft.revisions[0].was).toMatch(/499 DKK in config\/shipping\.ts/);
    expect(draft.revisions[0].note).toMatch(/Corrected before you saw it/);
    expect(JSON.stringify(draft.intent)).toMatch(/449 DKK/);
  });

  it("says nothing when there is nothing to do, and the run is marked checked", async () => {
    const { backend, env, told, said } = world({ reviewFinished: true });
    await play(env, 4, 4);
    expect(told).toHaveLength(0);
    expect(pending(backend)).toHaveLength(0);
    expect((await run(backend, "CA-355")).pip).toEqual(QUIET_VERDICT);
    expect(said[0]).toMatch(/nothing to do/);
  });

  it("asks the person when the run stopped on a question, without guessing", async () => {
    const { backend, env } = world({ reviewFinished: true });
    await play(env, 5, 5);
    const r = await run(backend, "CA-388");
    expect(r.state).toBe("needsAnswer");
    expect(r.needs).toMatch(/old endpoint/);
    expect(pending(backend)).toHaveLength(0);
    expect(r.pip?.kind).toBe("asked");
  });

  it("does nothing but finish the run when review is off, and the inbox lists it", async () => {
    const { backend, env, told } = world();
    await play(env, 2, 2);
    expect(told).toHaveLength(0);
    expect(pending(backend)).toHaveLength(0);
    const r = await run(backend, "CA-271");
    expect(waitingItems([], [r], new Set(), false)).toHaveLength(1);
    expect(waitingItems([], [r], new Set(), true)).toHaveLength(0);
  });
});

describe("a send-back", () => {
  it("is a draft with the exact message and the pass counter, and approving it returns the run to work", async () => {
    const { backend, env } = world({ reviewFinished: true });
    await play(env, 6, 6);
    const [draft] = pending(backend, "followUp");
    if (draft.intent.type !== "followUp") throw new Error("not a follow-up");
    expect(draft.intent).toMatchObject({ pass: 1, max: 2, reason: "fixed-amount coupons were not checked" });
    expect(draft.intent.message).toMatch(/test\/fixtures\/sandbox\.ts/);
    expect((await run(backend, "CA-412")).state).toBe("done");

    const approved = await backend.proposalsApprove(draft.id);
    expect(approved.state.type).toBe("applied");
    const again = await run(backend, "CA-412");
    expect(again.state).toBe("working");
    expect(again.passes).toBe(1);
  });

  it("puts the reason on the timeline, finishes again, and then drafts a comment instead of a second send-back", async () => {
    const { backend, env } = world({ reviewFinished: true });
    await play(env, 6, 7);
    const r = await run(backend, "CA-412");
    expect(r.state).toBe("done");
    expect(r.result).toMatch(/Fixed-amount coupons verified/);
    const events = await backend.runsEvents(r.id);
    expect(events.find((e) => e.kind === "pass")?.text).toBe("Pip asked for another pass: fixed-amount coupons were not checked");
    expect(events[events.length - 1].kind).toBe("pip");
    expect(pending(backend).map((p) => p.intent.type)).toEqual(expect.arrayContaining(["comment"]));
    expect(pending(backend, "followUp")).toHaveLength(0);
  });

  it("goes out by itself, with the pass counted, only when the person allowed it", async () => {
    const { backend, env } = world({ reviewFinished: true, autoSendBack: true, maxPasses: 2 });
    await play(env, 6, 6);
    const r = await run(backend, "CA-412");
    expect(r.state).toBe("working");
    expect(r.passes).toBe(1);
    expect(pending(backend, "followUp")).toHaveLength(0);
    expect((await backend.runsEvents(r.id)).some((e) => e.kind === "pass")).toBe(true);
  });

  it("never sends back past the cap", () => {
    const reply = managerReply({ runId: "r", key: "CA-412", passes: 2, max: 2, auto: true });
    expect(reply?.drafts.some((d) => d.intent.type === "followUp")).toBe(false);
  });
});

describe("Pip-first chat", () => {
  it("proposes an investigation with no ticket from a request in chat, and drafts a ticket when the run finishes", async () => {
    const { backend, env } = world({ reviewFinished: true });
    await play(env, 8, 8);
    const [start] = pending(backend, "startRun");
    if (start.intent.type !== "startRun") throw new Error("not a run");
    expect(start.intent.item).toBeNull();
    expect(start.intent.spec.repo).toBe("acme/webshop");
    expect(start.intent.spec.instruction).toMatch(/Stay read-only/);

    await play(env, 9, 9);
    expect(pending(backend, "startRun")).toHaveLength(0);
    const created = pending(backend, "create");
    expect(created).toHaveLength(1);
    expect(created[0].createdBy).toBe("pip");
  });

  it("does not propose a run when the switch is off", async () => {
    const { backend } = world({ proposeFromChat: false });
    useManager.getState().change({ proposeFromChat: false });
    await mockAsk({ requestId: "c", prompt: "look into why checkout rounding is wrong", context: blank, sessionId: null, images: [] }, backend, 0);
    expect(pending(backend, "startRun")).toHaveLength(0);
  });
});

describe("the notice", () => {
  it("carries the policy Pip has to follow, and reads back the same", () => {
    const text = noticeText({ id: "run-1", item: { connectionId: "mock", externalId: "CA-412", key: "CA-412" }, spec: { kind: "verify" } as never }, 1, { maxPasses: 3, autoSendBack: true }, "note");
    expect(parseNotice(text)).toEqual({ runId: "run-1", key: "CA-412", passes: 1, max: 3, auto: true });
    expect(parseNotice("What is blocked?")).toBeNull();
  });
});

describe("what is waiting", () => {
  it("counts drafts, answers and send-backs once, and badges the tickets they are on", async () => {
    const { backend, env } = world({ reviewFinished: true });
    await play(env, 2, 6);
    const proposals = backend.proposals.list();
    const runs = await backend.runsList();
    const items = waitingItems(proposals, runs, new Set(), true);
    expect(waitingCounts(items)).toMatchObject({ all: 5, drafts: 3, answers: 1, sendBacks: 1 });
    expect(itemManagerState("CA-271", proposals, runs)).toMatchObject({ needsYou: true, drafted: 2, checked: false });
    expect(itemManagerState("CA-355", proposals, runs)).toMatchObject({ needsYou: false, drafted: 0, checked: true });
  });
});
